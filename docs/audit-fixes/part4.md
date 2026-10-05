# Part 4 — Documentation refresh (DOCS residuals)

`docs/CONTEXT.md` was a week out of date and asserted things that are no longer
true — the old repo path, opencode as the brain, two agents where there are
four, 130 tests where there are 719. This part refreshed it, swept the stale
`D:/repos/shanauto` path out of every *instructional* reference, and verified
the DOCS-04 prune claim against the scheduler script. `npm run typecheck` clean,
full suite green (719 passed / 52 files), one commit. No production code and no
test code changed.

---

## Done

### DOCS-10 — `docs/CONTEXT.md` refreshed to match reality (2026-08-11)

- **Repo path** — `D:/repos/shanauto` → `D:/repos/shanauto` (the git
  remote, `github.com/shan3520/shanauto`, was already correct).
- **"The two agents" → "The drivers"** — the old section claimed opencode was
  the brain and only two agents existed. The table now lists all four registered
  agents (agy = planner + complex, opencode = simple + fallback brain, copilot =
  complex, antigravity = handoff), the disabled chat channel, and routing by job
  size (complex → agy/copilot, simple → opencode).
- **Stack line** — test count 302 → **719 green across 52 files**.
- **Layout block** — `state/` described as holding only the transient run.lock
  unless paused; `core/` and `scripts/` lists brought closer to what is actually
  there (resolver, prune; setup-restricted-account.ps1, probe-*.ts).
- **"Current state"** — rewritten for 2026-08-11: the system is **live and
  scheduled** (four tasks, see DOCS-04), no killswitch set, one enabled repo
  (`example-api` — the claim that repos.yaml contained *shanauto itself* was stale
  and wrong by design), brain `agy` on `gemini-3.1-pro-high`, and the audit-fix
  program in progress (parts 1–3 committed, 4–7 pending).

### DOCS-04 — prune scheduling verified

Confirmed in `scripts/install-scheduler.ps1:69`: `ShanAuto Prune` runs `prune`
at **19:15**, deliberately after the 19:00 report "so a day is always summarised
before any of its raw material can age out". `scripts/triage.ts` contains no
prune (grep) — the ISSUES.md O19 line already names `install-scheduler.ps1`
correctly, a reconciliation Part 1 performed. Nothing further to fix; the ISSUES.md
header was updated so the register no longer presents itself as last updated
2026-08-08 when its newest entry is 2026-08-10.

### Stale-path sweep

Three references told a reader to run a command against the repo's old location
and were corrected to `D:\repos\shanauto`:

- `README.md` (setup-restricted-account.ps1 example)
- `scripts/setup-restricted-account.ps1` (`.EXAMPLE` help block)
- `scripts/agy-access.ps1` (`.EXAMPLE` help block)

Every remaining `D:/repos/` reference was classified and left intentionally
(see decision 2 below).

---

## Not done (deferred to later parts)

| Observation | Where it lands |
|---|---|
| `docs/DECISIONS.md:193` "Workspace `D:\repos\shanauto`" is a historical snapshot of the applied agy allow-list; the **live** `%USERPROFILE%\.gemini\antigravity-cli\settings.json` has since diverged (`trustedWorkspaces` = `D:\xeno-crm`, `D:\xeno-crm-ui`; example-api `read_file`/`write_file` grants) | **Part 5** (§9.1 agy permissions) |
| `config/agy-permissions.example.json` still allows `command(npm run lint)` — a script Part 3 removed; the live settings.json allows it too. Harmless (an allowed command that now fails), but the template is Part 5's file to reshape | **Part 5** |
| §9.4 handoff gitignore; §9.6 `notify()`; §9.8 TUI `settings.ts` write path | **Part 6** |
| PERF-5 FTS5; PERF-6 chunked `exportMemory`; §9.7 deployment scripts; final audit mapping | **Part 7** |

---

## Design & architecture decisions

1. **Historical records are not rewritten; stale instructions are.** The
   DECISIONS.md "What was applied" table and ISSUES.md's past test counts record
   states as they were — editing them to "current" would falsify history. Only
   current-state claims were updated. The three corrected references were
   different: they are *commands a reader may run*, so a stale path in them is a
   live bug, not a record.

2. **The sweep is by intent, not by string.** Each surviving `D:/repos/`
   reference was classified rather than blindly replaced: real operator config
   (`config/repos.yaml` — `D:/repos/example-api` verified to still exist), a
   historical why-comment (`src/tui/ui.ts`, narrating a past path-concatenation
   bug), test fixture strings (`scaffold`/`journal-memory-chain` tests), real
   ingested memory data (`data/memory/*.jsonl`), and the already-committed part
   docs. None of those describes the repo's current location.

3. **Docs were verified against the machine, not against other docs.** The
   scheduler state came from querying the live scheduled tasks (all four
   registered and enabled, including Prune at 19:15), the "no killswitch" claim
   from an empty `state/`, the agy-workspace divergence from reading the actual
   `settings.json`, and example-api's existence from the filesystem. The refresh
   reports what is, not what a doc claimed.
