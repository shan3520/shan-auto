# Part 1 — Land the in-progress fix set

The audit (2026-08-10, 50 findings) was written against a working tree that
already contained ~1071 uncommitted lines implementing most of the roadmap. This
part **validated, completed, and committed** that work rather than redoing it:
`npm run typecheck` green, the full suite green, three genuine gaps closed (F3,
TQ-4, ISSUES.md accuracy), the root scratch scripts deleted, and one commit.

---

## Done

### Baseline validation of the inherited fix set

- `npm run typecheck` — clean before any edit.
- Full suite before edits: **635 passed / 51 files**, exit 0.
- Full suite after this part's edits: **637 passed** (2 new tests).

The inherited working tree already implemented, and this commit lands:

| Band | Items |
|---|---|
| Security | SEC-1 `taskCmdAllowed()` deny-list on LLM-authored `task.verify_cmd`; SEC-2 interpreter one-liner denies in opencode/copilot; SEC-3 `extendEnv:false` + `safeEnv()` in every driver, both brains, verifier, repair; SEC-4 `untrusted()` in planner/ask/taskprompt/rollup + decompose.md note; SEC-5 atomic `'wx'` run.lock + PID liveness; SEC-6 `escapeRegExp`; SEC-7 `commitAndPush` → `{sha, pushed}`; SEC-8 diffStat index-restore in `finally`; SEC-9 quarantine collision suffix; SEC-10 index.lock try/catch; SEC-11 YAML-escaped repo ids; §9.2 FORBIDDEN extended to `package.json`, `pyproject.toml`, `conftest.py`, `.npmrc`, `.env`, `Dockerfile`, `go.mod`, `Cargo.toml` |
| Correctness | F1 known.map formatting; F2 rollback in runBatch catch; F3 run-close on empty/dry paths (**and now the abort path — see below**); F4 `setBaselineCache`; F6 `holdBlockedWork`; F8 `COALESCE(occurred_at, resolved_at)`; F9 resolve requires `handoff` + `--force`, commits only `files_hint` files; F10 quarantine → `tmpdir()`; F11 renames count in TRIVIAL floor; F12 dependency-closure revive |
| Performance | PERF-1 `committed_day` index; PERF-2 CSV LIMIT; PERF-3 `commitsBetween` limit + `pMap`; PERF-4 treeCache; PERF-6 push-based bucketing; PERF-7 single-pass rollup; PERF-8 narrowed deadlock load; PERF-9 `unblockDependents(id)`; PERF-10 TUI overview cache |
| Docs/test infra | `safeEnv`/`escapeRegExp`/`pMap`/`untrusted` utils; `dataRoot()` test isolation; README/MANUAL/ISSUES/DECISIONS refreshed; legacy `tests/` suites deleted; `vitest.config.ts` scoped to `src/` |

### F3 residual — a run that aborts now closes in the ledger

**Was:** `run()` called `ledger.endRun` on the `nothing_ready`, `dry_run`, and
normal paths, but the **catch path never did** — if `runBatch` threw, the runs
row stayed `end_run` NULL forever, indistinguishable from a run still in flight.

**Now (`src/index.ts`):** a `runClosed` flag is set after every successful
`endRun`; the catch calls `ledger.endRun(runId, 0, 0, 'aborted: <reason>')` only
when `!runClosed`. The guard matters: `writeReport` runs *after* the successful
`endRun`, and if it threw, an unguarded catch-endRun would have overwritten the
real counts with `aborted`. A `finally` was rejected for the same reason — it
would clobber the per-path values (`nothing_ready`/`dry_run`/real sums).

### TQ-4 — the DEAD_EXPORT branch finally runs under test

**Was:** every gate test forced `forbid_dead_exports: false`, but the shipped
default (`config/system.yaml`) is `true` — so the DEAD_EXPORT branch and the
whole `.ts` export scan had **no test that reached them**. Deleting the branch
from `gate()` would have left all tests green.

**Now (`verifycmd.test.ts`):** two shipped-default tests —
1. a new `export function orphan()` nothing references → `DEAD_EXPORT`;
2. a new export imported by a sibling file → passes.

Supporting fix: `scratchRepo` now assigns a unique `repo.id` per directory,
because the dead-export tree cache is keyed `repo.id@HEAD` and two scratch repos
sharing `'g'` would hand the second test the first's cached file tree.

### TQ-1 — root scratch scripts deleted

The nine root `test-*.mjs` / `test_regex.mjs` scripts are gone. Chains 1–5 wrote
to the **real** `data/shanauto.db`; F12/deadlock behaviour is now covered by
`src/__tests__/deadlock.test.ts`.

### ISSUES.md FIXED-table claims reconciled with code

Three claims overstated. Corrected to what the code actually does:

- **O16** said the test imports patterns "from `agent.agy.ts`". Reality:
  `brain-classify.test.ts` imports `classifyBrainOutput` from the real
  `brain.agy.ts`, which **owns** `QUOTA_PATTERNS`/`AUTH_PATTERNS`. Substance
  (guards the real rule, not a copy) unchanged; file/pattern wording fixed.
- **O17** claimed an "Indexed `day_ingested` column added". **No such column
  exists** (verified: zero matches in `src/`). The real fix is
  `ledger.ingestedJournalDays()` — `SELECT DISTINCT date(occurred_at)` over the
  resolutions table — replacing the read-every-stored-day-file scan. Reworded.
- **O19** named `scripts/triage.ts` as the prune schedule. That file has no
  `prune`; the task is registered in `scripts/install-scheduler.ps1:69`
  (`-Arg 'prune' -At '19:15'`). Corrected.

---

## Not done (deferred to later parts)

| Gap | Where it lands |
|---|---|
| Regression tests for the new trust-boundary primitives (`taskCmdAllowed`, `safeEnv`, `untrusted`, `setBaselineCache`, diffStat index-restore, `commitAndPush` push-failure, `resolve --force`/`files_hint`, `reviveBlockedBehind` extension) | **Part 2** |
| Subprocess tests for `run`/`plan`/`report`/`resolve` + run.lock lifecycle (TQ-2); throwing-stub test for `runBatch` catch → rollback (TQ-3); `lint` script still byte-identical to `typecheck` | **Part 3** |
| DOCS-10 `docs/CONTEXT.md` refresh (old path `D:/repos/shanauto`, routing/brain lines, test count); stale-path sweep | **Part 4** |
| §9.1 agy driver: no in-driver deny-list, permissions allow-list loaded only by manual `scripts/agy-access.ps1`, deployed `sandbox:false` vs driver `?? true` | **Part 5** |
| §9.4 `.shanauto/handoff` briefs not gitignored; §9.6 `notify()` unauthenticated POST to public `ntfy.sh`; §9.8 TUI `settings.ts` dotted-path regex write against live YAML | **Part 6** |
| PERF-5 FTS5 for `searchResolutions`; PERF-6 residual 1M-row `exportMemory` load; §9.7 deployment scripts review; final finding→status mapping | **Part 7** |

`shanauto-deep-audit-report.html` stays untracked (an input artifact, not part of
the source tree). F5 and the O7/O8 lines are untouched by this part.

---

## Design & architecture decisions

1. **Run-close lives in `run()` itself, with a flag, not a `finally`.**
   A bare `finally`-endRun would overwrite the meaningful notes/counts from the
   three normal exits. The `runClosed` guard is the minimum state that keeps
   "closed exactly once, with the most accurate values available" true on all
   four exit paths — including the late `writeReport` throw.

2. **Scratch-repo ids must be unique under test.** The inherited PERF-4
   treeCache keys on `repo.id@HEAD`; two scratch repos sharing an id silently
   shared a cache entry built from the first repo's directory. This is a real
   property of the shipped code surfaced by a test — not a test hack — and it is
   why the "wired-up export passes" test exists at all.

3. **`runs.notes` is a DB-level diagnostic, not user-facing.** Nothing reads it
   for display, so recording the abort reason (`aborted: <msg>`) there costs
   nothing on any screen and gives the daily query a way to distinguish an
   aborted run from a run that genuinely did nothing.

4. **Documentation claims are evidence, not prose.** O16/O17/O19 were each
   verified against the code before correction; the two wrong statements
   (a nonexistent column, a nonexistent schedule location) would have sent the
   next reader on a search for something that was never there.
