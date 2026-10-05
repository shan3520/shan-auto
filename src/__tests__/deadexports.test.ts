import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { findDeadExports } from '../core/deadexports.js';
import type { Repo } from '../schemas.js';

/**
 * Exercises the check against a real git repo, because it works off `git diff
 * HEAD` — a mocked filesystem would not prove anything.
 */
let dir: string;
let repo: Repo;

async function git(...args: string[]) {
  await execa('git', args, { cwd: dir });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sa-dead-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'existing.ts'), 'export const alreadyHere = 1;\n');
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'p@p');
  await git('config', 'user.name', 'p');
  await git('add', '-A');
  await git('commit', '-m', 'base');

  repo = {
    id: 'probe',
    path: dir,
    branch: 'main',
    stack: 'typescript',
    verify_cmd: 'echo ok',
    enabled: true,
    weight: 1,
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('findDeadExports', () => {
  it('flags a new export that nothing references', async () => {
    writeFileSync(join(dir, 'src', 'orphan.ts'), 'export function generateSparklineSvg() { return ""; }\n');
    const dead = await findDeadExports(repo, ['src/orphan.ts']);
    expect(dead.map((d) => d.symbol)).toContain('generateSparklineSvg');
  });

  it('passes an export that another source file calls', async () => {
    writeFileSync(join(dir, 'src', 'used.ts'), 'export function reallyUsed() { return 1; }\n');
    writeFileSync(
      join(dir, 'src', 'caller.ts'),
      "import { reallyUsed } from './used.js';\nexport const v = reallyUsed();\n",
    );
    const dead = await findDeadExports(repo, ['src/used.ts', 'src/caller.ts']);
    expect(dead.map((d) => d.symbol)).not.toContain('reallyUsed');
  });

  it('does not count a test file as a real reference', async () => {
    writeFileSync(join(dir, 'src', 'onlytested.ts'), 'export function onlyTested() { return 1; }\n');
    writeFileSync(
      join(dir, 'src', 'onlytested.test.ts'),
      "import { onlyTested } from './onlytested.js';\nonlyTested();\n",
    );
    const dead = await findDeadExports(repo, ['src/onlytested.ts']);
    expect(dead.map((d) => d.symbol)).toContain('onlyTested');
  });

  it('honours an @public opt-out', async () => {
    writeFileSync(
      join(dir, 'src', 'deliberate.ts'),
      '// @public - part of the plugin surface\nexport function deliberatelyUnused() { return 1; }\n',
    );
    const dead = await findDeadExports(repo, ['src/deliberate.ts']);
    expect(dead.map((d) => d.symbol)).not.toContain('deliberatelyUnused');
  });

  it('ignores entry points, whose callers are outside the codebase', async () => {
    writeFileSync(join(dir, 'src', 'index.ts'), 'export function main() { return 1; }\n');
    const dead = await findDeadExports(repo, ['src/index.ts']);
    expect(dead).toHaveLength(0);
  });

  it('ignores test files as sources of new exports', async () => {
    writeFileSync(join(dir, 'src', 'helper.test.ts'), 'export function testHelper() { return 1; }\n');
    const dead = await findDeadExports(repo, ['src/helper.test.ts']);
    expect(dead).toHaveLength(0);
  });

  it('returns nothing when the change adds no exports at all', async () => {
    writeFileSync(join(dir, 'src', 'existing.ts'), 'export const alreadyHere = 2;\n');
    const dead = await findDeadExports(repo, ['src/existing.ts']);
    expect(dead).toHaveLength(0);
  });
});

/*
 * The check was TypeScript-only, and the only repo it guards is Python.
 *
 * `forbid_dead_exports: true` has been set in config/system.yaml the whole time.
 * The filter was `f.endsWith('.ts')`, so on example-api findDeadExports returned an
 * empty array before it looked at anything — the gate the operator was told is
 * on was doing nothing at all. Found 2026-08-20.
 *
 * The false positives are the risk here, not the misses. Rejecting a correct
 * change costs a rollback and an agent request to rediscover it, and example-api is
 * a FastAPI project where the two commonest new symbols — a route handler and a
 * response model — are both referenced in ways a name search cannot see.
 */
describe('findDeadExports on Python', () => {
  let pdir: string;
  let prepo: Repo;

  async function pgit(...args: string[]) {
    await execa('git', args, { cwd: pdir });
  }

  beforeAll(async () => {
    pdir = mkdtempSync(join(tmpdir(), 'sa-dead-py-'));
    mkdirSync(join(pdir, 'app', 'services'), { recursive: true });
    mkdirSync(join(pdir, 'app', 'api'), { recursive: true });
    mkdirSync(join(pdir, 'tests'), { recursive: true });
    writeFileSync(join(pdir, 'app', 'existing.py'), 'def already_here():\n    return 1\n');
    await pgit('init', '-b', 'main');
    await pgit('config', 'user.email', 'p@p');
    await pgit('config', 'user.name', 'p');
    await pgit('add', '-A');
    await pgit('commit', '-m', 'base');

    prepo = {
      id: 'pyprobe',
      path: pdir,
      branch: 'main',
      stack: 'python + fastapi',
      verify_cmd: 'echo ok',
      enabled: true,
      weight: 1,
    };
  });

  afterAll(() => rmSync(pdir, { recursive: true, force: true }));

  const write = (rel: string, src: string) => writeFileSync(join(pdir, rel), src);

  it('flags a new module nothing imports', async () => {
    // app/services/query_similarity.py, 2026-08-20, as it would have been if the
    // agent had not gone looking for somewhere to call it from.
    write(
      'app/services/query_similarity.py',
      'def compute_query_similarity_matrix(queries):\n    return [[1.0]]\n',
    );
    const dead = await findDeadExports(prepo, ['app/services/query_similarity.py']);
    expect(dead.map((d) => d.symbol)).toContain('compute_query_similarity_matrix');
  });

  it('passes it once something imports it', async () => {
    write('app/services/scoring.py', 'def score_pair(a, b):\n    return 0.5\n');
    write(
      'app/api/scores.py',
      'from app.services.scoring import score_pair\n\n\ndef handler():\n    return score_pair(1, 2)\n',
    );
    const dead = await findDeadExports(prepo, ['app/services/scoring.py', 'app/api/scores.py']);
    expect(dead.map((d) => d.symbol)).not.toContain('score_pair');
  });

  it('leaves a decorated route alone, since the decorator is what calls it', async () => {
    // The single most common thing this system writes. If this ever starts
    // failing, every new endpoint gets rolled back and the run does nothing.
    write(
      'app/api/routes.py',
      'from fastapi import APIRouter\n\nrouter = APIRouter()\n\n\n@router.get("/clustered")\ndef get_clustered_queries(limit: int = 10):\n    return []\n',
    );
    const dead = await findDeadExports(prepo, ['app/api/routes.py']);
    expect(dead.map((d) => d.symbol)).not.toContain('get_clustered_queries');
  });

  it('leaves a response model that only its own endpoint names', async () => {
    // Defined beside the route, passed to response_model=, never imported. In
    // TypeScript that pattern means dead; in Python it means normal.
    write(
      'app/api/models_route.py',
      'from pydantic import BaseModel\nfrom fastapi import APIRouter\n\nrouter = APIRouter()\n\n\nclass ClusteredQueryResponse(BaseModel):\n    canonical_query: str\n\n\n@router.get("/x", response_model=ClusteredQueryResponse)\ndef x():\n    return {}\n',
    );
    const dead = await findDeadExports(prepo, ['app/api/models_route.py']);
    expect(dead.map((d) => d.symbol)).not.toContain('ClusteredQueryResponse');
  });

  it('leaves a private helper alone', async () => {
    // A leading underscore says "not part of this module's surface". Demanding
    // an outside caller for it would be demanding worse code.
    write(
      'app/services/withprivate.py',
      'def _normalise(s):\n    return s.strip()\n\n\ndef public_entry(s):\n    return _normalise(s)\n',
    );
    const dead = await findDeadExports(prepo, ['app/services/withprivate.py']);
    expect(dead.map((d) => d.symbol)).not.toContain('_normalise');
  });

  it('does not ask who calls a method, only who uses the class', async () => {
    // Indented definitions are reached through the thing that holds them.
    write(
      'app/services/holder.py',
      'class Unreferenced:\n    def helper(self):\n        return 1\n',
    );
    const dead = await findDeadExports(prepo, ['app/services/holder.py']);
    const names = dead.map((d) => d.symbol);
    expect(names).toContain('Unreferenced');
    expect(names).not.toContain('helper');
  });

  it('does not count a pytest file as a real reference', async () => {
    write('app/services/onlytested.py', 'def only_tested():\n    return 1\n');
    write(
      'tests/test_onlytested.py',
      'from app.services.onlytested import only_tested\n\n\ndef test_it():\n    assert only_tested() == 1\n',
    );
    const dead = await findDeadExports(prepo, ['app/services/onlytested.py']);
    expect(dead.map((d) => d.symbol)).toContain('only_tested');
  });

  it('ignores the files something outside the code runs', async () => {
    write('app/main.py', 'def create_app():\n    return 1\n');
    expect(await findDeadExports(prepo, ['app/main.py'])).toHaveLength(0);

    write('tests/conftest.py', 'def db_fixture():\n    return 1\n');
    expect(await findDeadExports(prepo, ['tests/conftest.py'])).toHaveLength(0);
  });
});
