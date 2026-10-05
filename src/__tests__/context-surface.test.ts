/*
 * apiSurface against a real repo on disk — real files, real `git ls-files`, no
 * mocks. What broke here was extraction and budgeting, and both are invisible
 * to a mocked git.
 *
 * The defect these cover: 34 tasks in the ledger were dropped as already-done,
 * 27 of them in the TypeScript repo, because the surface handed to the planner
 * omitted the files that proved the work existed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { apiSurface } from '../core/context.js';
import type { Repo } from '../schemas.js';

const FILES: Record<string, string> = {
  'src/util.ts': [
    'export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }',
    'export const VERSION = "1.0.0";',
    'export interface Options { retries: number }',
  ].join('\n'),

  // The file the whole fix is about: declares nothing, tests plenty.
  'src/util.test.ts': [
    'import { describe, it } from "vitest";',
    'describe("sleep", () => {',
    '  it("resolves after the given delay", () => {});',
    '  it.each([1, 2])("handles %i", () => {});',
    '});',
    'test("VERSION is semver", () => {});',
  ].join('\n'),

  // Recognised source, nothing extractable — must still be listed.
  'src/boot.ts': 'import "./util.js";\nconsole.log("started");\n',

  // Python already worked, because `def test_x` matches its ordinary `def`.
  'tests/test_thing.py': 'def test_alpha():\n    pass\n\nclass Fixture:\n    pass\n',

  /*
   * Handler names that say nothing about the paths they answer on — the case
   * that cost a run on 2026-08-21. A surface listing only `api_dead_documents`
   * cannot tell a planner that the path is already served, so it plans it
   * again; and a reviewer cannot tell that a new route duplicates an old one.
   *
   * The stacked pair is real too: an intern hedging between two spellings
   * registered both, and the surface has to show both.
   */
  'app/api/stats.py': [
    'from fastapi import APIRouter, Depends',
    '',
    'router = APIRouter(tags=["stats"])',
    '',
    '@router.get("/api/stats/popular-documents")',
    'def api_popular_documents(user=Depends(get_current_user)):',
    '    return []',
    '',
    '@router.post("/api/stats/recompute")',
    'def api_recompute():',
    '    return {}',
    '',
    '@router.get("/dead-documents")',
    '@router.get("/stats/dead-documents")',
    'def api_dead_documents(days: int = 30):',
    '    return []',
    '',
    '# Neither of these is a route, and neither may be read as one. The first',
    '# is undotted; the second is dotted and takes a string, and is the one',
    '# that would slip through if the method list were ever widened.',
    '@validator("headline")',
    'def check_headline(cls, v):',
    '    return v',
    '',
    '@app.on_event("startup")',
    'def warm_cache():',
    '    return None',
  ].join('\n'),

  'src/a.ts': 'export function alpha() {}',
  'src/b.ts': 'export function bravo() {}',
  'src/c.ts': 'export function charlie() {}',
  'src/deep/nested/d.ts': 'export function delta() {}',

  // Not source, and never claimed to be.
  'README.md': '# fixture\n',
  'package.json': '{}\n',
};

let repo: Repo;
let dir: string;

/** The paths apiSurface is expected to know about, in `git ls-files` order. */
const SOURCE = Object.keys(FILES)
  .filter((f) => /\.(ts|py)$/.test(f))
  .sort();

/** Every entry's path, whether it carries detail or not. */
const paths = (surface: string) =>
  surface
    .split('\n')
    .filter((l) => !l.startsWith('...'))
    .map((l) => l.split(': ')[0]!);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shanauto-surface-'));
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const git = simpleGit({ baseDir: dir });
  await git.init();
  await git.add('.');
  repo = { id: 'fixture', path: dir, branch: 'main' } as Repo;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A throwaway repo of its own, for the cases that need a controlled file list.
 *
 * The shared fixture above is tuned: three budgeting tests depend on how much
 * its paths cost, so adding a file to it to test something unrelated moves
 * assertions that have nothing to do with the change.
 */
async function withRepo<T>(files: Record<string, string>, fn: (r: Repo) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'shanauto-surface-case-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(scratch, rel)), { recursive: true });
      writeFileSync(join(scratch, rel), body);
    }
    const git = simpleGit({ baseDir: scratch });
    await git.init();
    await git.add('.');
    return await fn({ id: 'case', path: scratch, branch: 'main' } as Repo);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('apiSurface extraction', () => {
  it('describes a TypeScript test file by the titles it declares', async () => {
    const surface = await apiSurface(repo);
    const entry = surface.split('\n').find((l) => l.startsWith('src/util.test.ts'));

    // Before the fix this file produced no names and was skipped entirely, so
    // the planner would happily propose "add tests for sleep".
    expect(entry, 'the test file is missing from the surface').toBeDefined();
    expect(entry).toContain('resolves after the given delay');
    expect(entry).toContain('sleep');
  });

  it('picks up it.each and bare test() as well as describe/it', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('src/util.test.ts'))!;
    expect(entry).toContain('handles %i');
    expect(entry).toContain('VERSION is semver');
  });

  it('still lists the exports of an ordinary source file', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('src/util.ts:'))!;
    for (const name of ['sleep', 'VERSION', 'Options']) expect(entry).toContain(name);
  });

  it('lists a source file that declares nothing, by path alone', async () => {
    const lines = (await apiSurface(repo)).split('\n');
    // Bare path, no colon-detail — but present, which is the whole point.
    expect(lines).toContain('src/boot.ts');
  });

  it('leaves Python extraction alone', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('tests/test_thing.py'))!;
    expect(entry).toContain('test_alpha');
    expect(entry).toContain('Fixture');
  });

  it('names the routes a Python file answers on, not just its handlers', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('app/api/stats.py'))!;

    // The whole point: a planner reading this can tell the path is taken.
    // Handler names alone ("api_popular_documents") could not.
    expect(entry).toContain('/api/stats/popular-documents');
    expect(entry).toContain('/api/stats/recompute');
    expect(entry).toContain('api_popular_documents');
  });

  it('shows both paths when one handler is registered twice', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('app/api/stats.py'))!;
    // The alias is exactly the duplication a reviewer has to be able to see.
    expect(entry).toContain('/dead-documents');
    expect(entry).toContain('/stats/dead-documents');
  });

  it('reads only HTTP-method decorators, not every decorator with a string', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('app/api/stats.py'))!;
    const names = entry.split(': ')[1]!.split(', ');
    // Compared by exact name: `check_headline` contains "headline" as a
    // substring, so `toContain` on the whole line would pass either way.
    expect(names).not.toContain('headline'); // undotted decorator
    expect(names).not.toContain('startup'); // dotted, but not an HTTP method
    expect(names).toContain('check_headline');
    expect(names).toContain('warm_cache');
  });

  it('puts the routes first, then the models, then the handler names', async () => {
    const entry = (await apiSurface(repo)).split('\n').find((l) => l.startsWith('app/api/stats.py'))!;
    const names = entry.split(': ')[1]!.split(', ');
    const at = (n: string) => names.indexOf(n);

    /*
     * Order is what survives a trim, and the trim cuts from the end. Before
     * this, `def` matched first and routes were appended last, so the paths
     * were the first thing lost on any file big enough to be worth reading.
     */
    expect(at('/api/stats/popular-documents')).toBeLessThan(at('api_popular_documents'));
    expect(at('/api/stats/recompute')).toBeLessThan(at('api_recompute'));
  });

  it('spends a short budget on the routes rather than the handler names', async () => {
    // Room for roughly half of what this file declares. Which half is the point.
    const surface = await withRepo(
      { 'api.py': FILES['app/api/stats.py']! },
      (r) => apiSurface(r, 130),
    );
    expect(surface).toContain('/api/stats/popular-documents');
    expect(surface).not.toContain('api_popular_documents');
    expect(surface).toMatch(/\+\d+ more$/m);
  });

  it('mounts routes under the prefix their router was built with', async () => {
    /*
     * The decorator carries only the tail. example-api's unanswered_queries.py is
     * exactly this shape, and the surface advertised `/recent` and `/frequent`
     * — paths that 404. A fragment leaves a planner uncertain; a wrong path
     * leaves it confident.
     */
    const surface = await withRepo(
      {
        'api.py': [
          'router = APIRouter(prefix="/api/unanswered-queries", tags=["q"])',
          '',
          '@router.get("/recent")',
          'def get_recent_queries():',
          '    return []',
          '',
          '@router.post("/clusters/{cluster_id}/handled")',
          'def mark_handled(cluster_id: int):',
          '    return {}',
        ].join('\n'),
      },
      (r) => apiSurface(r),
    );

    expect(surface).toContain('/api/unanswered-queries/recent');
    expect(surface).toContain('/api/unanswered-queries/clusters/{cluster_id}/handled');
    expect(surface).not.toContain(' /recent'); // never the bare tail as well
  });

  it('leaves the tail alone when the file gives no single answer', async () => {
    // Two routers, one prefixed: nothing in the file says which decorator
    // belongs to which, and a guess would be wrong half the time.
    const surface = await withRepo(
      {
        // The prefixed router is declared FIRST, so a rule that took whichever
        // prefix it found first would mount /health under /admin.
        'api.py': [
          'admin = APIRouter(prefix="/admin")',
          'public = APIRouter()',
          '',
          '@public.get("/health")',
          'def health():',
          '    return {}',
        ].join('\n'),
      },
      (r) => apiSurface(r),
    );

    expect(surface).toContain('/health');
    expect(surface).not.toContain('/admin/health');
  });

  it('does not double the slash when a router serves its own root', async () => {
    const surface = await withRepo(
      {
        'api.py': ['r = APIRouter(prefix="/api/items")', '', '@r.get("/")', 'def index():', '    return []'].join('\n'),
      },
      (r) => apiSurface(r),
    );
    expect(surface).toContain('/api/items');
    expect(surface).not.toContain('/api/items/,');
  });

  it('does not double the slash when the prefix is written with one', async () => {
    const surface = await withRepo(
      {
        'api.py': [
          'r = APIRouter(prefix="/api/items/")',
          '',
          '@r.get("/recent")',
          'def recent():',
          '    return []',
        ].join('\n'),
      },
      (r) => apiSurface(r),
    );
    expect(surface).toContain('/api/items/recent');
    expect(surface).not.toContain('//recent');
  });

  it('ignores files in no recognised language', async () => {
    expect(paths(await apiSurface(repo))).toEqual(expect.arrayContaining(SOURCE));
    expect(paths(await apiSurface(repo))).not.toContain('README.md');
  });
});

describe('apiSurface budgeting', () => {
  it('lists every file even when there is only room for a few descriptions', async () => {
    // Enough for all the paths and almost no detail. The old code spent the
    // budget on whatever sorted first and dropped the rest of the repo.
    const surface = await apiSurface(repo, 260);
    expect(paths(surface)).toEqual(expect.arrayContaining(SOURCE));
    expect(surface).not.toContain('omitted');
  });

  it('rations detail rather than starving the files that sort last', async () => {
    const surface = await apiSurface(repo, 400);
    const described = surface.split('\n').filter((l) => l.includes(': '));
    // src/util.test.ts sorts before src/util.ts and, uncapped, is by far the
    // longest entry. Under the old spend-until-empty loop it took everything.
    expect(described.length).toBeGreaterThan(1);
    expect(surface.split('\n').find((l) => l.startsWith('src/util.ts:'))).toContain('sleep');
  });

  it('says how many names it left out instead of implying that is all of them', async () => {
    const at = async (budget: number) =>
      (await apiSurface(repo, budget)).split('\n').find((l) => l.startsWith('src/util.test.ts'))!;

    const full = (await at(20_000)).split(': ')[1]!.split(', ');
    const tight = await at(260);

    expect(tight).toMatch(/\+\d+ more$/);
    const kept = tight.split(': ')[1]!.split(', ').slice(0, -1);
    expect(kept.length + Number(tight.match(/\+(\d+) more$/)![1])).toBe(full.length);
  });

  it('never exceeds the budget it was given', async () => {
    for (const budget of [80, 150, 260, 400, 1000, 4000]) {
      expect((await apiSurface(repo, budget)).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it('counts the files it truly cannot fit, and drops them from the end', async () => {
    // Not even the paths fit at 80 chars.
    const surface = await apiSurface(repo, 80);
    const listed = paths(surface).filter(Boolean);
    const note = surface.split('\n').find((l) => l.startsWith('...'))!;

    expect(note, 'files vanished with no note saying so').toBeDefined();
    const omitted = Number(note.match(/\((\d+) more/)![1]);
    expect(listed.length + omitted).toBe(SOURCE.length);
    // Kept a stable prefix rather than an arbitrary subset.
    expect(listed).toEqual(SOURCE.slice(0, listed.length));
  });

  it('describes every file completely when the whole surface fits', async () => {
    /*
     * The defect this is here for, measured on example-api 2026-08-21: the
     * complete surface came to 14,949 chars against a 16,000 cap — it fitted —
     * and 21 files were still truncated, with 3,739 chars of budget never
     * spent. The old loop gave each file an equal share of what remained and
     * passed the surplus forward only, so a file wanting more than its share
     * was cut whatever the files behind it went on to leave unused.
     *
     * Here, `src/big.ts` alone wants far more than a sixth of the budget, and
     * the five files it sorts before want almost none of it.
     */
    const files: Record<string, string> = {
      'src/big.ts': Array.from({ length: 18 }, (_, i) => `export function handlerNumber${i}() {}`).join('\n'),
    };
    for (const n of ['a', 'b', 'c', 'd', 'e']) files[`src/${n}.ts`] = `export const ${n} = 1;`;

    const complete = await withRepo(files, (r) => apiSurface(r, 100_000));
    const surface = await withRepo(files, (r) => apiSurface(r, complete.length + 40));

    expect(surface).not.toMatch(/more/);
    expect(surface).toContain('handlerNumber17');
    expect(surface).toBe(complete);
  });

  it('takes what it must from the file asking for the most, not the one sorting first', async () => {
    // Half the budget it needs, so something has to give. The five cheap files
    // are not what gives: they are not why the budget ran out.
    const files: Record<string, string> = {
      'src/big.ts': Array.from({ length: 18 }, (_, i) => `export function handlerNumber${i}() {}`).join('\n'),
    };
    for (const n of ['a', 'b', 'c', 'd', 'e']) files[`src/${n}.ts`] = `export const ${n} = 1;`;

    const complete = await withRepo(files, (r) => apiSurface(r, 100_000));
    const surface = await withRepo(files, (r) => apiSurface(r, Math.floor(complete.length / 2)));

    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      expect(surface, `src/${n}.ts lost its one name`).toContain(`src/${n}.ts: ${n}`);
    }
    expect(surface.split('\n').find((l) => l.startsWith('src/big.ts'))).toMatch(/\+\d+ more$/);
  });

  it('says so plainly when the repo has no source at all', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'shanauto-surface-empty-'));
    try {
      writeFileSync(join(empty, 'README.md'), '# nothing here\n');
      const git = simpleGit({ baseDir: empty });
      await git.init();
      await git.add('.');
      expect(await apiSurface({ ...repo, path: empty })).toBe('(no recognised source files yet)');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not pretend a non-repo is empty', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'shanauto-surface-nogit-'));
    try {
      expect(await apiSurface({ ...repo, path: notRepo })).toBe('(not a git repo yet)');
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
/*
 * Run 16 (2026-08-21): the reviewer's prompt came in 7397 chars over budget and
 * fitPrompt cut the symbol index from 15897 to 8446 - off the end, which is
 * alphabetical order, which has nothing to do with what the review was about.
 * The reviewer keeps whatever sorts first and loses the rest.
 *
 * Every path here is the same length on purpose, so that a test about ORDER is
 * not quietly also a test about which names happen to be cheap.
 */
describe('apiSurface relevance ordering', () => {
  const FOUR = {
    'src/plain/unrelated_alphas.ts': 'export const alphas = 1;',
    'src/plain/unrelated_bettas.ts': 'export const bettas = 1;',
    'zzz/under/sibling_of_thing.ts': 'export const sibling = 1;',
    'zzz/under/target_of_review.ts': 'export const target = 1;',
  };

  /** Room for two of these paths and the omission note, and nothing else. */
  const TIGHT = 110;

  it('keeps the file under review when a tight budget can only keep two', async () => {
    // Blind, this budget keeps the two files the review is not about and drops
    // both zzz/ files off the end.
    const blind = await withRepo(FOUR, (r) => apiSurface(r, TIGHT));
    expect(paths(blind).filter(Boolean)).toEqual(['src/plain/unrelated_alphas.ts', 'src/plain/unrelated_bettas.ts']);

    const focused = await withRepo(FOUR, (r) => apiSurface(r, TIGHT, ['zzz/under/target_of_review.ts']));
    expect(paths(focused)).toContain('zzz/under/target_of_review.ts');
  });

  it('puts the neighbours of the changed file ahead of unrelated files', async () => {
    const surface = await withRepo(FOUR, (r) => apiSurface(r, 100_000, ['zzz/under/target_of_review.ts']));
    expect(paths(surface).filter(Boolean)).toEqual([
      'zzz/under/target_of_review.ts',
      'zzz/under/sibling_of_thing.ts',
      'src/plain/unrelated_alphas.ts',
      'src/plain/unrelated_bettas.ts',
    ]);
  });

  it('holds alphabetical order inside a rank, so the listing is still stable', async () => {
    const files = {
      ...FOUR,
      'zzz/under/aardvark_of_dirt.ts': 'export const aardvark = 1;',
      'src/plain/unrelated_gammas.ts': 'export const gammas = 1;',
    };
    const surface = await withRepo(files, (r) => apiSurface(r, 100_000, ['zzz/under/target_of_review.ts']));
    expect(paths(surface).filter(Boolean)).toEqual([
      'zzz/under/target_of_review.ts',
      'zzz/under/aardvark_of_dirt.ts',
      'zzz/under/sibling_of_thing.ts',
      'src/plain/unrelated_alphas.ts',
      'src/plain/unrelated_bettas.ts',
      'src/plain/unrelated_gammas.ts',
    ]);
  });

  it('leaves the order alone when the caller names nothing', async () => {
    const surface = await withRepo(FOUR, (r) => apiSurface(r, 100_000));
    expect(paths(surface).filter(Boolean)).toEqual([
      'src/plain/unrelated_alphas.ts',
      'src/plain/unrelated_bettas.ts',
      'zzz/under/sibling_of_thing.ts',
      'zzz/under/target_of_review.ts',
    ]);
  });

  /*
   * Ordering only. A focus that quietly promoted its files into the listing, or
   * demoted anything out of it, would be a second way for the index to lie.
   */
  it('adds and removes nothing when the whole surface fits', async () => {
    const plain = await withRepo(FOUR, (r) => apiSurface(r, 100_000));
    const focused = await withRepo(FOUR, (r) => apiSurface(r, 100_000, ['zzz/under/target_of_review.ts']));
    expect(focused.split('\n').sort()).toEqual(plain.split('\n').sort());
  });

  it('drops no more files for being focused than it would have dropped anyway', async () => {
    for (const budget of [TIGHT, 140, 200, 400]) {
      const blind = paths(await withRepo(FOUR, (r) => apiSurface(r, budget))).length;
      const focused = paths(
        await withRepo(FOUR, (r) => apiSurface(r, budget, ['zzz/under/target_of_review.ts'])),
      ).length;
      expect(focused, `budget ${budget}`).toBe(blind);
    }
  });

  it('ignores a named file that is not in the repo instead of failing', async () => {
    const surface = await withRepo(FOUR, (r) => apiSurface(r, 100_000, ['gone/removed.ts']));
    expect(paths(surface).filter(Boolean)).toEqual([
      'src/plain/unrelated_alphas.ts',
      'src/plain/unrelated_bettas.ts',
      'zzz/under/sibling_of_thing.ts',
      'zzz/under/target_of_review.ts',
    ]);
  });
});
