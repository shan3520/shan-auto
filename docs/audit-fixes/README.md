# ShanAuto Audit Fixes — index & final mapping

Audit: `shanauto-deep-audit-report.html` (2026-08-10) — 50 confirmed findings
(11 High · 24 Medium · 15 Low) + 5 rejected (F5 twice, F7, TQ-5, TQ-8). This
directory is the fix trail: seven parts, each with its own doc, one commit each,
`npm run typecheck` + full vitest suite green at the end of every part.

## Part index

| Part | Scope | Doc |
|---|---|---|
| **1** | Land + complete the inherited fix set (SEC-1..11, F1..F12, PERF-1..4/6..10, TQ-1/4, ISSUES.md); F3 abort-close; root scratch scripts deleted | [`part1.md`](part1.md) |
| **2** | Regression tests for the new trust-boundary code (`taskCmdAllowed`, `safeEnv`, `untrusted`, `setBaselineCache`, diffStat index-restore, `commitAndPush` push-failure, `resolve --force`/`files_hint`, `reviveBlockedBehind`) | [`part2.md`](part2.md) |
| **3** | Subprocess CLI tests for run/plan/report/resolve + run.lock lifecycle (TQ-2); throwing-stub rollback test (TQ-3); fake `lint` script removed | [`part3.md`](part3.md) |
| **4** | Documentation refresh — CONTEXT.md, MANUAL config/agents tables, README brain narrative, stale-path sweep, ISSUES.md O19 | [`part4.md`](part4.md) |
| **5** | §9.1 dedicated agy-driver review — in-driver deny-list, orchestrator-side allow-list validation, sandbox contradiction reconciled | [`part5.md`](part5.md) |
| **6** | §9.4 `.shanauto/` handoff briefs excluded from the gate; §9.6 `notify()` token-gated; §9.8 TUI settings AST-guided atomic write | [`part6.md`](part6.md) |
| **7** | PERF-5 FTS5 tracked deferral; PERF-6 `exportMemory` streaming; §9.7 deployment scripts review (agy rotation no-op fixed); TQ-9/TQ-10 vacuous tests; this mapping | [`part7.md`](part7.md) |

## Final finding → status

**Closed** = fixed and (where the part intended) regression-tested. **Deferred** =
a tracked decision with a trigger, not an oversight. **Consciously unchanged** =
looked at, kept, reason recorded. **Rejected** = refuted by the audit's own
double-skeptic verification. Where = part(s) that closed it.

### Security

| Finding | Sev | Status | Where |
|---|---|---|---|
| SEC-1 — LLM-authored `task.verify_cmd` ran with full env as arbitrary shell | High | **Closed** — `taskCmdAllowed` deny-list + `extendEnv:false`/`safeEnv` | P1 (+P2 tests) |
| SEC-2 — interpreter one-liners bypass opencode/copilot deny-lists | Med | **Closed** — `node -e`, `python -c`, `powershell -EncodedCommand`, … denied | P1 |
| SEC-3 — agent + verify subprocesses inherit GH_TOKEN | Med | **Closed** — `extendEnv:false` + minimal allowlist in every driver, both brains, verifier, repair | P1 (+P2 test) |
| SEC-4 — journal/resolutions → decompose → verify_cmd injection | Med | **Closed** — `untrusted()` neutralization at every boundary | P1 |
| SEC-5 — run.lock non-atomic, stale locks never validated | Med | **Closed** — atomic `'wx'` acquire + PID liveness | P1 (+P3 subprocess) |
| SEC-6 — DEAD_EXPORT regex interpolates symbol unescaped | Low | **Closed** — `escapeRegExp` (latent trigger kept hardened) | P1 |
| SEC-7 — commit re-reads tree ≠ verified snapshot; push failure un-surfaced | Low | **Closed** — re-diff + `{sha, pushed}`, local-only warned | P1 (+P2 test) |
| SEC-8 — `git add -A --intent-to-add` poisons the index | Med | **Closed** — index restored in `finally` | P1 (+P2 test) |
| SEC-9 — quarantine filename collision drops a recoverable copy | Low | **Closed** — numeric suffix | P1 |
| SEC-10 — stale index.lock check races rollback | Low | **Closed** — one try/catch | P1 |
| SEC-11 — registerRepo unescaped RegExp + unquoted scalars | Low | **Closed** | P1 |

### Functional

| Finding | Sev | Status | Where |
|---|---|---|---|
| F1 — planner feeds `[object Object]` as the work list | High | **Closed** | P1 |
| F2 — runBatch catch marks failed with no rollback | High | **Closed** + throwing-stub test | P1 (+P3) |
| F3 — early-return/abort runs never call `endRun` | Med | **Closed** — all four exit paths close the run | P1 (+P3) |
| F4 — baselineCache never reset → repo green/red frozen | Med | **Closed** — `setBaselineCache` on commit | P1 (+P2 test) |
| F5 — "deadlock misses chains deeper than one hop" | Rejected | **Rejected ×2** — single-pass closure computes all hops | audit |
| F6 — refill bypasses `holdBlockedWork` | Med | **Closed** | P1 |
| F7 — dead-export regex (dup of SEC-6) | Rejected | **Rejected** | audit |
| F8 — `resolutionsForShas` falls back to `resolved_at` | Med | **Closed** — `COALESCE(occurred_at, resolved_at)` | P1 |
| F9 — resolve commits the whole diff, no status guard | Med | **Closed** — requires `handoff` + `--force`, commits only `files_hint` | P1 (+P2/P3) |
| F10 — rollback quarantine lives inside the repo | Med | **Closed** — quarantine → `tmpdir()` | P1 |
| F11 — TRIVIAL floor misclassifies pure renames | Low | **Closed** — renames count as work | P1 |
| F12 — blanket revive of every blocked task | High | **Closed** — dependency-closure revive | P1 (+P2 ext.) |

### Performance

| Finding | Sev | Status | Where |
|---|---|---|---|
| PERF-1 — "today" queries full-scan the committed set | Med | **Closed** — indexed `committed_day` | P1 |
| PERF-2 — CSV export re-serialises entire history | Med | **Closed** — LIMIT | P1 |
| PERF-3 — ~10k git subprocesses on ingestion | High | **Closed** — `git log -n`, `pMap` concurrency | P1 |
| PERF-4 — whole-repo file read per gate call | High | **Closed** — treeCache | P1 |
| PERF-5 — indexless LIKE scan of tens-of-KB reasons | Med | **Deferred (tracked)** — measured 231 rows/37 KB; trigger ~10k rows OR ~50 MB; FTS5 is the documented upgrade | P7 |
| PERF-6 — quadratic spread-copy + 1M-row load | High | **Closed** — push-bucketing (P1) + chunked streaming `exportMemory` (P7) | P1, P7 |
| PERF-7 — one query per closed rollup period | Low | **Closed** — single-pass JS bucketing | P1 |
| PERF-8 — deadlockedTaskIds loads the whole table | Med | **Closed** — narrowed load | P1 |
| PERF-9 — unblockDependents rescans all pending | Low | **Closed** — scoped to the committed id | P1 |
| PERF-10 — TUI re-parses config on every render | Low | **Closed** — overview cache | P1 |

### Documentation

| Finding | Sev | Status | Where |
|---|---|---|---|
| DOCS-01/02/03 — ISSUES.md O14–O18 fixed but still OPEN | Med | **Closed** — register reconciled with code | P1 |
| DOCS-04 — O19 claims prune never scheduled | Med | **Closed** — 19:15 task documented; ISSUES.md corrected | P1, P4 |
| DOCS-05 — MANUAL config table contradicts shipped config | Med | **Closed** | P4 |
| DOCS-06 — MANUAL agents table inverts routing | Med | **Closed** | P4 |
| DOCS-07 — agy sandbox three-way contradiction | Med | **Closed** | P5 |
| DOCS-08 — README describes opencode as the brain | Med | **Closed** | P4 |
| DOCS-09 — doc says `set simple_agent: agy` (parsed, never read) | Low | **Closed** — docs use the plural keys | P4 |
| DOCS-10 — CONTEXT.md stale on every axis | Med | **Closed** | P4 |
| DOCS-11 — `retry --failed` recovery claim | Low | **Closed** — docs corrected with F12 | P1, P4 |
| ISSUES.md O7 — removed per-repo routing described as current | Med | **Closed** | P4 |

### Test-suite & data hygiene

| Finding | Sev | Status | Where |
|---|---|---|---|
| TQ-1 — root scratch scripts write to the REAL ledger | High | **Closed** — deleted | P1 |
| TQ-2 — run/plan/report/resolve + run.lock untested | High | **Closed** — subprocess tests | P3 |
| TQ-3 — runBatch catch never exercised | High | **Closed** — throwing-stub rollback test | P3 |
| TQ-4 — DEAD_EXPORT branch never runs under test | Med | **Closed** — shipped-default config test | P1 |
| TQ-5 — deadexports tests only use alphanumeric ids | Rejected | **Rejected** — refuted; coverage point kept in SEC-6 | audit |
| TQ-6 — source-sniffing tests brittle to cwd/rename | Low | **Consciously unchanged** — price of pinning atomicity contracts | — |
| TQ-7 — legacy duplicate suites still run | Low | **Closed** — `tests/` deleted | P1 |
| TQ-8 — data-safety leaks SHANAUTO_DB across files | Rejected | **Rejected** — vitest module isolation refutes it | audit |
| TQ-9 — "real data/reports left alone" asserts the temp dir | Low | **Closed** — snapshot-assert the real tracked file | P7 |
| TQ-10 — vacuous import-smoke `toBeDefined` | Low | **Closed** — removed | P7 |
| `npm run lint` byte-identical to typecheck | Low | **Closed** — fake lint removed | P3 |

### §9 coverage gaps (completeness critic)

| Gap | Status | Where |
|---|---|---|
| agy driver unexamined — no in-driver deny-list, allow-list never loaded by the orchestrator, sandbox contradiction | **Closed** — dedicated review | P5 |
| gate FORBIDDEN list can't protect the check itself | **Closed** — `package.json`, `pyproject.toml`, `conftest.py`, `.npmrc`, `.env`, `Dockerfile`, … | P1 |
| copilot deny-list has SEC-2's interpreter bypass | **Closed** — folded into SEC-2 | P1 |
| `.shanauto/handoff` briefs pollute gate diffs | **Closed** | P6 |
| memory injection surface wider than SEC-4 | **Closed** — folded into SEC-4 | P1 |
| `notify()` posts run content to a public topic | **Closed** — body ⇔ `NTFY_TOKEN` | P6 |
| deployment scripts outside every finding | **Closed** — rotation no-op fixed, idempotency, node path | P7 |
| TUI config write via dotted-path regex | **Closed** | P6 |

## Roll-up

Counting the audit's own severity roll-up (11 High · 24 Medium · 15 Low = 50,
rejections separate):

- **Closed — 48 of 50 confirmed findings.** The two exceptions are PERF-5
  (deferred) and TQ-6 (consciously unchanged). Both High-severity §9 gaps — the
  agy driver (§9.1) and the deployment scripts (§9.7) — are closed, as are the
  two PERF Highs (§9's PERF-6 via streaming).
- **Deferred-with-reason:** PERF-5 (FTS5, with a measured trigger).
- **Consciously unchanged (documented):** TQ-6, plus the P6/P7 operator-facing
  trade-offs (worker-side `.shanauto/` ignore, token-less `notify()` body drop,
  unlocked-but-atomic settings write, in-place script edits).
- **Rejected:** 4 distinct (F5 ×2, F7, TQ-5, TQ-8) — refuted by the audit's own
  double-skeptic verification.
- **Beyond the 50:** the remaining §9 coverage gaps (§9.2 FORBIDDEN list,
  §9.4 `.shanauto/`, §9.6 `notify()`, §9.8 TUI settings) are also closed; several
  were folded into numbered findings (copilot deny-list → SEC-2, memory
  injection → SEC-4).

Every part ends green: `npm run typecheck` clean and the full vitest suite
passing. `shanauto-deep-audit-report.html` remains untracked (an input artifact).
