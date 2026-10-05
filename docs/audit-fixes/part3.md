# Part 3 — Correctness & test-suite gaps (TQ-2 / TQ-3 / lint)

The daily engine had a testing hole where its most dangerous code lived: `run`,
`plan`, `report` and `resolve` had no subprocess tests, the F2 rollback catch had
no throwing-stub test, and `lint` was a script that never linted anything.
This part closed all three. Two small production changes were required first —
`SHANAUTO_CONFIG` (config isolation) and `stateRoot()` (run-lock isolation) —
because a subprocess test of the real CLI cannot be pointed at the operator's
own config, ledger and lock. `npm run typecheck` green, full suite green
(719 passed / 52 files), one commit.

---

## Done

### TQ-2 — subprocess tests for the daily engine + the run.lock lifecycle

Eight new tests in `src/cli.test.ts`. Each drives the real CLI (`tsx
src/index.ts …`) as a subprocess against a throwaway `SHANAUTO_DB` +
`SHANAUTO_CONFIG` and a scratch git repo (identity configured, `git init -b
main`, no remote), with the seeded backlog read back in-process through the
real ledger.

- **run with nothing ready** — acquires then releases the lock, prints
  "Nothing to work on.", and closes the run row (`ended_at` set, `notes =
  'nothing_ready'`). This is the F3 path that used to leave `end_run` NULL when
  a run had nothing to dispatch.
- **run refuses a live lock** — a lock file holding a live pid → exit 1,
  "Another run holds", and the lock file is untouched (SEC-5).
- **run takes over a stale lock** — a lock file holding a genuinely dead pid →
  takeover, "stale", and the lock is removed (SEC-5). The dead pid is a real
  process that has exited, not a guess.
- **plan** — boots the stub brain and prints "Backlog: +0": the temp config's
  `min_ready: 5` makes a seeded 6-task ready backlog short-circuit the refill,
  so no model is ever asked and no network is touched.
- **report** — writes `<today>.md` beside the redirected ledger, with the
  contribution check degrading to "unverified" via a `gh.cmd` exit-1 shim
  prepended to PATH. `gh` is installed on this machine; without the shim the
  test would ask GitHub for real.
- **resolve (handoff task)** — commits exactly the hinted file, marks the task
  `committed`, and warns "LOCAL ONLY" because the scratch repo has no remote
  (that is the SEC-7 push-failure path, exercised rather than mocked). A forced
  second resolve then finds a clean tree and fails with NO_CHANGES.
- **resolve (ready task)** — refused without `--force` ("not 'handoff'"),
  honoured with `--force` (F9).
- **resolve (unknown id)** — "No such task", exit 1.

### TQ-3 — throwing-stub test for the F2 rollback catch

`src/core/__tests__/executor.test.ts` gains three tests in a new block,
"an unexpected throw still rolls the tree back (F2)". The agent's `execute`
throwing, and the gate throwing, each reach the `runBatch` catch — the two
paths `runOne`'s own failure branch does not cover — and both assert
`git.rollback` was called once, the task ended `failed`, and `sum.failed` is 1.
A third test pins that a gate rejection which *returns* `ok:false` (the normal
NO_CHANGES path, which rolls back inside `runOne`) does **not** roll back a
second time in the catch.

### lint — the script that linted nothing is gone

`package.json` no longer ships `"lint": "tsc --noEmit"` — byte-identical to
`typecheck` (which already runs `tsc --noEmit` as its own script), so `npm run
lint` never linted anything and passing it proved nothing. Removing it leaves
`typecheck` as the single source of truth. A real ESLint integration remains an
optional follow-up; this part deliberately did not bolt one on.

### Production changes that made the above hermetic

- **`config.ts`**: `configDir()` reads `SHANAUTO_CONFIG` (defaults to the repo's
  own `config/`); the three yaml loads follow it. `stateRoot()` resolves the
  run lock + killswitch beside `SHANAUTO_DB` (defaults to `state/`), mirroring
  `reportsDir()`/`dataRoot()`.
- **`index.ts` / `core/executor.ts` / `tui/app.ts`**: KILLSWITCH, the run lock
  and their `ensureDir` calls now go through `stateRoot()`, so engine, executor
  and TUI agree on where the pause file lives and a redirected instance locks
  its own state.

---

## Not done (deferred to later parts)

| Gap | Where it lands |
|---|---|
| DOCS-10 `docs/CONTEXT.md` refresh; stale `D:/repos/` path sweep; DOCS-04 prune claim | **Part 4** |
| §9.1 agy driver deny-list, permissions loading, sandbox reconciliation | **Part 5** |
| §9.4 handoff briefs gitignore; §9.6 `notify()` hardening; §9.8 TUI `settings.ts` write path | **Part 6** |
| PERF-5 FTS5; PERF-6 chunked `exportMemory`; §9.7 deployment scripts; final audit mapping | **Part 7** |

---

## Design & architecture decisions

1. **Config is redirected with `SHANAUTO_CONFIG`, not stubbed or copied into
   fixtures.** The subprocess tests must never boot from the real
   `config/repos.yaml` — it names the operator's actual projects, and
   `loadConfig` requires ≥1 enabled repo whose folder exists. Injecting mock
   modules would have tested a different machine than the CLI runs on; instead
   the CLI is pointed, via one env var, at throwaway config. The temp config is
   the real `system.yaml` copied with exactly two deliberate overrides —
   `daily_target: 1` and `min_ready: 5` — so a few seeded tasks read as a 3+
   day runway (run does not try to plan) and plan's refill short-circuits. The
   exact code the CLI boots runs, against throwaway data.

2. **The run lock follows `SHANAUTO_DB`, because a test that shares the real
   lock cannot be safe.** SEC-5's lock is the engine's single serialization
   point; a test sharing it would either block on a live run or, worse, take
   the lock over and race the real run. `stateRoot()` is derived from
   `SHANAUTO_DB` the way `reportsDir()` is — one decision covers the tests'
   writes, and production (no `SHANAUTO_DB`) resolves to the same `state/` as
   before. The user-facing lock messages still say `state/run.lock`; that is the
   exact path in production, and rewriting operator-facing output to describe a
   redirected instance was judged not worth the churn.

3. **A `blocked` barrier task, not a synthetic row, keeps the backlog
   non-dispatchable.** `insertTasks` converts `depends_on` indexes into real
   ids, so a fake dep id cannot be seeded. The tests insert a real barrier task
   and `setStatus(id, 'blocked')`: dependents stay `pending` (the barrier is
   neither committed nor dropped), are not deadlocked (`deadlockedTaskIds` only
   follows *failed* deps), and never dispatch (`selectBatch` reads only
   `ready`). Seeding through the real ledger means every run exercises
   `unblockDependents` and `markDeadlocked` for real.

4. **The stub brain throws instead of returning.** A stub `ask()` that returned
   a plausible shape would silently "succeed" if a test's seeding ever let the
   planner reach it — converting a real regression into a confusing empty run.
   The stub throws with a message naming the fix ("seed the backlog past
   min_ready"), so the failure is loud and local. No agent stub was needed at
   all: in these scenarios none of the four commands instantiates an agent (run
   dispatches nothing, plan only plans, report and resolve do not execute), so
   the brain stub is the only driver fixture.

5. **Subprocess env is scrubbed of the operator's notification and
   verification channels.** `runCli` pins `NTFY_TOPIC` and `GH_TOKEN` to empty
   strings in the child env. The harness inherits the operator's shell; without
   this, a `report` test could have posted a real ntfy notification or run a
   real GitHub lookup. The report test additionally prepends a `gh.cmd` exit-1
   shim to PATH so the contribution check degrades to "unverified" instantly —
   verifying a contribution means asking GitHub, which a unit test must not do.

6. **The F2 status assertion reads the LAST status write, not the first.**
   `runOne` records `running` before the throw; the catch records `failed`
   after. `Array.find` returned the first and read as a regression;
   `.filter(...).at(-1)` pins the terminal state — the property that actually
   matters.
