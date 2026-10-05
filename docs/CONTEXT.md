# ShanAuto — context briefing

**Purpose of this file:** paste it into an assistant that has never seen this
project, so it has enough grounding to write a correct, specific work request
instead of a generic one. Written for a machine reader; density over polish.

---

## 1. What the system is

A personal automation system that turns written ideas into real, verified GitHub
commits without supervision.

The owner wants ~30 genuine contributions a day across personal projects, and
struggles to sustain that manually. So: write a paragraph describing a goal, and
the system decomposes it into commit-sized tasks, has a coding agent implement
them one at a time, refuses to commit anything that fails the build, and pushes
what survives.

It is **not** a contribution-graph padder. The commit gate is the core of the
design, and rejecting work is considered correct behaviour.

- Repo: `github.com/shan3520/shan-auto`. Development happens in a private
  working copy whose history carries the operator's own paths, project names and
  ideas; what is published is the clean tree, so the two are separate
  repositories rather than one with a rewritten history.
- Platform: Windows 11, PowerShell + Git Bash
- Runs on a normal PC. No paid services, no local LLM, no Docker.

---

## 2. Architecture

```
ideas/inbox.md
   ↓  (brain: an LLM call, returns JSON)
epics → milestones → micro-tasks           stored in SQLite
   ↓  (allocator picks today's batch, weighted across repos)
   ↓  (senior: agy writes a brief for the task)
agent writes code in the repo           (intern: opencode, in both size pools)
   ↓
THE GATE  ── files changed? protected paths? scope cap? diff big enough?
          ── no dead exports? repo verify_cmd passes?
          ── senior reads the diff: are these tests capable of failing?
   ↓ pass                      ↓ fail
commit + push            scoped rollback, retry or park
```

**The orchestrator contains no AI.** It is deterministic TypeScript. Every
"intelligent" step is a round-trip to an external CLI that returns text, which is
then parsed and schema-validated. This is deliberate and should stay true.

### Stack

- Node 22 + TypeScript, ESM, run via `tsx` (no build step)
- `node:sqlite` (built-in) for the ledger — **not** better-sqlite3, deliberately
- `execa` (subprocesses), `simple-git`, `zod` (validation), `yaml` (config)
- `vitest` — 1,896 tests across 80 files (2026-10-05)
- `playwright` present but the browser channel is disabled

### Layout

```
config/     repos.yaml (allowlist, gitignored; see repos.yaml.example), system.yaml (targets, limits), drivers.yaml (tools), prompts/
ideas/      inbox.md ← human input, archive/
data/       shanauto.db, reports/, runs/*.jsonl, artifacts/ (raw model responses)
state/      KILLSWITCH, run.lock (empty unless paused or mid-run)
src/
  drivers/  contracts.ts + one module per external tool  ← the swap point
  core/     planner, allocator, router, executor, verifier, reporter, resolver, prune, deadexports, …
  ledger.ts git.ts config.ts util.ts schemas.ts logger.ts index.ts (CLI)
scripts/    triage.ts, agy-access.ps1, install-scheduler.ps1, setup-restricted-account.ps1, probe-*.ts
docs/       MANUAL.md (how to operate), DECISIONS.md (why it is built this way, dated), CONTEXT.md (this file)
```

### The drivers

| Driver | Role | What it is | Notes |
|---|---|---|---|
| `agy` | **senior**: plans (`brain.active`), briefs every task, reviews before push | Antigravity CLI, `%LOCALAPPDATA%\agy\bin\agy.exe` | **not** the IDE launcher; writes no code under the shipped routing; `sandbox:false`, protection is the allow-list (DECISIONS.md) |
| `opencode` | **intern**: implements every task; registered fallback brain | `opencode run` CLI, Google AI Studio | in both size pools; its own quota |
| `antigravity` | handoff to a human | Antigravity IDE launcher | `mode: handoff`, not scriptable |

The chat channel (`chatgpt`) is registered but disabled.

Routing is by role, then by job size, never by project. agy plans, briefs and
reviews; opencode writes all of the code — both size pools point at it, so the
reviewer is never marking its own work. A third agent, `copilot`, was removed on
2026-08-15. The two remaining authenticate against **different quotas**, and quota,
not capability, is the ceiling. Any driver is swapped via one line in
`config/drivers.yaml`.

---

## 3. Current state (2026-10-05)

- **Durable memory is built** (`docs/FEATURE-1-MEMORY.md`). It ingests git
  history, `docs/DECISIONS.md` and run outcomes; compresses closed periods into
  rollups; answers questions via `sa ask` (deterministic retrieval plus exactly
  one provider call); exports to JSONL. Verified at 11,000 memories across three
  synthetic years. `data/memory/` holds the ingested history; it is gitignored,
  because it names the operator's own projects, so it is backed up by hand.
- **Run by hand.** Scheduling is optional: `scripts/install-scheduler.ps1`
  registers four Windows Task Scheduler jobs — plan 06:30, run 07:00, report
  19:00, prune 19:15 (prune after report, so a day is always summarised before
  any of its raw material can age out) — and the operator currently runs without
  them. No killswitch is set — `state/` holds only the transient run.lock while a
  run is in flight.
- **Several projects are configured**, Python and Go, in `config/repos.yaml` —
  gitignored, because it names paths on the operator's disk;
  `config/repos.yaml.example` shows the shape. ShanAuto itself is **not** a repo
  and must not be — the machine is not the work.
- **Senior: `agy`** on `gemini-3.1-pro-high` (fallback `gemini-3.6-flash-high`)
  plans, briefs and reviews. **Intern: `opencode`** on `opencode/big-pickle`
  implements every task (config/drivers.yaml).
- **1,896 tests across 80 files; `npm run typecheck` clean.**
- **The 2026-08-10 deep audit is closed.** All seven fix parts landed (see
  `docs/audit-fixes/`). One finding, PERF-5, is deliberately deferred with a
  measured trigger for revisiting it.

---

## 4. Hard constraints — a proposal that violates these is wrong

1. **The orchestrator stays deterministic.** No LLM calls outside a driver.
2. **No paid services.** Free tiers only. Provider quota, not compute, is the
   binding constraint — budget ~2 provider requests per commit.
3. **The repo allowlist is absolute.** `config/repos.yaml` gates every path.
4. **The gate cannot be weakened.** A repo's `verify_cmd` always runs; a task may
   only add a narrower check on top, never substitute.
5. **Agents never run git.** The orchestrator owns all git operations. No
   force-push, no history rewriting, never touch `.git/`, CI workflows, `.gitignore`.
6. **Rollback and commit are scoped** to exactly the files the gate inspected.
7. **Tool-specific code lives behind `src/drivers/contracts.ts`.** Swapping a tool
   must remain a one-line config change.
8. **Windows-first.** Paths, shell quoting and `.cmd` shims all matter.

---

## 5. Conventions in this codebase

- Comments explain **why**, especially where the obvious approach was wrong.
  Several carry a specific incident and date. Match that register; do not add
  comments restating what the code says.
- Model output is untrusted input: archive it, parse it, zod-validate it, repair
  it. A prompt is a request, not a constraint — **rules are enforced in code too**.
- Tests are written around failures that actually happened, and named for the
  behaviour. Several exist purely as regression guards for real incidents.
- Every subprocess uses `stdin: 'ignore'` (a piped stdin makes these CLIs hang
  forever), a hard timeout, and `killSignal: 'SIGKILL'`.
- Prefer failing loudly and specifically over degrading silently.

---

## 6. Known limits and past failure modes

These shape what is feasible; a good proposal accounts for them.

- **Quota, not compute, is the ceiling.** gemini-3.6-flash free tier is 20
  requests/day. Groq's 8k TPM cannot fit opencode's ~38k tool preamble at all.
- **agy runs with shell access and no sandbox** (an explicit owner decision, see
  `docs/DECISIONS.md`). Its protection is a default-deny allow-list. agy also
  ignores the process working directory — it needs `--add-dir`.
- **The gate catches dead code, not dead dependencies.** An agent once installed a
  package nothing imported; it passed.
- **`npm test` runs test files the agent wrote** — arbitrary code execution by
  design. Only OS-level isolation prevents it, which is not in place.
- **A failed task deadlocks everything downstream of it.** There is detection and
  recovery (`sa retry --failed`, `scripts/triage.ts`), added after 8 failures
  froze 38 of 59 queued tasks.
- **The planner over-decomposes.** Its worst habit is emitting "define the type" /
  "write the helper" / "test the helper" and never scheduling the task that *uses*
  any of it. Two thirds of one day's commits were code nothing called. There are
  now three defences: a prompt rule, a mechanical planner check, and a
  `DEAD_EXPORT` gate rejection.
- **The ChatGPT/Playwright input channel is built but disabled and never verified
  working.** Automating that web UI is against OpenAI's terms. Ideas currently
  arrive by editing `ideas/inbox.md`.
- **Do not hand-edit a repo while a run is in flight.** The system assumes it is
  the only writer.

---

## 7. Guidance for whoever writes the actual request

A good work request for this codebase:

- **States the outcome and where it plugs in.** Name the existing file and function
  the new code will be called from. Work that nothing calls is rejected by the gate.
- **Says how it will be verified.** What command proves it works? What test?
- **Respects the driver boundary.** Anything tool-specific goes behind an interface.
- **Accounts for quota.** A feature adding several provider calls per task is
  probably not viable.
- **Is explicit about scope.** "Also refactor X while you're there" produces
  scope-blowout rejections.
- **Says whether it should be built directly, or decomposed into `ideas/inbox.md`
  for the system to build itself.** These are different requests. Non-trivial
  features needing coherent design across files are poor candidates for autonomous
  decomposition — that is where the planner is weakest.

Useful to state explicitly: whether the feature must work while the system is
**off**, whether it changes the gate, and whether it touches security posture
(agy permissions, the allowlist, verify commands).
