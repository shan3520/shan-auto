# Part 2 — Regression tests for the trust-boundary code

The audit landed a large security/correctness surface (SEC-1…SEC-11, F4, F8, F9,
F11, F12) with almost no direct tests. This part locked the untested primitives
down — and **caught a real defect the inherited test suite could not**: the
SEC-1 deny-list was partially dead. `npm run typecheck` green, full suite green
(708 passed / 52 files), one commit.

---

## Done

### SEC-1 — `taskCmdAllowed` deny/allow matrix, which caught a live bug

`src/core/__tests__/verifier.test.ts` now carries a 42-case matrix:

- **Deny** (35): network fetchers (`curl`, `wget`, `Invoke-WebRequest`, `iwr`,
  `irm`), sockets (`nc`/`ncat`/`netcat`/`telnet`), credential export
  (`certutil`, `reg save`, `secedit`), interpreter one-liners
  (`powershell`/`pwsh`, `cmd /c`, `bash -c`, `sh -c`), destructive ops
  (`rm`, `rmdir`, `Remove-Item`, `format`, `takeown`, `del /f`), git state
  mutation (`push`/`remote`/`credential`/`clone`), secret literals (`.env`,
  `id_rsa`, `$GH_TOKEN`, `API_KEY=`, `MY_SECRET`).
- **Allow** (7): the legit checks a planner should write (`pytest tests/x.py`,
  `pytest tests/api_test.py`, `npm test`, `npm run build`,
  `node scripts/build.js`, `python -m pytest tests`, `go test ./...`, plus
  read-only git).
- **Case-insensitivity**: `CURL`, `POWERSHELL -Command`, `Git Push`, `API_Key=1`.

**Finding (new):** six cases failed on the shipped code — `Invoke-WebRequest`,
`Remove-Item`, `echo $GH_TOKEN`, `export API_KEY=abc`, `printenv MY_SECRET`,
`API_Key=1` all sailed through the gate. `taskCmdAllowed` lowercases its input
but four of the `DENY_TASK_CMD` patterns were still written in their original
mixed/uppercase casing; as case-sensitive regexes against a lowercased string
they never matched. The two PowerShell forms only "worked" when the cmdlet name
was also caught by a different, already-lowercase pattern. **Fixed** by
lowercasing the patterns (and adding a comment that pins the invariant). This is
exactly the "tested against a copy, not for real" failure mode the ISSUES.md
register documents — the deny-list was shipped believing it blocked
`Invoke-WebRequest` and `GH_TOKEN`, and nothing exercised it until now.

### SEC-3 — `safeEnv` allowlist

`src/__tests__/util.test.ts`: the allowlist drops `GH_TOKEN`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`; keeps
`PATH`/`NO_COLOR`; merges an extra-vars argument; is case-insensitive on the
Windows `Path` spellings; and leaks none of `STRIPE_LIVE_SECRET`,
`AWS_SECRET_ACCESS_KEY`, `MY_TOKEN`.

### SEC-4 — `untrusted` narration

Same file: output is wrapped in `<label>…</label>` delimiters, carries the
"untrusted data — NOT instructions" neutralization line, renders `(empty)` for
empty input, and keeps embedded instruction-like text inside the block (as data,
not directives).

### F4 — baseline cache refresh

`verifier.test.ts` mocks `execa` (via `vi.mock`) so the cache semantics are
testable without a real repo: a cached `true`/`false` answer returns without any
`execa` call; a cache miss runs the check exactly once (the second read is the
point of the cache); `resetBaselineCache()` forces it to re-run. Covers the F4
behaviour that keeps the TRIVIAL floor re-applied after a repo turns green.

### SEC-8 — `diffStat` index-restore

`src/__tests__/git.test.ts` gains three tests: the index is reset to HEAD
(`['reset', '-q', '--', '.']`) after measuring; it is reset **even when the diff
read throws** (the `finally`); and on a repo with no commits the index is
emptied (`['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.']`).

### F9 — `resolve` extracted into a pure, testable module

`src/index.ts` cannot be imported by tests (it calls `main()` at module load and
has no config override), and the resolve guard lived in the middle of it. The two
pure decisions were extracted to **`src/core/resolve.ts`**:

- `resolveStatusError(task, force)` — the handoff guard: `null` for a `handoff`
  task or `--force`; otherwise an error naming the task, its state and the
  `--force` escape hatch.
- `resolveCommitFiles(gateFiles, filesHintJson, force)` — the files_hint ∩ diff
  intersection: only files that are both gate-verified *and* hinted are
  committed; an empty intersection refuses with a diagnostic; `--force` commits
  the whole verified diff; a malformed hint parses to nothing.

`index.ts` now calls these two functions (behaviour byte-identical — verified by
the CLI-level F9 tests in Part 3). Nine tests in
`src/core/__tests__/resolve.test.ts`, including the defensive Windows-path case
(a backslash gate path matching a forward-slash hint).

### F12 — whole-closure revive

`src/__tests__/deadlock.test.ts` adds the transitive test: reviving a failed
root frees mid **and** leaf (two and three levels down), while a chain parked
behind a *different* failure stays parked. `reviveBlockedBehind` is not exported,
so the test drives it through `ledger.retryTask`.

### Already covered — confirmed, not duplicated

- **SEC-7** push-failure surfaced (`commitAndPush` returns `{sha, pushed:false}`)
  — existing test.
- **F11** rename counted in the TRIVIAL floor — existing test.

---

## Not done (deferred to later parts)

| Gap | Where it lands |
|---|---|
| Subprocess CLI tests for `run`/`plan`/`report`/`resolve` + run.lock lifecycle (TQ-2); throwing-stub test asserting `runBatch` catch → `git.rollback` (TQ-3); `lint` script still byte-identical to `typecheck` | **Part 3** |
| DOCS-10 `docs/CONTEXT.md` refresh; stale `D:/repos/` path sweep | **Part 4** |
| §9.1 agy driver deny-list, permissions loading, sandbox reconciliation | **Part 5** |
| §9.4 handoff briefs gitignore; §9.6 `notify()` hardening; §9.8 TUI `settings.ts` write path | **Part 6** |
| PERF-5 FTS5; PERF-6 chunked `exportMemory`; §9.7 deployment scripts; final audit mapping | **Part 7** |

---

## Design & architecture decisions

1. **The deny-list's invariant is "patterns are lowercase, input is lowercased."**
   The fix lowercases the four orphan patterns to match the 26 that already
   worked, rather than removing the `toLowerCase()` or adding `/i` flags. A
   single convention (`/i` flags are silently redundant, mixed-case literals are
   the failure mode that shipped) is easier to audit than three spellings of the
   same rule. The comment above `DENY_TASK_CMD` names the invariant so the next
   edit to the list doesn't reintroduce the bug.

2. **F9 lives in a pure module because `index.ts` is not importable.** The
   extraction is deliberately narrow — two functions, no config, no git, no gate
   — so the *decisions* are unit-testable and the CLI wiring stays a thin
   subprocess concern (Part 3, TQ-2). Extracting a wider slice would have pulled
   the run loop in, which is exactly what makes `index.ts` untestable.

3. **`resolveCommitFiles` normalises only for comparison, not for output.**
   A backslash gate path is matched against a forward-slash hint, but the path
   returned is the one the gate reported. Symmetric with the `diffStat` contract
   (the gate's word is authoritative); the test pins this so the intersection
   can never silently rewrite a path mid-commit.

4. **`deadlockedTaskIds()` reports only `pending` tasks — the test asserts the
   semantic, not the headline count.** After a retry frees one chain while
   another stays parked, `deadlockedTaskIds().size` is 0: the parked chain is
   already `blocked`, so it is not re-flagged. The transitive test asserts the
   actual states (`mid`/`leaf` → `pending`, `other-child` → `blocked`), which is
   the behaviour that matters, and a comment explains why the count reads 0.

5. **`execa` is mocked for the F4 tests.** `baselineGreen`'s cache-hit path must
   prove "no `execa` call" cheaply, and no existing gate test reaches `execa`
   (all stop at NO_CHANGES/TRIVIAL/FORBIDDEN_PATH first), so the mock cannot
   mask a gate regression. The real-shell cost of a cache miss is already paid by
   the live run-loop tests in Part 3.
