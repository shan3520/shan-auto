import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainDriver } from '../drivers/contracts.js';
import type { JournalStage } from '../core/journal.js';

/**
 * The whole bridge, on realistic input: journal written -> closed day ingested
 * -> the day answers a question asked later in different words.
 *
 * Every leg of that chain had unit coverage and the chain itself had none. The
 * first real journal — 57 KB for one day of example-api work — was still the open
 * day when `memory:ingest` ran, so it reported `+0 journal day(s)` and nothing
 * downstream had ever seen a day at real size. The synthetic four-entry day in
 * ingest-journal.test.ts cannot expose anything that only appears at 50 KB:
 * it fits inside a single 400-character snippet, so "the memory matched" and
 * "the answer was displayed" are indistinguishable there.
 *
 * So the fixture below is generated to the shape and scale of that real file —
 * ~40 tasks a day across several days, dispatch prompts, agent chatter, gate
 * verdicts and commit records — and the assertions run through the real
 * `appendEntry`, the real `ingestJournal` and the real `askMemory`.
 *
 * No provider call: the brain is a stub that records the prompt it was handed,
 * which is also the only way to check the thing that actually broke before —
 * whether the answer reached the model, not merely whether the day scored.
 */

const dbDir = mkdtempSync(join(tmpdir(), 'sa-jchain-db-'));
process.env.SHANAUTO_DB = join(dbDir, 'test.db');

const ledger = await import('../ledger.js');
const { appendEntry, journalPath } = await import('../core/journal.js');
const { ingestJournal, condenseDay } = await import('../core/ingest-docs.js');
const { buildContext, terms } = await import('../core/retrieve.js');
const { expandTerms } = await import('../core/aliases.js');
const { askMemory } = await import('../core/ask.js');

/* ------------------------------------------------------------------ fixture */

/**
 * Modelled on data/journal/2026-08-08.md: a FastAPI/SQLAlchemy build, one agent
 * handing over to another, most tasks committing and a minority rejected.
 *
 * Deliberately generated rather than checked in. A 250 KB fixture in the repo
 * would be read by nobody and reviewed by nobody; generated content keeps the
 * shape visible and lets a test state the scale it needs as an assertion.
 */
const TASKS = [
  {
    title: 'Create FastAPI app factory and Pydantic settings',
    instruction:
      'Create a Pydantic Settings class in app/core/config.py. Create app/main.py with a create_app() function that configures a FastAPI instance with OpenAPI docs, and instantiate `app = create_app()` at module level. Add a matching .env.example. Test the app initialization in tests/test_main.py.',
    acceptance:
      'create_app returns a FastAPI instance with OpenAPI docs configured, and settings load from environment variables.',
    files: '.env.example, app/core/config.py, app/main.py, tests/test_main.py',
  },
  {
    title: 'Setup SQLAlchemy models and in-memory SQLite test fixture',
    instruction:
      'Create `app/db/database.py` with SQLAlchemy `engine`, `SessionLocal`, and `Base`. Create `app/models.py` defining `User` and `ProviderKey` models. Create `tests/test_database.py` with a pytest fixture that provisions an in-memory SQLite database (`sqlite:///:memory:`) using `Base.metadata.create_all`, and write a test that adds and queries a `User`.',
    acceptance:
      'Pytest executes the database test verifying table creation and basic querying in an in-memory SQLite database.',
    files: 'app/db/database.py, app/models.py, tests/test_database.py',
  },
  {
    title: 'Add Document and Chunk models',
    instruction:
      'Create `Document` and `Chunk` SQLAlchemy models in `app/models/document.py` with a 1:N relationship (no vector columns). Export them in `app/models/__init__.py` so Alembic detects them, generate the Alembic migration, and write SQLite repository tests in `tests/repository/test_document.py` verifying foreign key and cascade behaviours.',
    acceptance:
      'Document and Chunk models are defined without vector columns, exported for Alembic, and pass SQLite tests for foreign key cascading.',
    files: 'app/models/__init__.py, app/models/document.py, tests/repository/test_document.py',
  },
  {
    title: 'Add Conversation and Message models',
    instruction:
      'Create `Conversation` and `Message` SQLAlchemy models in `app/models/chat.py` with a 1:N relationship. Export them in `app/models/__init__.py` for Alembic, generate the migration, and write SQLite tests in `tests/repository/test_chat.py` verifying relationships and cascade behaviours.',
    acceptance: 'Conversation and Message models are defined, exported, and pass SQLite repository tests.',
    files: 'app/models/__init__.py, app/models/chat.py, tests/repository/test_chat.py',
  },
  {
    title: 'Implement structured JSON logging',
    instruction:
      'Add `app/core/logging.py` configuring a JSON formatter over the stdlib logging module, wire it into create_app(), and assert in tests/test_logging.py that a request emits one parseable JSON line carrying the request id.',
    acceptance: 'Application logs are emitted as single-line JSON including a request identifier.',
    files: 'app/core/logging.py, app/main.py, tests/test_logging.py',
  },
  {
    title: 'Implement ProviderKey model, encryption, and create endpoint',
    instruction:
      'Add `app/services/provider_key.py` encrypting the secret at rest with Fernet, a POST /provider-keys endpoint in app/api/provider_keys.py, and tests covering round-trip encryption plus rejection of a blank secret.',
    acceptance: 'A provider key can be created, is stored encrypted, and is never returned in plaintext.',
    files: 'app/models/provider_key.py, app/services/provider_key.py, app/api/provider_keys.py, tests/api/test_provider_keys.py',
  },
  {
    title: 'Add provider key validation with mock HTTP tests',
    instruction:
      'Add `app/services/provider_validation.py` that calls the upstream model list endpoint to confirm a key works, and test it against a mocked transport so the suite makes no network call.',
    acceptance: 'Provider keys are validated against the upstream API, with the transport mocked in tests.',
    files: 'app/services/provider_validation.py, app/api/provider_keys.py, tests/services/test_provider_validation.py',
  },
  {
    title: 'Initialize Alembic and generate initial migration script',
    instruction:
      'Run `alembic init alembic`, point env.py at app.db.database.Base, and generate revision 0001 covering the models defined so far. Add tests/test_migrations.py running `upgrade head` against a temporary SQLite file.',
    acceptance: 'Alembic upgrade to head succeeds from an empty database and creates every declared table.',
    files: 'alembic.ini, alembic/env.py, alembic/versions/0001_initial.py, tests/test_migrations.py',
  },
  {
    title: 'Implement auth endpoints and user dependency',
    instruction:
      'Add POST /auth/register and POST /auth/login issuing a JWT, plus a `current_user` FastAPI dependency that rejects a missing or expired token with 401. Cover both paths in tests/test_auth.py.',
    acceptance: 'Registration and login return a usable token, and protected routes reject an absent token with 401.',
    files: 'app/api/auth.py, app/core/security.py, app/main.py, tests/test_auth.py',
  },
  {
    title: 'Implement ProviderKey listing (masked) and deletion endpoints',
    instruction:
      'Add GET /provider-keys returning the last four characters only, and DELETE /provider-keys/{id} scoped to the owning user. A key belonging to another user must produce 404, not 403.',
    acceptance: 'Listing masks the secret and deletion is scoped to the owner.',
    files: 'app/api/provider_keys.py, app/services/provider_key.py, tests/api/test_provider_keys.py',
  },
  {
    title: 'Add clean architecture health endpoint',
    instruction:
      'Add a GET /health endpoint delegating to app/core/health.py so the transport layer holds no logic, and assert the payload reports database reachability.',
    acceptance: 'GET /health returns 200 with a body reporting database reachability.',
    files: 'app/api/health.py, app/core/health.py, app/main.py, tests/test_health.py',
  },
  {
    title: 'Add TelemetryEvent and UserSettings models',
    instruction:
      'Create `TelemetryEvent` and `UserSettings` in `app/models/telemetry.py`, export them for Alembic, generate the migration, and cover the default-settings row in tests/repository/test_telemetry.py.',
    acceptance: 'Both models are declared, exported, migrated and covered by repository tests.',
    files: 'app/models/__init__.py, app/models/telemetry.py, tests/repository/test_telemetry.py',
  },
  {
    title: 'Relocate main.py to app/main.py',
    instruction:
      'Move `src/main.py` to `app/main.py`. Update any imports referencing `src.main` (e.g. `from src.main import create_app`) to use `app.main` across all affected test files.',
    acceptance: 'The application entrypoint is moved to app/main.py and all test files use the new import path.',
    files: 'app/main.py, tests/test_auth.py, tests/test_health.py, tests/test_main.py',
  },
  {
    title: 'Remove legacy src directory and final src imports',
    instruction:
      'Delete `src/__init__.py` and remove any now-empty directories in the `src/` tree. Search the codebase for remaining imports from `src.` and update them to the new `app.` structure.',
    acceptance: 'The src directory is fully removed and no file in the project imports from the src package.',
    files: 'app/api/health.py, app/core/health.py',
  },
] as const;

/** Agent replies, at the length the real ones run to. Cycled, not randomised. */
const CHATTER = [
  "I'll start by reading the existing module so the change stays consistent with what is already there.\nChecking which of the referenced files exist before writing anything.\nThe package marker is present, so the import path resolves. Creating the new module now and wiring it into the app factory.\nRunning the targeted test file rather than the whole suite, to keep the loop short.",
  'Looking at the current layout first. Two of the four files already exist, so this is an edit rather than a create.\nUpdating the imports, then adding the new test.\nThe first run failed on a missing fixture; adding it to conftest.py and re-running.\nVerification: ran python -m pytest -q on the touched paths, 6 passed.',
  'Reading the models package to see what is already exported.\nAdding the declarations, then exporting them so autogenerate can see them.\nGenerated the revision and inspected it by hand — the upgrade body is not empty, which is what the acceptance asks for.\nRan the migration test against a temporary file database and it upgraded to head cleanly.',
  'Done. Changes:\n- Added the new module with the behaviour described.\n- Updated the app factory to register it.\n- Added tests covering the success path and the rejection path.\nVerification: ran python -m pytest tests -q, 16 passed.\nIf no further changes are wanted, finished.',
  'This one needed a little more care than it looked. The obvious edit would have duplicated logic that already lives in the service layer, so I called through to it instead of reimplementing.\nAdded the endpoint, kept the transport thin, and asserted the error shape as well as the happy path.\nRan the suite for the touched package: 9 passed, 0 failed.',
  'First I checked whether the work was already present, since the title overlaps with an earlier task.\nIt is not: the module exists but the function described does not.\nImplemented it, exported it, and added the test.\nRan pytest on the affected directory and it passed. No other files needed changing.',
] as const;

const PYTEST_FAILURE = `============================= test session starts =============================
platform win32 -- Python 3.11.9, pytest-8.3.3, pluggy-1.5.0
rootdir: D:\\repos\\example-api
plugins: anyio-4.12.1, langsmith-0.3.32
collected 12 items / 1 error

=================================== ERRORS ====================================
ERROR tests/repository/test_document.py - ModuleNotFoundError: No module named 'app.db'
=========================== short test summary info ===========================
ERROR tests/repository/test_document.py
============================== 1 error in 0.41s ===============================`;

/**
 * The fact this whole file exists to chase: recorded once, deep inside a big
 * day, in a gate verdict nobody would think to look for a year later.
 *
 * `pgvector` and `windows` appear NOWHERE else in the fixture, so a snippet
 * that does not contain them is a snippet taken from the wrong part of the day.
 */
const BURIED = `REJECTED VERIFY_FAIL: every embedding test errored during collection because the psycopg wheel is linux-only. The agent fell back to building it from source, which needs pg_config on PATH; that call was auto-denied, since headless mode cannot prompt for the "command" permission. Recorded so the next attempt does not rediscover it: pgvector cannot be gated on this windows box, and the suite has to fall back to sqlite-vss.
(no attempts left)`;

const BURIED_TITLE = 'Enable pgvector similarity search on Chunk';

interface Beat {
  stage: JournalStage;
  taskId: string;
  agent: string;
  title: string;
  detail: string;
}

/** A day's worth of beats. Same input always produces the same bytes. */
function dayBeats(dayIndex: number, opts: { bury: boolean }): Beat[] {
  const beats: Beat[] = [];
  const id = (n: number) => `T${(dayIndex * 97 + n * 7).toString(36).padStart(4, '0')}zhm${n % 10}`;

  for (let n = 0; n < 40; n++) {
    const t = TASKS[(dayIndex * 3 + n) % TASKS.length]!;
    const agent = n < 22 ? 'agy' : 'copilot';
    const taskId = id(n);
    const base = { taskId, agent, title: t.title };

    beats.push({ ...base, stage: 'dispatch', detail: `${t.instruction}\n\nACCEPTANCE: ${t.acceptance}` });
    beats.push({
      ...base,
      stage: 'result',
      detail: `${CHATTER[(dayIndex + n) % CHATTER.length]}\n\n— ok in ${40 + ((n * 13) % 80)}s · full output: D:\\repos\\shanauto\\data\\artifacts\\R${dayIndex}f7kq${n}\\17861${n}0000-agent-${agent}-${taskId}.md`,
    });

    if (n % 7 === 3) {
      beats.push({
        ...base,
        stage: 'gate',
        detail: `REJECTED VERIFY_FAIL: ${PYTEST_FAILURE}\n${n % 14 === 3 ? '(will retry)' : '(no attempts left)'}`,
      });
    } else if (n % 11 === 5) {
      beats.push({ ...base, stage: 'drop', detail: 'agent found the work already present and changed nothing' });
    } else {
      beats.push({
        ...base,
        stage: 'commit',
        detail: `committed ${(dayIndex * 7919 + n * 104729).toString(16).padStart(8, '0').slice(0, 8)} — ${1 + (n % 6)} file(s), +${20 + ((n * 17) % 140)}/-${n % 9}\nfiles: ${t.files}`,
      });
    }
  }

  if (opts.bury) {
    // Three quarters of the way in. Near the top would prove nothing: the bug
    // this guards showed the first 400 characters of a day that scored highly.
    const at = Math.floor(beats.length * 0.75);
    beats.splice(at, 0, {
      stage: 'gate',
      taskId: id(97),
      agent: 'agy',
      title: BURIED_TITLE,
      detail: BURIED,
    });
  }
  return beats;
}

/** Write a day through the real `appendEntry`, so the format is not re-implemented here. */
function writeDay(dir: string, day: string, dayIndex: number, opts: { bury: boolean }): void {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  let minute = 15;
  for (const b of dayBeats(dayIndex, opts)) {
    appendEntry(
      { repo: 'example-api', ...b, at: new Date(y, m - 1, d, Math.floor(minute / 60), minute % 60) },
      dir,
    );
    minute += 2;
  }
}

const DAYS = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
const BURIED_DAY = '2026-08-05';
/** 7 Aug, so every day above is closed and the 7th is the open one. */
const NOW = new Date(2026, 7, 7, 9, 0);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-jchain-'));
  DAYS.forEach((day, i) => writeDay(dir, day, i, { bury: day === BURIED_DAY }));
  // The open day, which must never be ingested.
  writeDay(dir, '2026-08-07', 9, { bury: false });
});

beforeEach(() => {
  ledger.open().exec('DELETE FROM resolutions; DELETE FROM memory_rollups;');
});

afterAll(() => {
  ledger.closeForTest();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

function readFixture(day: string): string {
  return readFileSync(journalPath(day, dir), 'utf8');
}

/** Records the prompt instead of spending a request. */
function fakeBrain(calls: { n: number; prompts: string[] }): BrainDriver {
  return {
    id: 'fake',
    init: async () => undefined,
    ask: (async (text: string) => {
      calls.n++;
      calls.prompts.push(text);
      return { answer: 'an answer' };
    }) as BrainDriver['ask'],
    dispose: async () => undefined,
  };
}

/* -------------------------------------------------------------------- tests */

describe('the fixture is the size and shape the real journal is', () => {
  it('writes tens of KB per day, as one real day did', () => {
    for (const day of DAYS) {
      // The real first journal was 57 KB. Below ~30 KB a day fits in too few
      // snippets for any of the depth assertions below to mean anything.
      expect(statSync(journalPath(day, dir)).size).toBeGreaterThan(30_000);
    }
  });

  it('buries the recorded fact deep in the day, not near the top', () => {
    const body = condenseDay(readFixture(BURIED_DAY));
    const at = body.indexOf('pgvector');
    expect(at).toBeGreaterThan(0);
    expect(at / body.length).toBeGreaterThan(0.6);
  });

  it('never uses the words the later question will be phrased with', () => {
    // Guards the alias test below from a fixture edit that accidentally makes
    // the match literal — at which point it would pass while proving nothing.
    const all = DAYS.map(readFixture).join('\n').toLowerCase();
    for (const word of ['antigravity', 'subprocess', 'allowlist']) {
      expect(all).not.toContain(word);
    }
  });
});

describe('journal -> memory -> retrieval', () => {
  it('files every closed day and leaves the open one alone', () => {
    const r = ingestJournal('example-api', dir, NOW);
    expect(r.ingested).toBe(DAYS.length);
    const stored = ledger.resolutionsByKind('example-api', ['journal'], 100);
    expect(stored.map((s) => s.occurred_at?.slice(0, 10)).sort()).toEqual(DAYS);
  });

  it('stores each day whole, so nothing deep in it is lost on the way in', () => {
    ingestJournal('example-api', dir, NOW);
    const row = ledger
      .resolutionsByKind('example-api', ['journal'], 100)
      .find((r) => r.occurred_at?.startsWith(BURIED_DAY))!;
    expect(row.reason!.length).toBeGreaterThan(30_000);
    expect(row.reason).toContain('sqlite-vss');
  });

  it('answers a question about something recorded deep inside a large day', () => {
    /*
     * The regression this exists for: a 128 KB memory scored highly and then
     * displayed the wrong 400 characters, so the retrieved text never contained
     * the answer. Scoring the day is not enough — the snippet has to land on it.
     */
    ingestJournal('example-api', dir, NOW);
    const memories = ledger.resolutionsByKind('example-api', ['journal'], 100);

    const ctx = buildContext('why was pgvector never verified on this windows box?', memories, [], NOW);

    expect(ctx.candidates).toBeGreaterThan(0);
    expect(ctx.text).toContain('pgvector');
    expect(ctx.text).toContain('sqlite-vss');
  });

  it('reaches the day through a synonym the journal never used', () => {
    ingestJournal('example-api', dir, NOW);
    const memories = ledger.resolutionsByKind('example-api', ['journal'], 100);
    const q = 'was antigravity ever refused a subprocess by the allowlist?';

    // Nothing the question names appears in the text; only expansion connects
    // 'antigravity'->'agy', 'subprocess'->'command', 'allowlist'->'permission'.
    expect(expandTerms(terms(q)).map((t) => t.term)).toEqual(
      expect.arrayContaining(['agy', 'command', 'permission']),
    );
    const ctx = buildContext(q, memories, [], NOW);
    expect(ctx.candidates).toBeGreaterThan(0);
    expect(ctx.text).toContain('journal:');

    // Same shape, no alias path: absent words stay absent.
    expect(buildContext('kubernetes helm chart rollout', memories, [], NOW).candidates).toBe(0);
  });
});

describe('the day reaches the model', () => {
  it('puts the buried gate verdict in front of the brain, in one call', async () => {
    ingestJournal('example-api', dir, NOW);
    const calls = { n: 0, prompts: [] as string[] };

    await askMemory('example-api', 'why was pgvector never verified on this windows box?', fakeBrain(calls), NOW);

    expect(calls.n).toBe(1);
    expect(calls.prompts[0]).toContain('sqlite-vss');
  });

  /*
   * `askMemory` used to pick journal days out of `recentResolutions(repo, 3000)`
   * alongside every commit. One journal day per day of work against roughly
   * sixty commits means the cap is reached in under two months, after which the
   * oldest days silently stop being retrievable — the same accident-of-insertion
   * -order failure the reasoning pool already exists to prevent for decisions.
   */
  it('still finds the day once the store has more commits than the recent window holds', async () => {
    ingestJournal('example-api', dir, NOW);
    for (let i = 0; i < 3200; i++) {
      ledger.remember({
        repo: 'example-api',
        kind: 'external_commit',
        reason: `chore: routine dependency bump ${i}`,
        occurred_at: `2026-08-06T10:00:00.000Z`,
      });
    }
    const calls = { n: 0, prompts: [] as string[] };

    await askMemory('example-api', 'why was pgvector never verified on this windows box?', fakeBrain(calls), NOW);

    expect(calls.n).toBe(1);
    expect(calls.prompts[0]).toContain('sqlite-vss');
  });
});

describe('boundaries', () => {
  it('re-ingesting adds nothing and changes nothing', () => {
    expect(ingestJournal('example-api', dir, NOW).ingested).toBe(DAYS.length);
    const before = ledger.resolutionsByKind('example-api', ['journal'], 100).map((r) => r.id);

    const again = ingestJournal('example-api', dir, NOW);

    expect(again.ingested).toBe(0);
    expect(ledger.resolutionsByKind('example-api', ['journal'], 100).map((r) => r.id)).toEqual(before);
  });

  it('skips the open day even when it is the biggest file there', () => {
    const r = ingestJournal('example-api', dir, NOW);
    expect(r.skipped).toBe(1);
    expect(ledger.resolutionsByKind('example-api', ['journal'], 100)).toHaveLength(DAYS.length);
  });

  it('skips a day that recorded nothing worth keeping', () => {
    writeFileSync(journalPath('2026-08-02', dir), '# Work journal — 2026-08-02\n', 'utf8');
    try {
      ingestJournal('example-api', dir, NOW);
      const days = ledger
        .resolutionsByKind('example-api', ['journal'], 100)
        .map((r) => r.occurred_at?.slice(0, 10));
      expect(days).not.toContain('2026-08-02');
    } finally {
      rmSync(journalPath('2026-08-02', dir), { force: true });
    }
  });

});

describe('condenseDay strips the day title and nothing else', () => {
  /*
   * It dropped EVERY line beginning with "# ", meaning to remove only the day
   * title. Agent replies carry their own markdown: the first real journal
   * already contains "## Changes Made" and "## Test Results" inside result
   * entries, and only luck made those H2 rather than H1. An agent writing
   * "# Summary" had that line deleted from the permanent record — silently,
   * since the archive under data/artifacts/ keeps a copy nobody rereads.
   */
  const DAY = `# Work journal — 2026-08-01
### 09:00 · T-x · result → agy · example-api · Enable similarity search
# Summary
The psycopg wheel is linux-only.
## Changes Made
none
`;

  it('keeps a heading the agent wrote itself', () => {
    const out = condenseDay(DAY);
    expect(out).toContain('# Summary');
    expect(out).toContain('## Changes Made');
  });

  it('still removes the title, which the caller re-adds as the headline', () => {
    expect(condenseDay(DAY)).not.toContain('Work journal');
    expect(condenseDay(DAY).startsWith('###')).toBe(true);
  });
});
