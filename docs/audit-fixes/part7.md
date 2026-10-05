# Part 7 — Long tail, regression & final audit mapping

The last of the audit's residuals: PERF-5 (FTS5 or a codified deferral), the
PERF-6 1M-row `exportMemory` load, and §9.7 — the deployment scripts that had
"none reviewed". `npm run typecheck` clean, full suite green, one commit. Part 7
also adds `docs/audit-fixes/README.md`, the running index and the final
finding → status mapping for all 50 confirmed findings.

---

## Done

### PERF-5 — FTS5 codified as a *tracked* deferral (`src/ledger.ts`, `docs/DECISIONS.md`)

The audit offered two acceptable ends for `searchResolutions`' indexless
`LIKE '%term%'` scan: implement FTS5, **or** codify the deferral. We measured the
store and chose the tracked deferral.

- **Measured baseline (2026-08-11):** the real ledger holds **231 resolutions,
  ~37 KB total reason text, longest 5 KB** — a couple of `SELECT` casts, not a
  table worth a permanent FTS5 shadow table and its dual-write/trigger surface.
- **Corrected cost model:** the audit's "~11k rows ⇒ 600 MB–1.5 GB" was row-count
  extrapolation. The real cost driver is **searchable bytes** (journal days are
  ingested whole via `condenseDay`), so the trigger is now stated in bytes, not
  rows: revisit when a repo's resolutions exceed **~10,000 rows OR ~50 MB of
  searchable text**.
- **Trigger wired into the code's own contract** — `searchResolutions`' docblock
  now names the deferral and the trigger, so the next person to touch it is told
  when the table stops being free.

### PERF-6 residual — `exportMemory` streams in bounded chunks (`src/ledger.ts`, `src/core/memory-export.ts`)

`exportMemory` used to pull up to **1,000,000** resolutions and rollups into
memory at once (and copy each year's array per append — O(n²)). It now:

- iterates with **keyset-paginated chunks** (`ledger.eachResolution` /
  `eachRollup`, `ORDER BY (resolved_at, id)`, `LIMIT ?` default 2000) so memory is
  bounded by the chunk size, not by the size of history — the audit's PERF-6
  line for the whole `memory-export` path;
- appends each record's line straight into the year's **temp file** as it
  arrives, then `renameSync`s all temps at the end — preserving the atomic
  "no year's backup is ever overwritten until its replacement is complete"
  contract (still pinned by `data-safety.test.ts`);
- keeps the empty-guard: an export that finds **0 records** refuses to run over
  existing backups (that guard is what keeps a wrong `SHANAUTO_DB` from
  zeroing a year's memory).

The continuation correctness (no duplicate/lost rows across chunk boundaries) is
asserted by two new tests that force a chunk size of 2 across 5 rows.

### §9.7 — deployment scripts reviewed, and the containment bug fixed (`scripts/*.ps1`, `config/agy-permissions.md`)

The audit's §9.7 observation was blunt: `agy-access.ps1` (the *actual*
containment boundary for agy), `install-scheduler.ps1`, and
`setup-restricted-account.ps1` were outside every finding. Reviewing them
surfaced one real defect — **agy's rotation toggle was a silent no-op** — plus
three cheap robustness fixes and one idempotency fix.

**`agy-access.ps1` — the rotation toggle actually rotates now.**

- **Was:** `Set-AgyRotation` regexed a singular `complex_agent:` key that no
  longer exists (routing is the `complex_agents: [agy, copilot]` **array**,
  `config/drivers.yaml:120`; `schemas.ts` keeps the singular only as a legacy
  shim). `-Apply`/`-Revert` claimed success while writing **nothing**.
- **Now:** it parses the real array, **adds** `agy` (`-Apply`) or **removes** it
  (`-Revert`), rewrites exactly the match span, and **throws if the array is
  absent** — a missing key is a hard error, never a silent no-op. `Show-Status`
  reads the same plural key.
- **Caught by a pre-commit functional test:** the first cut split the *whole
  match* (key included) on brackets, which leaked `complex_agents:` into the
  agent list (`[complex_agents:, agy, copilot]`). Seven in-memory cases (apply/
  revert on the real file, empty array, single-agent array, missing-key guard)
  now pass against a copy of the real `drivers.yaml`; the live config was never
  touched. The split now takes only the text *inside* the brackets.
- `Set-AgySandbox` gained a no-match guard (previously it rewrote nothing while
  reporting success). `sandbox:` is confirmed to appear exactly once, in the agy
  block, so the toggle targets the right key.

**`install-scheduler.ps1` — a `-NodePath` parameter plus a loud warning.**

`(Get-Command node).Source` resolves to where the *admin* shell sees node —
usually a per-user install under `C:\Users\<you>` that the restricted account
cannot read. `-NodePath` now overrides it, the path is validated with
`Test-Path`, and registering `-RunAsUser` without one prints a WARNING naming the
exact path the task will try to execute and the machine-wide alternative.

**`setup-restricted-account.ps1` — re-runs are idempotent.**

Re-running once added a **duplicate** deny ACE on `D:\`, a duplicate allow ACE
per repo, and a **second copy of the SID** in `SeBatchLogonRight`. Each step now
checks for an identical ACE/SID first and skips (`already denied — nothing to
do`), so the admin change runs only when there is something to change.

**`config/agy-permissions.md` — stale routing block corrected.**

The manual-apply section still showed `routing: complex_agent: agy` (singular).
Updated to the array form with a note that `agy-access.ps1 -Apply`/`-Revert`
maintain it.

### TQ-9 / TQ-10 — the last two vacuous tests closed (`src/cli.test.ts`, `src/core/__tests__/verifier.test.ts`)

Two run-1 low findings the parts plan had not scheduled, closed because Part 7 is
the final sweep and both are one-liners:

- **TQ-10:** the `it('should be defined')` import-smoke in `verifier.test.ts`
  added nothing — the import at the top of the file already fails loudly if the
  module cannot load. Removed.
- **TQ-9:** `cli.test.ts`'s "the real data/reports is left alone" asserted the
  temp file the *previous* test had just created — tautological, and it never
  looked at the real file. The assertion is now folded into the export test:
  snapshot the **real tracked** `data/reports/ledger.csv` before the export runs,
  assert it is byte-identical (or still absent) after. The claim is now actually
  checked.

---

## Not done (documented, with reasons)

| Item | Disposition |
|---|---|
| **FTS5 itself** (PERF-5) | Deferred as a tracked decision with a trigger (~10k rows OR ~50 MB searchable text). FTS5 stays the documented upgrade path; the shadow table + dual-write/trigger surface is not worth paying today for a 231-row store |
| Worker repos cannot gitignore `.shanauto/` on their side — only the orchestrator's `diffStat`/FORBIDDEN/commit-path excludes them; a worker's own `git add -A` could still sweep a brief | consciously unchanged (P6) — worker-side ignore is not ours to set |
| `notify()` drops a legitimate body until `NTFY_TOKEN` is set (title-only otherwise) | consciously unchanged (P6) — the safe direction |
| TUI settings write is atomic but not *locked* against a concurrent hot-reload | consciously unchanged (P6) — atomic rename already wins the race |
| `writeSetting` refuses a key that is absent from the file | consciously unchanged (P6) — the settings screen only edits schema-exposed values |
| Deployment scripts edit YAML/JSON in place (no atomic write); `agy-access.ps1`'s `repos.yaml` default-repos regex still assumes unquoted, comment-free `path:` lines | documented — one-shot operator scripts with explicit `-Repos` override; the regex matches the shipped file today |
| TQ-6 — the source-sniffing regression tests (`data-safety`, `tui-safety`, `prompts`) read `process.cwd()/src/…` | consciously unchanged — the brittleness is the price of pinning critical contracts (atomic export, no temp left behind) in source form; rated low by the audit |

---

## Follow-up port (cd721f8): the agy settings BOM write

After Part 7 landed, a diff against the older `D:/repos/shanauto` clone surfaced
one residual the §9.7 pass had missed: that clone's `cd721f8` fixes the agy
settings write in a way this repo did not have. Ported as a Part 7 follow-up:

- **`scripts/agy-access.ps1` `Write-Json`** writes UTF-8 **without** a BOM via
  `System.Text.UTF8Encoding($false)` + `[System.IO.File]::WriteAllText`, replacing
  `Set-Content -Path $Path -Encoding UTF8`. Under Windows PowerShell 5.1 that
  cmdlet writes UTF-8 *with* a BOM; agy parses settings.json strictly, so a
  leading U+FEFF made the file invalid JSON and it loaded **no** permissions —
  auto-denying every command, indistinguishable from a missing allow-rule. The
  script that grants shell access was silently revoking it.
- **`src/index.ts` doctor()** now refuses to call a corrupted permission file
  healthy: a BOM prefix → `fail`, unparseable JSON → `fail`, empty allow-list →
  `warn`, else `ok` with the allow/deny counts. It reuses `agySettingsPath()`
  from the agy driver (the Part 5 canonical path honouring
  `SHANAUTO_AGY_SETTINGS`) rather than cd721f8's hardcoded path, so the check and
  the driver's pre-flight can never disagree about where the file lives.
- **Regression guard** — the two `loose-ends.test.ts` assertions are ported into
  `src/__tests__/agy-permissions.test.ts` ("the script that grants shell access
  must not revoke it"), so the `-Encoding UTF8` line can never quietly come back.

Suite: 747 passed / 53 files, typecheck clean.

---

## Design & architecture decisions

1. **PERF-5: a deferral is a decision, so it got a trigger, not a shrug.**
   The audit's two acceptable outcomes were FTS5 *or* codified deferral. The
   codification only counts if it tells the next reader when to revisit — hence
   the measured baseline, the byte-based cost model, and the trigger in the
   function's own docblock. The audit's "~11k rows" number was row-count
   extrapolation from a table whose real cost driver is searchable bytes (journal
   days are ingested whole); stating the trigger in bytes is the correction that
   keeps the deferral honest.

2. **§9.7's real find was that the nuke button was a no-op.** The rotation
   toggle is the pair to the allow-list grant: `-Apply` grants agy command access
   *and* routes complex work to it; `-Revert` is the "nuke" that both strips the
   permissions and stops routing to agy. Because it targeted a dead key, every
   `-Revert` since the routing moved to arrays had silently failed to take agy
   out of rotation — while printing "DONE." A throw-if-absent guard turns the
   silent no-op class into a loud failure, and the same lesson was applied to
   `Set-AgySandbox`.

3. **The rotation rewrite was validated against a copy, never the live config.**
   A broken regex that corrupts `drivers.yaml` is worse than the documented no-op
   it replaces. The new logic was exercised in-memory against a copy of the real
   file (plus synthetic single-agent/empty cases and the missing-key guard)
   before it was committed; the live `config/drivers.yaml` was byte-verified
   untouched. The functional test caught a real leak (key text into the agent
   list) that a syntax check alone would have passed.

4. **Idempotency is a property of the second run.** Duplicate ACEs and a
   duplicated SeBatchLogonRight SID are invisible to a one-time run and only
   surface on the re-run — which is exactly when an operator most needs the
   script to be calm. The guards (match identical ACE by control-type +
   identity + rights + inheritance; match the SID before appending) make the
   admin change conditional on there being something to change.

5. **A vacuous test is a false promise, not just dead weight.** TQ-9's test *named*
   the right contract ("the real data/reports is left alone") and then asserted
   the wrong thing (the temp file). That is worse than no test: it reads as
   coverage. Folding the snapshot-assert-unchanged check into the export test
   makes the name honest.
