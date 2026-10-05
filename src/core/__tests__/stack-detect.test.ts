import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStacks, phantomStacks, stackSummary } from '../stacks.js';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway repo containing exactly the marker files named. */
function repo(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), 'stack-'));
  made.push(d);
  for (const f of files) {
    const full = join(d, f);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '{}');
  }
  return d;
}

/*
 * `markers` was declared as "files that say this stack is in use here" when the
 * module was written and then never read: the stack came from a hand-typed line
 * in config/repos.yaml instead. On 2026-08-20 that line said example-api was
 * `python + fastapi + next.js` when the repo had no package.json anywhere, and
 * the planner spent every pass writing React tasks into a project that could
 * not build, run or test one.
 */
describe('detectStacks', () => {
  it('reads the repo instead of taking config on faith', () => {
    const ids = detectStacks(repo(['pyproject.toml'])).map((d) => d.stack.id);
    expect(ids).toEqual(['python']);
  });

  it('finds a UI one level down, which is where UIs actually live', () => {
    const found = detectStacks(repo(['requirements.txt', 'frontend/package.json']));
    expect(found.map((d) => `${d.stack.id}@${d.at}`)).toContain('javascript@frontend');
    expect(found.map((d) => d.stack.id)).toContain('python');
  });

  it('calls package.json + tsconfig.json TypeScript, not both node stacks', () => {
    const ids = detectStacks(repo(['package.json', 'tsconfig.json'])).map((d) => d.stack.id);
    expect(ids).toEqual(['typescript']);
  });

  it('says nothing rather than guessing when there are no markers', () => {
    expect(detectStacks(repo(['README.md']))).toEqual([]);
  });

  it('does not go looking inside node_modules', () => {
    const found = detectStacks(repo(['pyproject.toml', 'node_modules/package.json']));
    expect(found.map((d) => d.at)).toEqual(['']);
  });

  it('returns empty for a path that is not there, rather than throwing', () => {
    expect(detectStacks(join(tmpdir(), 'definitely-not-here-9271'))).toEqual([]);
  });
});

describe('phantomStacks', () => {
  it('catches the exact example-api case: next.js declared, no frontend on disk', () => {
    expect(phantomStacks(repo(['requirements.txt']), 'python + fastapi + next.js')).toContain('next.js');
  });

  it('is quiet when the declared stack is really there', () => {
    expect(phantomStacks(repo(['requirements.txt', 'frontend/package.json']), 'python + next.js')).toEqual([]);
  });

  it('does not call typescript a phantom just because the repo is javascript', () => {
    // One ecosystem, one package.json. Which of the two it is does not change
    // whether the work can be built or tested, and a false alarm here would
    // train the owner to ignore the real one.
    expect(phantomStacks(repo(['package.json']), 'typescript')).toEqual([]);
  });

  it('flags a declared python project in a repo that has none', () => {
    expect(phantomStacks(repo(['package.json']), 'fastapi backend')).toContain('fastapi');
  });
});

describe('stackSummary — what the planner is actually told', () => {
  it('leads with disk truth and keeps the declaration as intent', () => {
    const s = stackSummary(repo(['requirements.txt']), 'python + fastapi + next.js');
    expect(s).toMatch(/actually on disk: Python/);
    expect(s).toContain('python + fastapi + next.js');
  });

  it('forbids the phantom work outright, setting it up included', () => {
    const s = stackSummary(repo(['requirements.txt']), 'python + next.js');
    expect(s).toMatch(/Do NOT plan any task for it/);
    /*
     * The first version said "the first task must be to create it", meaning to
     * honour the wish behind the config line. The planner obliged and produced
     * two tasks installing a Next.js toolchain, neither verifiable — the test
     * runner being installed was the only thing that could have judged them.
     * An unjudgeable task is exactly what the gate exists to prevent.
     */
    expect(s).toMatch(/INCLUDING setting it up/);
    expect(s).not.toMatch(/the first task must be to create it/i);
  });

  it('adds no warning at all when config and disk agree', () => {
    const s = stackSummary(repo(['requirements.txt']), 'python + fastapi');
    expect(s).not.toMatch(/WARNING/);
  });

  it('admits it cannot tell, rather than inventing a stack', () => {
    expect(stackSummary(repo(['README.md']), 'python')).toMatch(/nothing recognisable/);
  });
});

/*
 * The false alarm this nearly shipped with.
 *
 * First cut of detectStacks went by manifest files alone, and reported that
 * example-api — 40-odd .py files under app/ and tests/, a passing pytest gate —
 * had no Python in it. That would have told the planner its one real stack was
 * a phantom: a louder and more damaging lie than the stale config line the
 * whole change exists to kill. Caught by running it against the real repo
 * before believing the unit tests.
 */
describe('code without a manifest', () => {
  it('is still the stack, and says the manifest is what is missing', () => {
    const d = repo(['app/main.py', 'tests/test_main.py']);
    const found = detectStacks(d);
    expect(found.map((f) => f.stack.id)).toEqual(['python']);
    expect(found[0]!.evidence).toBe('source');
  });

  it('is never called a phantom — the code is right there', () => {
    expect(phantomStacks(repo(['app/main.py']), 'python + fastapi')).toEqual([]);
  });

  it('is described honestly to the planner, manifest gap and all', () => {
    const s = stackSummary(repo(['app/main.py']), 'python + fastapi');
    expect(s).toMatch(/Python \(source only/);
    expect(s).toMatch(/no manifest/);
    expect(s).not.toMatch(/WARNING/);
  });

  it('separates real absence from a missing manifest in the same repo', () => {
    // example-api exactly: Python source with no requirements.txt, and a next.js
    // that does not exist in any form.
    const d = repo(['app/main.py', 'tests/test_main.py']);
    expect(phantomStacks(d, 'python + fastapi + next.js')).toEqual(['next.js']);
  });

  it('prefers the manifest when there is one, rather than reporting both grades', () => {
    const found = detectStacks(repo(['pyproject.toml', 'app/main.py']));
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).toBe('toolchain');
  });

  it('does not let a subdirectory re-report the root stack as its own', () => {
    // app/ holds .py, but app/ is not a second Python project.
    const found = detectStacks(repo(['app/main.py']));
    expect(found.map((f) => f.at)).toEqual(['']);
  });
});

/*
 * Both directions of the ts/js alias, because a mutation test caught the first
 * cut testing only one: with just `present.has('javascript') -> add typescript`
 * left standing, a typescript repo declaring "javascript" was still forgiven and
 * no test noticed the other line had been deleted.
 */
describe('typescript and javascript are one ecosystem', () => {
  it('forgives a javascript repo that calls itself typescript', () => {
    expect(phantomStacks(repo(['package.json']), 'typescript')).toEqual([]);
  });

  it('forgives a typescript repo that calls itself javascript', () => {
    expect(phantomStacks(repo(['package.json', 'tsconfig.json']), 'javascript app')).toEqual([]);
  });
});
