import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgyAgent,
  MINIMUM_DENY,
  agySettingsPath,
  selfProtectionDeny,
  readAgyDenies,
  missingAgyDenies,
} from '../drivers/agent.agy.js';
import { DriversSchema, type Repo, type TaskRow } from '../schemas.js';
import { p } from '../config.js';

vi.mock('execa');

/**
 * Part 5 — the in-driver enforcement of agy's deny set.
 *
 * agy has no `--deny-tool` flag (copilot) and no injected config (opencode): its
 * permissions live in a settings.json that only `scripts/agy-access.ps1 -Apply`
 * writes. The driver's job is to be the *enforcer* — before every unsandboxed run
 * it reads that file and refuses to run when the non-negotiable deny set is
 * missing. That is what the tests below pin down.
 *
 * The config schema, not the driver, is the source of the security defaults:
 * an omitted `sandbox` means ON, so production must write `sandbox: false`
 * explicitly to hand control to the allow-list. Tests 9-10 lock that in.
 */

const origDb = process.env.SHANAUTO_DB;
const origSettings = process.env.SHANAUTO_AGY_SETTINGS;

/** A settings.json with every mandatory deny rule present (the green case). */
function compliantDeny(): string[] {
  return [...MINIMUM_DENY, selfProtectionDeny()];
}

function writeSettings(deny: string[]): void {
  writeFileSync(
    join(tmp, 'settings.json'),
    JSON.stringify({ permissions: { allow: [], deny } }),
    'utf8',
  );
}

function makeTask(): TaskRow {
  return {
    id: 't1',
    milestone_id: null,
    repo: 'r1',
    title: 'Implement the thing',
    kind: 'feature',
    instruction: 'Implement exactly this one change in the workspace directory.',
    acceptance: 'The thing works.',
    files_hint: '[]',
    verify_cmd: 'npm test',
    depends_on: '[]',
    breaking: null,
    est_lines: 10,
    executor_hint: 'cli',
    status: 'ready',
    attempts: 0,
    last_error: null,
    commit_sha: null,
    brief: null,
    ord: 0,
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
  };
}

function makeRepo(): Repo {
  return {
    id: 'r1',
    path: tmp,
    branch: 'main',
    stack: 'unknown',
    verify_cmd: 'npm test',
    enabled: true,
    weight: 1,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agy-perm-'));
  process.env.SHANAUTO_DB = join(tmp, 'db.sqlite');
  process.env.SHANAUTO_AGY_SETTINGS = join(tmp, 'settings.json');
  vi.resetAllMocks();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (origDb === undefined) delete process.env.SHANAUTO_DB;
  else process.env.SHANAUTO_DB = origDb;
  if (origSettings === undefined) delete process.env.SHANAUTO_AGY_SETTINGS;
  else process.env.SHANAUTO_AGY_SETTINGS = origSettings;
});

describe('agySettingsPath', () => {
  it('honours the SHANAUTO_AGY_SETTINGS override', () => {
    expect(agySettingsPath()).toBe(join(tmp, 'settings.json'));
  });
});

describe('readAgyDenies', () => {
  it('returns null when the settings file is missing', () => {
    expect(readAgyDenies()).toBeNull();
  });

  it('returns null when the file is corrupt', () => {
    writeFileSync(join(tmp, 'settings.json'), '{ not json', 'utf8');
    expect(readAgyDenies()).toBeNull();
  });

  it('returns [] when the permissions.deny array is absent', () => {
    writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ model: 'x' }), 'utf8');
    expect(readAgyDenies()).toEqual([]);
  });

  it('returns the deny array when present', () => {
    writeSettings(['command(rm)', 'command(curl)']);
    expect(readAgyDenies()).toEqual(['command(rm)', 'command(curl)']);
  });
});

describe('missingAgyDenies', () => {
  it('fails closed on an unreadable file: every rule is missing', () => {
    const missing = missingAgyDenies(null);
    expect(missing).toHaveLength(MINIMUM_DENY.length + 1); // +1 for self-protection
    expect(missing).toContain(selfProtectionDeny());
  });

  it('reports nothing missing when the whole set is present', () => {
    expect(missingAgyDenies(compliantDeny())).toEqual([]);
  });

  it('names exactly the rules that are absent', () => {
    const present = [...MINIMUM_DENY, selfProtectionDeny()];
    const removed = present.splice(0, 2); // drop the first two
    const missing = missingAgyDenies(present);
    expect(missing).toEqual(removed);
  });
});

describe('config schema defaults (the driver no longer guesses)', () => {
  function parseAgy(extra?: Record<string, unknown>) {
    const entry = DriversSchema.parse({
      brain: { active: 'agy', registry: {} },
      chat: { active: 'x', enabled: false, registry: {} },
      agents: { registry: { agy: { module: './drivers/agent.agy.js', ...extra } } },
      routing: { default: 'opencode' },
    }).agents.registry.agy;
    if (!entry) throw new Error('agy entry did not parse');
    return entry;
  }

  it('defaults an omitted sandbox to true and skip_permissions/deny to the safe values', () => {
    const entry = parseAgy();
    expect(entry.sandbox).toBe(true);
    expect(entry.skip_permissions).toBe(false);
    expect(entry.deny).toEqual([]);
  });

  it('lets production write sandbox: false explicitly', () => {
    expect(parseAgy({ sandbox: false }).sandbox).toBe(false);
  });
});

describe('template contract: what scripts/agy-access.ps1 -Apply writes covers MINIMUM_DENY', () => {
  it('the example deny list contains every mandatory rule (stripped of _ comments)', () => {
    const raw = JSON.parse(readFileSync(p('config', 'agy-permissions.example.json'), 'utf8')) as {
      permissions: { deny: unknown[] };
    };
    const rules = (raw.permissions.deny as string[]).filter((s) => !s.startsWith('_'));
    for (const required of MINIMUM_DENY) {
      expect(rules).toContain(required);
    }
  });

  /*
   * Skipped, not silently passed, when there is no repos.yaml.
   *
   * This invariant is about the OPERATOR's config, and repos.yaml is gitignored
   * because it names paths on their own disk — so on a fresh clone the file does
   * not exist and `npm test` died here with ENOENT before a contributor had run
   * anything. The assertion below deliberately refuses an empty list, so the
   * honest answer to "no config" is to skip visibly rather than to loop over
   * nothing and report green.
   */
  it.skipIf(!existsSync(p('config', 'repos.yaml')))(
    'allow-lists the exact check command every enabled repo hands its agent',
    () => {
    /*
     * config/repos.yaml carries `agent_check_cmd` — the one command the agent may
     * run to see its own work. agy matches token-for-token, so if that string is
     * not in the template verbatim it is auto-denied, and a denial ends the run.
     *
     * repos.yaml asks the operator to keep the two files in step by hand. Nothing
     * enforced it, and hand-maintained cross-file invariants are exactly what
     * finding 6 turned out to be: the template had drifted 24 allow rules behind
     * the live settings, so -Apply would have removed rules that were working.
     *
     * The failure this prevents is silent in the worst way — the agent reports
     * "no file changes", which reads as a lazy model rather than a missing line
     * in a JSON file.
     */
    const repos = parse(readFileSync(p('config', 'repos.yaml'), 'utf8')) as {
      repos?: { id?: string; enabled?: boolean; agent_check_cmd?: string }[];
    };
    const allow = (
      JSON.parse(readFileSync(p('config', 'agy-permissions.example.json'), 'utf8')) as {
        permissions: { allow: string[] };
      }
    ).permissions.allow.filter((s) => !s.startsWith('_'));

    const checked = (repos.repos ?? []).filter((r) => r.enabled && r.agent_check_cmd);
    // A green assertion loop over an empty list proves nothing; this is the
    // guard that the config actually reached the test.
    expect(checked.length).toBeGreaterThan(0);
    for (const r of checked) {
      expect(allow, `repo ${r.id}: agent_check_cmd is not allow-listed`).toContain(
        `command(${r.agent_check_cmd})`,
      );
      }
    },
  );
});

describe('the script that grants shell access must not revoke it', () => {
  /*
   * `agy-access.ps1 -Apply` wrote settings.json through Set-Content -Encoding
   * UTF8 which, in Windows PowerShell 5.1, means UTF-8 WITH a BOM. agy parses
   * strictly, so a leading U+FEFF made the file invalid JSON and it loaded NO
   * permissions at all — auto-denying every command. The symptom is identical to
   * a missing allow-rule, which is exactly how it would have survived: the
   * script that grants shell access was silently revoking it. (Port of the fix
   * from cd721f8; the guard lives here so the -Encoding UTF8 line can never
   * quietly come back.)
   */
  it('writes UTF-8 without a byte-order mark', () => {
    const ps = readFileSync(p('scripts', 'agy-access.ps1'), 'utf8');
    expect(ps).toMatch(/UTF8Encoding\(\$false\)/);
    expect(ps).not.toMatch(/Set-Content -Path \$Path -Encoding UTF8/);
  });

  it('doctor refuses to call a corrupted permission file healthy', () => {
    const idx = readFileSync(p('src', 'index.ts'), 'utf8');
    expect(idx).toMatch(/byte-order mark/);
    expect(idx).toMatch(/0xef/);
  });
});

describe('AgyAgent.execute pre-flight', () => {
  it('refuses an UNSANDBOXED run when mandatory denies are missing, and never calls the agent', async () => {
    // No settings.json written -> readAgyDenies() is null -> fail closed.
    const agent = new AgyAgent({ bin: 'faux-agy', sandbox: false });
    const res = await agent.execute(makeTask(), makeRepo(), 300);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('AGY_PERMISSIONS');
    expect(res.durationMs).toBe(0);
    expect(res.stdout).toMatch(/agy-access\.ps1 -Apply/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('still runs SANDBOXED with a degraded deny list, but passes --sandbox', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 } as any);
    const agent = new AgyAgent({ bin: 'faux-agy', sandbox: true });
    const res = await agent.execute(makeTask(), makeRepo(), 300);

    expect(res.ok).toBe(true);
    expect(execa).toHaveBeenCalledTimes(1);
    const args = vi.mocked(execa).mock.calls[0]?.[1] as string[] | undefined;
    expect(args).toContain('--sandbox');
  });

  it('runs UNSANDBOXED without --sandbox when the deny set is complete', async () => {
    writeSettings(compliantDeny());
    vi.mocked(execa).mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 } as any);
    const agent = new AgyAgent({ bin: 'faux-agy', sandbox: false });
    const res = await agent.execute(makeTask(), makeRepo(), 300);

    expect(res.ok).toBe(true);
    expect(execa).toHaveBeenCalledTimes(1);
    const args = vi.mocked(execa).mock.calls[0]?.[1] as string[] | undefined;
    expect(args).not.toContain('--sandbox');
  });
});

describe('AgyAgent.healthCheck posture', () => {
  it('fails doctor over an unsandboxed agy whose denies have degraded', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '1.0.7', stderr: '', exitCode: 0 } as any);
    const agent = new AgyAgent({ bin: process.execPath, sandbox: false });
    const res = await agent.healthCheck();

    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/agy-access\.ps1 -Apply/);
  });

  it('stays green sandboxed (the sandbox itself denies), but notes the missing rules', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: '1.0.7', stderr: '', exitCode: 0 } as any);
    const agent = new AgyAgent({ bin: process.execPath, sandbox: true });
    const res = await agent.healthCheck();

    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/missing \d+ mandatory deny rule/);
  });

  it('passes cleanly when an unsandboxed deny set is complete', async () => {
    writeSettings(compliantDeny());
    vi.mocked(execa).mockResolvedValue({ stdout: '1.0.7', stderr: '', exitCode: 0 } as any);
    const agent = new AgyAgent({ bin: process.execPath, sandbox: false });
    const res = await agent.healthCheck();

    expect(res.ok).toBe(true);
    expect(res.detail).toBe('agy 1.0.7');
  });
});
