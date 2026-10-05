# ShanAuto — operating manual

Every command here was run against this install before being written down.

The README explains *why* the system is built the way it is. This explains *how to
operate it*.

---

## 1. What it does

You write a paragraph. It turns that into small, commit-sized tasks, has a coding
agent implement them one at a time, refuses to commit anything that fails the
build, and pushes what survives to GitHub.

```
ideas/inbox.md → epics → milestones → micro-tasks → agent → THE GATE → commit → push
```

Your daily involvement is about **2 minutes in, 5 minutes out**.

---

## 2. On and off

The system has **two independent switches**. Both must be on for it to work, which
is deliberate — one stops the timer, the other stops execution.

### Check which state you are in

```bash
npm run status
```

```bash
powershell -c "Get-ScheduledTask -TaskName 'ShanAuto*' | Select-Object TaskName,State"
```

### Turn OFF

```bash
npm run sa -- stop
```

```bash
powershell -c "Get-ScheduledTask -TaskName 'ShanAuto*' | Disable-ScheduledTask"
```

The first sets `state/KILLSWITCH`, so even a manual `npm run run` refuses. The
second stops the scheduled jobs firing at all. Use both — either alone leaves a gap.

A run already in flight stops at its next task boundary, never mid-commit.

### Turn ON

```bash
npm run sa -- resume
```

```bash
powershell -c "Get-ScheduledTask -TaskName 'ShanAuto*' | Enable-ScheduledTask"
```

### Remove the schedule entirely

```bash
powershell -c "Get-ScheduledTask -TaskName 'ShanAuto*' | Unregister-ScheduledTask -Confirm:$false"
```

Reinstall with `powershell -File scripts/install-scheduler.ps1`.

Nothing is lost while off. The ledger, commits and history are untouched.

---

## 3. The daily rhythm

| Time  | What happens | Who |
|-------|--------------|-----|
| any   | Add a paragraph to `ideas/inbox.md` | **you, ~2 min** |
| 06:30 | Shapes new ideas, tops up the backlog | auto |
| 07:00 | Works the day's tasks, gated and paced | auto |
| 19:00 | Writes `data/reports/<date>.md` | auto |
| 19:05 | Skim the report, glance at failures | **you, ~5 min** |

**If `ideas/inbox.md` is empty or missing, 06:30 and 07:00 do nothing.** That is
the single most common reason for an idle day.

### Writing an idea

One idea per `##` heading. `repo: <id>` pins it to a repo from `repos.yaml`.

```markdown
## Add rate limiting to the API

repo: my-api

The public endpoints have no rate limiting. Add a token-bucket limiter as
middleware, configurable per-route, with the limits in config rather than
hard-coded. Include tests for the limiter itself and for a route using it.
```

Be concrete about **what should exist when it's done**. Vague ideas produce vague
tasks, which fail the gate.

---

## 4. Command reference

Everything is `npm run sa -- <command>`, with shortcuts for the common ones.

### Daily

| Command | What it does |
|---|---|
| `npm run status` | backlog, runway, deadlocks, what needs you |
| `npm run doctor` | preflight: repos, agents, brain, GitHub, guards |
| `npm run plan` | inbox → epics → milestones → micro-tasks |
| `npm run run` | execute today's batch |
| `npm run sa -- run --dry` | show what *would* run, change nothing |
| `npm run report` | re-emit today's report |

### Starting a project

| Command | What it does |
|---|---|
| `npm run sa -- new <name>` | create the folder, `git init`, first commit, and add it to the allowlist |
| `npm run sa -- new <name> --in <folder>` | put it somewhere other than beside ShanAuto |
| `npm run sa -- new <name> --stack python` | `python`, `typescript`, `javascript` or `go` |
| `npm run sa -- new <name> --no-github` | keep it on this machine — **no** GitHub repository |

**A new project gets a private GitHub repository by default.** That changed on
2026-08-27, and the old behaviour was the wrong way round: `--github` used to be
opt-in, so a project you forgot to pass it to was built, tested and committed
into a folder with nowhere to send any of it. Two projects reached 8 and 7
commits of finished work that way before anyone noticed. The first line of this
program's `package.json` calls it an *"Autonomous daily GitHub contribution
system"*; a project born with nothing to contribute to is that failing quietly.

The repository is **private**. Private repositories do not appear on your public
profile, and their commits only count towards your contribution graph if you
switch on *Settings → Public profile → Include private contributions*.

In the TUI this is **Your projects → Start a new project**, which asks the same
questions one screen at a time.

**About the gate on a new project.** Every project's `verify_cmd` is the promise
that nothing gets committed unless the project still works. On day one there is
nothing to test, so a new project starts with a syntax check — anything stricter
would fail every task before the project exists.

That floor is meant to be temporary, and forgetting to raise it is a real
failure mode, not a hypothetical one: example-api kept its syntax check for two
days after it had 27 tests, three of which were failing, and every one of them
sailed through the gate.

**Since 2026-08-27 a run tightens it for you**, the first time it sees real tests
in a project, and says so plainly:

```
example-ledger has tests now, so its check is stronger from here on.
  was:  python -m compileall -q -x "(node_modules|[.]venv|[.]next)" .
  now:  python -m compileall -q -x "(node_modules|[.]venv|[.]next)" . && python -m pytest -q
```

It only ever does this when the check is still **exactly** the floor `sa new`
wrote — the one value nobody chose. A `verify_cmd` you have edited is yours and
is never touched, which is the same promise `doctor` has always made. `sa doctor`
still reports the situation, and `run --dry` says what it would tighten without
tightening anything.

### Putting an existing project on GitHub

A project made before the default changed — or one you deliberately declined a
repository for and have changed your mind about — can be published at any time.

| Command | What it does |
|---|---|
| `npm run sa -- publish <project>` | create a **private** GitHub repository and push everything it has |
| `npm run sa -- publish <project> --public` | the same, public. Think before you do this. |

In the TUI this is **Your projects → pick the project**, which offers it as a
question rather than a command when that project has nowhere to push.

It refuses a project that already has a remote. Re-pointing `origin` at a fresh
empty repository is how work silently stops arriving where somebody is looking
for it, and nothing here should be able to do that by accident.

Afterwards, every commit that project makes is pushed as it is made. `sa doctor`
tells you which projects still have nowhere to go:

```
example-ledger: git ok, remote MISSING (commits stay local)
            put it on GitHub with: npm run sa -- publish example-ledger
```

**What is not automatic.** A run will never create a GitHub repository on its
own. Publishing happens when you start a project or when you ask for it, never
from an unattended job at 07:00.

### Inspection

| Command | What it does |
|---|---|
| `npm run sa -- route` | preview which agent gets each ready task |
| `npm run sa -- journal` | read the working journal — what was tried, and how it went |
| `npm run sa -- recall "<query>"` | search what has been resolved, and why |
| `npm run sa -- report:weekly` | 7-day rollup with a commit trend |
| `npm run sa -- export-csv` | dump the ledger to `data/reports/ledger.csv` |

### The working journal

As tasks run, the system writes what it asked for, what came back, and what the
gate decided to `data/journal/YYYY-MM-DD.md`. Read it with:

```bash
npm run sa -- journal --days=2
```

This is the fastest way to answer *"what was it actually doing?"* — and it only
reads a file, so it works while the system is switched off.

Three things consume it, which is the point of keeping it:

- **The next task.** Each dispatch now carries the recent journal, so an agent
  can see that an approach was already rejected instead of repeating it.
- **The planner.** It sees why work was rejected, not just what landed.
- **Long-term memory.** `memory:ingest` files each *closed* day, whole, as one
  searchable memory, so `ask` can still reach it years later.

Today's file is never ingested; it is still being written. The journal itself is
not committed to git (it changes mid-run), so run `memory:ingest` to make it
durable.

**Nothing is trimmed.** The agent's full output goes into the journal, and a
closed day goes into memory whole — prompts, replies and verdicts alike. A
separate untouched copy of every agent response is also written to
`data/artifacts/<run>/`, and each result entry carries the path to it.

The only remaining limit is how much is read back *into a prompt* (3000
characters of journal for an agent, 6000 for `ask`). That one is fixed by the
provider, not by preference — a prompt that exceeds it fails outright.

Both `data/journal/` and `data/artifacts/` are gitignored and grow with use.
Roughly 128 KB per busy day, so about 45 MB a year. Delete old folders freely.

### Asking the project what it remembers

```bash
npm run sa -- ask "what do you know about the shanauto project?"
```

```
The shanauto project functions as an agent orchestrator, with development
activity on 2026-08-06 focused on implementing commit ceiling limits for the
allocator, a transition of tasks to the agy agent, updating the CI process to
gate on tests, and scoping agent shell access.
— from 29 matching memories
```

You do not have to use the words that were recorded. *"Can the automation run
terminal commands?"* finds *"Grant agy shell access"*, because queries are
expanded through a vocabulary in **`src/core/aliases.ts`** — edit that file as
the project's own vocabulary grows. Inferred synonyms always score below the
words you actually typed, so an exact match still wins.

`ask` answers from recorded memory only — decisions, incidents, commits and
period summaries — and cites dates. If nothing was recorded it says so rather
than guessing. **One provider request per question**, and none at all when
nothing matches.

Questions it is good at:

```bash
npm run sa -- ask "why does agy have shell access?"
```

```bash
npm run sa -- ask "what went wrong on 2026-08-06?"
```

Keeping memory fed and compressed:

| Command | What it does | Cost |
|---|---|---|
| `sa memory:ingest` | pull commits, `docs/DECISIONS.md` and run outcomes into memory | free |
| `sa remember "<text>"` | record something the system could not observe | free |
| `sa rollup [--period=week]` | compress closed periods into summaries | free |
| `sa rollup --narrate` | add a sentence to each summary | 1 call per period |
| `sa memory:export` | write memory to `data/memory/*.jsonl` | free |
| `sa memory:import` | restore it | free |

**Export regularly.** Memory living only in `data/shanauto.db` is one corrupted
file from zero. The JSONL is one record per line, so even a damaged file
restores everything up to the damage — verified by deleting every memory row and
restoring from it.

`recall` searches commit messages, file paths, exported symbols and SHAs —
including work you did **by hand**, which the system ingests from git history.
Every word must match, so two terms narrow rather than flood.

```bash
npm run sa -- recall "sparkline"
```

```
5 result(s) for "sparkline"
  2026-08-07  38dbf611  external_commit  src/core/reporter.ts
              refactor: Refactor sparkline styling
```

It works **with the killswitch set** — like `status`, `route` and `report`, it
only reads. Asking why something was parked is exactly what you do while the
system is stopped.

### Recovery — the ones you will actually need

| Command | What it does |
|---|---|
| `npx tsx scripts/triage.ts` | classify every failed task (dry run) |
| `npx tsx scripts/triage.ts --apply` | resolve them all automatically |
| `npm run sa -- retry <taskId>` | requeue one failed/blocked task |
| `npm run sa -- retry --failed` | revive every failure + unblock chains behind them |
| `npm run sa -- retry <taskId>` | **unpark** a lone parked task (blocked, not failed) |
| `npm run sa -- drop <taskId> "reason"` | retire a task whose work already exists |
| `npm run sa -- resolve <taskId>` | verify + commit a task you finished by hand |
| `npm run sa -- unlock` | clear a stale `state/run.lock` |

**You should not need any of those.** Since 2026-08-27 the TUI offers the same
recovery as buttons: **What is it doing?** shows the status screen and then, if
anything has stopped, a menu:

```
Some work has stopped

  ❯ Put the stopped jobs back                    4
    Plan again: Rule-based spending categorization
    Back
```

The first runs `retry --failed`; the others run `retry <milestone>` for one
piece of work each. The main screen says so too, instead of reporting an empty
queue as though there were nothing to do:

```
● Running   today 0/30   jobs waiting 0   stopped 1   projects 3
1 job(s) and 1 piece(s) of work have stopped. Nothing else is queued, so a run
would find nothing to do.
Choose "What is it doing?" to see why, and to put them back.
```

### Control

| Command | What it does |
|---|---|
| `npm run sa -- stop` / `resume` | killswitch on / off |
| `npm run sa -- plan:one` | decompose exactly one more milestone |
| `npm run agy:status` | is agy's shell access on? |
| `npm run agy:nuke` | revoke agy's shell access immediately |

---

## 5. Configuration

Three files, re-read at the start of every run.

### `config/repos.yaml` — the allowlist

The system **refuses to touch any path not listed here**. This is a hard boundary.

```yaml
repos:
  - id: my-api
    path: D:/repos/my-api
    branch: main
    stack: typescript
    verify_cmd: npm run typecheck && npm test
    agent_check_cmd: npm test
    enabled: true
    weight: 3          # relative share of the daily budget
```

`verify_cmd` is the gate. **Make it strict.** It always runs — a task cannot
substitute a weaker check, only add a narrower one on top.

`agent_check_cmd` is the one command the **worker** is allowed to run on itself
before it hands the work in. It is optional, and it is not the gate — `verify_cmd`
still decides whether anything is committed.

It exists because the gate's own command cannot be handed to the worker. agy
checks a command against its permitted list **word for word**: `npm test` is
permitted, `npm test -- --watch=false` is a different string and is refused, and
there is nobody sitting there to approve it. `verify_cmd` above joins two
commands with `&&`, which matches nothing at all.

Leave it out and the worker is told to run nothing, which is safe and blind. On
2026-08-15 that is exactly what happened: the worker picked its own test command,
was refused, finished anyway, and handed in code that broke three tests it had
never been able to see. The gate caught it and rolled it back — a wasted job
rather than a bad commit, but wasted every time.

So if you set it:

- **one command**, no `&&`, no `;`
- the **whole** suite, not one test file — a file name can never be permitted
- it must appear **exactly** in `config/agy-permissions.example.json`, then run
  `scripts/agy-access.ps1 -Apply`

If the string does not match, nothing breaks loudly — the worker is simply refused
and goes back to guessing. **Doctor** is what tells you: it reads the permission
file that is actually in force and says, per project, either *"the worker may run
its own check"* or that the command is not permitted, with the exact line to add.

### When a job says "denied the tool permission"

A refusal no longer ends the task. The next attempt is told exactly which
command was refused and to use its own file tools instead, and most refusals
are for something the agent never needed a shell for — reading a file, writing
a scratch file, deleting one, setting a variable. It usually routes around it
and the work lands.

It is still worth reading, because the refused command is recorded and listed
for you: a command being refused every day across many jobs is a permission
list worth widening. The difference is that the work no longer waits for you to
do it.

The worker asked to run something it is not permitted to run. The run log now
names it:

```
WARN  agy was denied a tool permission on T7vkf0sqpj5 — letting the gate judge the result.
      it wanted to run:  alembic revision --autogenerate -m "document groups" --rev-id 0003_document_groups
      to allow that, add exactly this line to config/agy-permissions.example.json
      then run scripts/agy-access.ps1 -Apply:
          command(alembic revision --autogenerate -m "document groups" --rev-id 0003_document_groups)
```

Before you paste that in, read the command and decide whether you want it run at
all — this is the list that keeps the worker away from the rest of your machine,
and the line above is a suggestion, not a recommendation.

Note the trap in that example: the message it passes to `-m` is different every
time, so no fixed line can ever permit it. A command that varies its own
arguments cannot be allow-listed. The worker is told to produce such files by
hand instead, and if you see the same varying command refused repeatedly, that is
what it means — not a missing rule.

The worker's own message never says which command; it prints a literal
`command(<target>)` placeholder. ShanAuto recovers the name from the worker's
transcript, which is best-effort: if it cannot, it says so rather than guessing.

### `config/system.yaml` — pacing and thresholds

| Key | Default | Meaning |
|---|---|---|
| `daily_target` | 30 | tasks to land per day |
| `max_daily_commits` | 40 | hard ceiling; a bug cannot exceed it |
| `work_hours` | 00:00–23:59 | nothing commits outside this |
| `limits.max_attempts` | 4 | the FLOOR on retries, not the budget — see below |
| `limits.max_files_per_task` | 4 | scope cap |
| `limits.min_insertions` | 3 | below this a diff is "trivial" |
| `limits.forbid_dead_exports` | true | reject exports nothing calls |
| `backlog.min_ready` | 30 | below this, auto-plan more |
| `brain.model` | gemini-3.1-pro-high | the planner |

**Note:** the shipped `system.yaml` has no `brain` block — the planner defaults to `opencode` on `gemini-3.1-flash-lite` unless you add it. The table above documents the values this install runs with after the 2026-08-07 brain migration.

`work_hours` does **not** handle a window crossing midnight. Keep `end` later
than `start`, max `"23:59"`.

#### `max_attempts` is a floor

It used to be a budget: a task got that many tries and was then failed. It is
now the minimum. Past it, a task keeps going for as long as each attempt fails
in a **new way**, and stops the moment a failure repeats — because two attempts
that fail identically have learned nothing and a third will not either. A hard
ceiling of 12 stops a task that somehow changes its failure every single time.

Raising it makes a task try harder before the "is it still moving?" rule takes
over. Lowering it below 2 is the one setting worth avoiding: a first failure
should always earn a second look.

### `config/drivers.yaml` — which tools are used

Swapping a tool is one line. `complex_agents` / `simple_agents` split work by size
(as lists); set both to the same id to use one agent for everything.
Legacy singular keys `complex_agent` / `simple_agent` are still accepted for
back-compat but the lists are preferred.

Two coding agents are registered, on **separate quotas** — which is the point,
since requests-per-day is what limits this system, not capability.

| Agent | Signs in via | Role |
|---|---|---|
| `agy` | Antigravity suite | complex (heavy edits, multi-file) |
| `opencode` | Google AI Studio key | simple (small edits, config, docs) |

GitHub Copilot was a third agent until 2026-08-15. Its quota ran out and would
not reset until 2026-09-01, and an exhausted agent is worse than an absent one:
work still routed to it and came back failed. It was removed rather than left
registered. `config/drivers.yaml` says how to bring it back.

**Each side of that split is now one agent deep.** If agy is out for the day, no
complex work runs at all — there is nobody to hand it to. Nothing is lost; those
jobs sit untouched and wait for tomorrow. `npm run sa -- route` shows which agent
each waiting job would get, without running anything, and the day's report names
any agent that went out.

---

## 6. When something goes wrong

### The report shows lots of failures

```bash
npx tsx scripts/triage.ts
```

Shows what it would do without doing it. Then `--apply`. It classifies:

- `NO_CHANGES` → the work already exists → **dropped**
- `DEAD_EXPORT` → helper with no consumer, unbuildable → **dropped**
- `TRIVIAL` → below the minimum diff → **dropped**
- `VERIFY_FAIL` → a genuine bug → **retried**

### "parked before dispatch" in the log or report

The task claimed it would create something that **already exists** by the time it
ran — usually because you built it by hand while the task sat queued. It was
parked without spending a provider request, which is the entire point.

```
[T4x9q] parked before dispatch — "sleep" was already exported by abc12345 (add sleep helper)
```

The report counts these as `superseded_parked` and `provider_requests_saved`.

**If it was wrong**, unpark it — parked tasks are `blocked`, never dropped:

```bash
npm run sa -- retry T4x9q          # unpark ONE parked task
```

```bash
npm run sa -- retry --failed      # revive EVERY failure + unblock chains behind them
```

To see the reasoning behind any park:

```bash
npm run sa -- recall "parked"
```

A park should be rare and specific. If many tasks park at once, the planner is
producing claims that are too broad — check what `sa recall` says superseded them.

### "N task(s) DEADLOCKED behind a failed dependency"

A failed task freezes everything downstream of it. This is the fix:

```bash
npm run sa -- retry --failed
```

Left alone, deadlocked tasks never run and quietly inflate your runway figure.

### Nothing ran

Check in this order:

1. `npm run status` — killswitch active? backlog empty?
2. Outside `work_hours`?
3. `state/run.lock` present with no run going? → `npm run sa -- unlock`

### Every task suddenly fails

Almost always a **red test suite**, because `verify_cmd` runs `npm test` and a
broken suite fails every task's gate, not just its own.

```bash
npm run typecheck && npm test
```

Fix the suite first; everything else follows.

### Commits land but the graph stays grey

The commit email must be **verified on your GitHub account**.

```bash
git log --format='%ae' | sort | uniq -c
```

---

## 7. Adding a new project

1. Add it to `config/repos.yaml` with a **strict** `verify_cmd`.
2. `npm run doctor` — confirms it is a git repo with a remote.
3. Write an idea in `ideas/inbox.md` with `repo: <that id>`.
4. `npm run plan`
5. `npm run sa -- run --dry` — read the tasks before letting it loose.
6. `npm run run`

`weight` controls its share of the daily budget: weight 3 gets three times the
tasks of weight 1.

---

## 8. What it will not do

Guardrails coded in, not merely intended:

- Touch any path outside `config/repos.yaml`
- Exceed `max_daily_commits`, however badly something misbehaves
- Commit outside `work_hours`
- Commit anything failing the repo's `verify_cmd`
- Commit an export nothing references
- `git push --force`, rewrite history, or touch `.git/`, CI workflows, `.gitignore`
- Run two runs at once (`state/run.lock`)
- Discard your uncommitted work — dirty trees are **stashed**, recoverable via
  `git stash list`

Rollback and commit are both scoped to the exact files the gate inspected, so
editing something else mid-run leaves it alone.

**Do not hand-edit a repo while a run is in flight.** The system assumes it is the
only writer. Either work outside `work_hours`, or `npm run sa -- stop` first.

---

## 9. Known limits

Worth knowing before they surprise you.

**Provider quota is the binding constraint**, not compute. Budget ~2 requests per
commit. Free tiers are request-per-day limited; when one is exhausted the run
stops cleanly and says so.

**agy and opencode use different quotas.** If one is exhausted, switch
`complex_agent` / `simple_agent` in `drivers.yaml` to the other.

**agy has shell access with no sandbox** (see `docs/DECISIONS.md`). Its protection
is a default-deny allow-list. `npm run agy:nuke` revokes it instantly.

**`npm test` runs test files the agent wrote.** That is arbitrary code execution
by design, and no command allow-list prevents it. Only OS-level isolation does —
`scripts/setup-restricted-account.ps1`.

**The chat channel is disabled.** `chat.enabled: false` in `drivers.yaml`. Ideas
go in via `ideas/inbox.md`. The browser driver exists but has never been verified
working, and automating the ChatGPT web UI is against OpenAI's terms.

**The gate catches dead code, not dead dependencies.** An agent once installed a
package nothing imported and it passed. Skim `package.json` diffs.

---

## 10. Files

```
config/     repos.yaml, system.yaml, drivers.yaml, prompts/
ideas/      inbox.md ← you write here, archive/
data/       shanauto.db (the ledger), reports/, runs/, artifacts/
state/      KILLSWITCH, run.lock
docs/       MANUAL.md, DECISIONS.md
scripts/    triage, agy-access, install-scheduler, probes
src/        drivers/ (swap point), core/, ledger, git, index
```

`data/runs/<date>.jsonl` is every log line. `data/artifacts/<runId>/` is every raw
model response, archived before parsing — that is where to look when the planner
does something inexplicable.
