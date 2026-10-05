# ShanAuto

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#what-you-need)

Ideas in, verified commits out. You dump a paragraph; the system turns it into
commit-sized tasks, has a coding agent implement them one at a time, refuses to
commit anything that doesn't build, and pushes what survives.

Runs unattended on a normal Windows PC. No paid services, no local LLM, no Docker.

### What it is

An orchestrator for AI coding agents that you point at your own projects. You
write what you want in plain English in `ideas/inbox.md`. A planning model breaks
it into small, complete tasks and stores them in a local SQLite ledger. Each task
goes to a coding agent — [agy](https://antigravity.google) or
[opencode](https://opencode.ai), chosen by how big the job is — and the result is
committed **only** if the target repo's own typecheck and test suite pass. Work
that fails is rolled back without touching anything you had in progress, and
retried or set aside with the reason written down.

It does not write code itself, and it does not trust the code that is written for
it. The planner, the router and the agents are all swappable; the gate is not.

### What you need

- **Windows 10 or 11.** The scheduler and the permission scripts are PowerShell.
- **Node.js 22.5 or later.** It uses the built-in `node:sqlite`.
- **git**, and optionally the [GitHub CLI](https://cli.github.com) (`gh`) for
  creating repos and checking that pushed commits were counted.
- **At least one coding agent CLI:** `agy` or `opencode`. Free tiers are enough
  for modest volume — see [Free-tier reality](#free-tier-reality--read-this-before-raising-daily_target).

### Status

Built for, and run by, one person. It works, it is heavily tested (about 1,900
tests), and it is Windows-first: expect to read the config files rather than
click through a setup wizard. `docs/DECISIONS.md` records why it is the way it
is, including the many things that went wrong first.

> **It commits to your repositories while nobody is watching.** The gate, the
> repo allowlist and the rollback are careful, and they are not a guarantee.
> Read [Containment vs. quality control](#containment-vs-quality-control) before
> pointing it at anything you could not afford to lose.

---

## What it actually does

```
ideas/inbox.md ──► brain (agy) ──► epics ──► milestones ──► micro-tasks ──► SQLite
                                                                                   │
                              ┌────────────────────────────────────────────────────┘
                              ▼
                       allocator picks today's batch (weighted across repos)
                              ▼
                       agent (agy/opencode) implements ONE task
                              ▼
                       ┌──── THE GATE ────────────────────────┐
                       │ • files changed > 0                  │
                       │ • no protected paths (.git, CI)      │
                       │ • within file-count cap              │
                       │ • insertions >= minimum              │
                       │ • verify_cmd exits 0                 │
                       │     (typecheck AND tests)            │
                       └──────────────────────────────────────┘
                          pass ──► commit + push      fail ──► git rollback, retry or park
```

The gate is the point. It is what keeps the contribution graph attached to work
that actually holds up. If a day only yields 18 honest commits, the report says
18 — nothing pads the number.

---

## Quickstart

```bash
npm install
```

Then name your projects. `config/repos.yaml` is the allowlist — the system
refuses to touch any path not in it — and it is **gitignored**, because it holds
absolute paths on your own disk. The tracked copy is the example:

```bash
cp config/repos.yaml.example config/repos.yaml
```

Edit it to point at your own projects, then:

```bash
npm run doctor
```

Fix whatever `doctor` complains about, then:

```bash
npm run plan
```

```bash
npm run sa -- run --dry
```

When the dry run looks right:

```bash
npm run run
```

Then install the schedule (elevated PowerShell, once):

```bash
powershell -ExecutionPolicy Bypass -File scripts/install-scheduler.ps1
```

---

## Daily loop

| When  | What | Who |
|-------|------|-----|
| any   | Drop a paragraph into `ideas/inbox.md` | **you, ~2 min** |
| 06:30 | `plan` — shape ideas, refill backlog if runway < 3 days | auto |
| 07:00 | `run` — execute today's batch, gated | auto |
| 19:00 | `report` — daily markdown + ntfy push | auto |
| 19:05 | Skim `data/reports/<today>.md`, glance at flagged failures | **you, ~5 min** |

Check in any time with `npm run status`.

### Starting a project, and putting it on GitHub

```bash
npm run sa -- new <name> --stack python     # folder, git init, first commit, PRIVATE GitHub repo
npm run sa -- new <name> --no-github        # ...or keep it on this machine
npm run sa -- publish <name>                # give an existing project a repo, and push what it has
```

A new project gets a private GitHub repository **by default**. That flipped on
2026-08-27: `--github` used to be opt-in, and a project you forgot to pass it to
got built, tested and committed into a folder with nowhere to send any of it.
Private repositories only count towards your contribution graph if
*Settings → Public profile → Include private contributions* is on.

A run never creates a repository by itself. Publishing happens when you start a
project or when you ask for it.

### Recovering from failures

**In the TUI:** *What is it doing?* — it shows the status screen, then offers
buttons for anything that has stopped ("Put the stopped jobs back", or re-plan
one piece of work). The main screen says `stopped N` and names the screen to go
to, rather than reporting an empty queue as though there were nothing to do.

From a terminal, the same thing:

```bash
npm run sa -- retry <taskId>   # Requeue one failed/blocked task
npm run sa -- retry --failed   # Revive every failed task + unblock the chains behind them
npm run sa -- retry <msId>     # Plan one stopped piece of work again
```

Most of the time you will not need to. A piece of work whose tasks all failed is
re-planned **once, automatically**, on the next run; after that it waits for you
and says so.

### Reports and exports

The daily dashboard (`data/reports/<date>.md`) includes a new sparkline visualization
to track commit trends, alongside a 7-day velocity figure. Two extras on top:

```bash
npm run sa -- report:weekly
```

```bash
npm run sa -- export-csv
```

The CSV is also refreshed automatically whenever a report is written.

## Backlog runway reporting

The planner automatically monitors the number of days of work in the backlog
("runway"). If the runway falls below 3 days, it will attempt to refill the
backlog during the 06:30 `plan` phase. The report summary includes the current
runway calculation to help you manage your backlog volume proactively.

---

## Configuration

Three files, all hot-read at the start of every run.

- **`config/repos.yaml`** — the allowlist. The system refuses to touch any path
  not listed here. `weight` controls each repo's share of the daily budget.
- **`config/system.yaml`** — targets, ceilings, timeouts, and gate thresholds.
- **`config/drivers.yaml`** — which tools are used. See below.

### Pacing

There is none. Commits land as fast as the gate passes them.

A random 60-300s pause between commits used to sit here, to make the activity
look human-paced. It was removed on 2026-10-04: it shaped nothing but the
timestamps, and at a 30-commit target it spent up to two and a half hours of
every run asleep - time the run's 8-hour ceiling counts, so the pacing was
quietly costing commits to make the ones that landed look slower. The
work-hours window and `max_daily_commits` are the real limits, and both are
about what gets committed rather than when.

### Backoff Retry Strategy
The `brain` driver uses an exponential backoff strategy to handle transient errors during model calls. You can configure the retry behavior by adding the following parameters to the `opencode` driver configuration in `config/drivers.yaml`:

- `retryAttempts`: The maximum number of retry attempts (default: 2).
- `retryDelayMs`: The initial delay between retries in milliseconds (default: 2000).

Example:
```yaml
registry:
  opencode:
    module: ./drivers/brain.opencode.js
    model: google/gemini-3.1-flash-lite
    retryAttempts: 3
    retryDelayMs: 1000
```


### Swapping tools

Every tool sits behind an interface in `src/drivers/contracts.ts`. To swap one,
drop a new module in `src/drivers/` and change one line:

```yaml
brain:
  active: opencode      # <- change this
  registry:
    opencode: { module: ./drivers/brain.opencode.js, model: google/gemini-3.6-flash }
```

Same for `chat.active`, `agents.registry`, and `routing`. No other code changes.

### How work is split between agents

Heavy work goes to `agy`, small edits to `opencode`. A task is **complex** if any
one of these holds — configurable under `routing.complexity`:

- its kind is `feature`, `refactor` or `bugfix`
- it estimates 25+ lines
- it touches 2+ files

Preview the split without running anything:

```bash
npm run sa -- route
```

```
COMPLEX  agy         Implement executeWithRetry helper       complex: kind=feature
SIMPLE   opencode    Create data/reports directory           simple: config, ~5 lines
```

**To run agy alone**, set `simple_agents: [agy]` in `config/drivers.yaml`. One line,
nothing else changes. Two reasons not to, though:

1. **Quota independence.** agy and opencode authenticate against different
   quotas. Running out on one currently costs you nothing; on agy alone it ends
   the day.
2. **agy cannot run shell commands headlessly** (see Trap 2 below) until you
   allow-list them, whereas opencode is configured with `bash: allow`. So for any
   task that needs to install a dependency or run a test, opencode is presently
   the *more* capable of the two.

Once you have allow-listed commands for agy, dropping opencode becomes reasonable.

---

## The three tools, honestly

**OpenCode — solid, not the backbone.** `opencode run --format json` is non-interactive,
takes a working directory, emits a parseable NDJSON event stream, and exits on its
own. It is used for implementation (agent) and can serve as the brain.
Your existing Google + Groq credentials cover it on free tiers.

**Antigravity — autonomous, via `agy`.** There are two different programs here and
the distinction matters:

| Binary | What it is | Automatable |
|---|---|---|
| `C:\Antigravity\bin\antigravity.cmd` | the IDE launcher (VS Code's CLI) | **no** — `--goto`, `--add-mcp`, `serve-web`, nothing that drives the agent |
| `%LOCALAPPDATA%\agy\bin\agy.exe` | Antigravity's actual agent CLI | **yes** — `-p`, `--add-dir`, `--model`, `--print-timeout` |

`agy` is the one that matters. Verified on 1.1.10: it writes files, exits 0, and
prints plain text on stdout, with no `--dangerously-skip-permissions` needed for
ordinary edits inside the target repo.

**Trap 1:** `agy` ignores the process working directory. Without `--add-dir` it
writes into `~/.gemini/antigravity-cli/scratch` and reports success having touched
nothing in your repo. The driver always passes `--add-dir`.

**Trap 2 — the important one.** In headless mode agy auto-approves *file edits*
but auto-**denies** the `command` permission, because there is nobody to prompt:

> a tool required the "command" permission that headless mode cannot prompt for,
> so it was auto-denied

Any task that needs to run a shell command (install a dependency, run a test)
therefore half-completes while still exiting 0. It shows up as random
`NO_CHANGES` or `VERIFY_FAIL` on tasks that look perfectly reasonable — the same
task can fail two different ways on consecutive runs. The driver detects this and
reports `PERMISSION_DENIED` so it is not mistaken for a lazy agent.

Two ways to fix it, in order of preference:

1. **Allow-list the commands you actually need** in
   `%USERPROFILE%\.gemini\antigravity-cli\settings.json` under `permissions.allow`
   (e.g. `command(npm)`). Narrow, and leaves everything else still gated.
2. Set `skip_permissions: true` on the `agy` agent in `config/drivers.yaml`, which
   adds `--dangerously-skip-permissions`. This auto-approves **every** tool call,
   including arbitrary shell commands, for an agent running unattended on your
   machine. The repo allowlist, protected paths and rollback still apply, but this
   is the loosest setting in the system — enable it deliberately, not by default.

**Sandbox truth (2026-08-10 deployed):** the shipped config runs `agy` with
`sandbox: false` + a permissions file at `%USERPROFILE%\.gemini\antigravity-cli\settings.json`
(12 allow, 61 deny, 0 ask). The driver default is `sandbox: true` (`?? true`) —
the deployed config overrides it. See `docs/DECISIONS.md` for the full decision
record including why sandbox had to be off for shell commands to work headlessly.

Tasks that only edit files work fine without either.

To reproduce the diagnosis yourself against a throwaway repo:

```bash
npx tsx scripts/probe-agy.ts
```

The `antigravity` driver (the IDE one) is still registered in `handoff` mode for
work you would rather do by hand. It parks a brief at
`<repo>/.shanauto/handoff/<id>.md`. When you finish one:

```bash
npm run sa -- resolve T0abc123
```

**Why both agy and opencode are wired up:** they authenticate against *different*
quotas — `agy` through the Antigravity suite, `opencode` through a Google AI Studio
API key. When one is exhausted for the day the other is usually still fine, so
switching `brain.active` or `routing.default` keeps you moving. That redundancy is
the most useful thing about having two agents.

**Gemini CLI does not work here.** `@google/gemini-cli` 0.46.0 is installed and has
a good headless mode, but signing in with a personal Google account now returns:
*"This client is no longer supported for Gemini Code Assist for individuals.
Please migrate to the Antigravity suite."* Google retired that free tier and is
pushing everyone to Antigravity — which is exactly what `agy` is. It would still
work with a paid API key, but that offers nothing over the opencode driver.

**ChatGPT — optional, disabled by default.** Two reasons it is off:

1. Automating the ChatGPT web UI is against OpenAI's terms of use, which route
   programmatic access through the API instead. The risk lands on your account.
2. Cloudflare bot detection will break it periodically no matter how good the
   selectors are.

It exists as a convenience for dumping ideas from your phone into a thread instead
of editing `ideas/inbox.md`. Nothing in the autonomous loop depends on it — if it
fails, the run logs a warning and carries on. Enable with `chat.enabled: true`,
then `npm run sa -- chat:login` once.

Harvested chat text is treated as **ideas to triage**, never as commands to run.
It goes through the same planner and the same gate as everything else.

---

## How it avoids re-proposing work that already exists

Originally the planner received only a *list of filenames*, so it cheerfully
proposed "add a sleep utility" when `sleep` was already exported from `util.ts`.
Three layers now prevent that:

1. **The planner sees the repo's API surface.** `src/core/context.ts` extracts
   every exported function, class, type and constant per file — a few thousand
   characters even on a large repo, versus the token blowout of sending real
   file contents. The decompose prompt lists these under `ALREADY BUILT` and
   forbids proposing anything already there.
2. **It sees queued work, not just finished work.** `knownTitles()` includes
   committed, ready, pending *and* dropped tasks, so it cannot re-propose
   something already sitting in the backlog. `failed` is excluded, since those
   may deserve a retry.
3. **A deterministic dedupe backstop.** Proposals whose titles overlap an
   existing one (stopword-stripped Jaccard ≥ 0.6) are dropped before they reach
   the ledger — within the batch as well as against history. A prompt is a
   request, not a constraint, so the rule is enforced in code too.

When an agent does find work already done, it now reports `dropped` rather than
`failed` — a redundant task is a *planning* signal, and burying it in the failure
count hides that. Three or more in a day puts a warning in the report.

Verify all of this without spending a model call:

```bash
npx tsx scripts/probe-planner.ts
```

---

## Why `verify_cmd` runs tests, not just a typecheck

A typecheck only answers *"does this compile"*. Two changes passed that bar and
still should not have landed:

- an interface gained `resets` and `last_reset_at` fields with **no matching
  database columns** — it compiled, and left the type lying about the schema
- a retry helper was added to a driver and **never called** — dead code, compiles fine

So the gate now runs `npm run typecheck && npm test`, and the suite is written
around the failures that actually occur rather than for coverage:

| File | Guards |
|---|---|
| `ledger.test.ts` | every `TaskRow` field is a real column; dependency unblocking; `knownTitles` excludes failed work |
| `context.test.ts` | the dedupe that stops re-proposing existing work |
| `router.test.ts` | the complexity split, and unregistered-agent fallback |
| `util.test.ts` | `extractJson` against the messy shapes models actually emit |

The schema/interface check is double-locked. `TASK_ROW_COLUMNS` is built from an
object declared `satisfies Record<keyof TaskRow, 1>`, so adding a field to
`TaskRow` fails to **compile** until it is added there too — and then fails the
**test** until the column really exists.

Confirmed by reintroducing the original bug: typecheck passed silently, two tests
failed. A suite that cannot fail is worse than none, so check it the same way if
you extend it.

**Tests run on every single task**, so keep them fast — this suite is ~2s. If it
grows into minutes, point `verify_cmd` at a targeted subset and leave the full
suite to CI.

---

## Containment vs. quality control

Worth separating, because conflating them is dangerous:

**The commit gate is quality control, not containment.** It reads the git diff
*after* the agent has finished. Anything an agent deletes outside the repo never
appears in a diff, is invisible to the gate, and cannot be restored by rollback.

Two measures actually contain an agent:

**1. Sandboxing (`sandbox: true`, default for agy driver).** Passes `--sandbox`,
enabling agy's terminal restrictions. Verified it does not break file editing —
agy still writes correctly with it on. OpenCode has no equivalent flag, so its
shell is scoped by deny-rules instead (`rm`, `del`, `format`, git history and
remote commands, `reg`, `shutdown`, `curl`/`iwr` pipe-to-shell, `npm publish`,
`gh`). Defence in depth, not a boundary — a script file written and then run by
an allowed command still gets through.

**Deployed truth (2026-08-10):** the shipped config runs `agy` with
`sandbox: false` + a permissions file at `%USERPROFILE%\.gemini\antigravity-cli\settings.json`
(12 allow, 61 deny, 0 ask). The driver default is `sandbox: true` — the deployed
config overrides it because `--sandbox` blocks headless shell commands (`escalate_admin`
cannot be prompted). See `docs/DECISIONS.md:170` for the full decision record.

**2. A restricted Windows account** — `scripts/setup-restricted-account.ps1`.
This is the only real boundary. A standard account cannot write to `C:\Windows`
or `C:\Program Files`, and cannot read your user profile at all.

The script exists because a fresh account is *not* sufficient on its own here:
`Authenticated Users` has **Modify on all of `D:\`**, so a new account would
inherit write access to every project on that drive. The script denies the agent
account `D:\` and grants back only the repos you name. (An explicit ALLOW on a
child beats an inherited DENY from its parent — that is what makes it work.)

```bash
powershell -File scripts/setup-restricted-account.ps1 -Repos 'D:\repos\shanauto'
```

Run it elevated, and read it first — it changes account and filesystem security.
It supports `-WhatIf`.

**The catch:** node, opencode and agy are all installed *per-user* under
`C:\Users\<you>`, and their credentials live in that profile. The new account
sees none of it, so you must install the toolchain and re-authenticate as that
account. The script prints these steps at the end. Then:

```bash
powershell -File scripts/install-scheduler.ps1 -RunAsUser 'MACHINE\shanauto-agent'
```

**If you enable `skip_permissions: true`, do it only with both of these in
place.** On its own it auto-approves every tool call, including arbitrary shell,
with nothing in this system standing in the way.

### Granting agy shell access with destructive commands blocked

There is a reviewed template at `config/agy-permissions.example.json`, with the
reasoning in **[`config/agy-permissions.md`](config/agy-permissions.md)**. Read
that before applying it — 61 deny rules, 12 allow rules, and three reasons it is
weaker than it looks:

- deny-lists enumerate badness, and the list has no end
- on Windows, [`command()` allow rules fail to match](https://github.com/google-antigravity/antigravity-cli/issues/614)
  (path-tokenisation bug); the documented workaround is `command(*)`, i.e. allow
  everything
- **running tests is running arbitrary code**, because the agent writes the tests

That last point applies to this system already: the gate runs `npm test`, so the
orchestrator executes agent-authored test files every task. Worth knowing before
concluding that a command allow-list changes much.

---

## Guardrails

Coded in, not just intended:

- `state/KILLSWITCH` — checked before every task. `npm run sa -- stop` / `resume`.
- `state/run.lock` — two runs can never overlap.
- Repo allowlist — any path outside `repos.yaml` is refused.
- `max_daily_commits: 40` — a bug cannot produce 4,000 commits.
- Work-hours window — nothing pushes at 3am.
- Protected paths — agents cannot touch `.git/`, `.github/workflows/`, `.gitignore`.
- Agents are told never to run git; the orchestrator owns all git operations.
- Every agent commit carries `Co-authored-by: shanauto <noreply@shanauto.invalid>`.
  It names the machine, not the agent: which worker took the job is the router's
  choice and changes, whereas the thing that planned the task, wrote the brief,
  gated the diff and made the commit is always this system. The address is in
  RFC 2606's reserved `.invalid` TLD on purpose — GitHub resolves
  `<name>@users.noreply.github.com` to the *account* called `name`, so an
  obvious-looking spelling would credit whichever stranger owns it for work they
  have never seen. `.invalid` cannot resolve, so the trailer claims nothing
  about a person. A `resolve` of a handed-off task gets no trailer — you wrote
  that one by hand.
- Commits stage **only** the files the gate inspected. If you edit something else
  while a run is in flight, it stays in your worktree instead of being swallowed
  by an unrelated automated commit.
- Rollback on every failure path reverts **only the files that changed**, never
  `git reset --hard` across the worktree.
- Dirty trees are **stashed** at task start, never discarded — if you were mid-edit
  before the run began, it is recoverable via `git stash list`.
- No `--force`, ever.

### Don't hand-edit a repo while a run is in flight

Worth stating plainly, because it bit me while building this. Rollback originally
used `git reset --hard HEAD` + `git clean -fd`, and when a task failed its gate it
permanently destroyed an unrelated file I was editing at that moment. No stash, no
recovery.

That is now fixed — rollback and commit are both scoped to the exact file list the
gate observed, so unrelated files are left alone. But the underlying race is real:
the system assumes it is the only thing writing to those repos while it runs.
Either edit outside the work-hours window, or `npm run sa -- stop` first.

---

## Free-tier reality — read this before raising `daily_target`

Measured on this machine on 2026-08-06, not guessed. The binding constraint is
**provider quota, not tokens or compute**, and it is the main thing standing
between you and 30 commits a day.

| Model | Result |
|---|---|
| `google/gemini-3.1-pro-high` | **works** — current default for brain (agy) |
| `google/gemini-3.1-flash-lite` | **works** — current default for agent (opencode) |
| `google/gemini-3.6-flash` | free tier is **20 requests per day**. Unusable for volume |
| `google/gemini-2.5-flash`, `2.5-flash-lite` | retired: "no longer available to new users" |
| `groq/*` (all) | free tier is **8k tokens/minute**; opencode's tool preamble alone is ~38k. Never fits |

Two consequences worth being straight about:

**Groq cannot run the executor at all.** Not a config problem — opencode sends its
tool definitions with every request, and that payload is roughly 5x Groq's free
per-minute token budget. Groq is only usable for a tool-free brain, which is why
`fallback_model` does not point at it.

**Budget roughly 2 provider requests per commit.** One for the agent, plus opencode
silently spends one on its own session-title model. So 30 commits/day is ~60-70
requests, plus ~10 for planning. If your account's daily quota is below that, you
will hit a wall partway through the day — the run stops cleanly and reports it
rather than thrashing.

If you hit the wall, the levers in order of cost:

1. Lower `daily_target` in `config/system.yaml` to what your quota actually supports.
2. Add a second provider in `opencode auth` and set it as `brain.fallback_model`.
3. Pay for one provider. A Groq Dev tier or Google paid tier removes the ceiling
   entirely and is the only way to reliably sustain 30+/day.

**A quota error used to look exactly like a hang.** opencode reports provider
failures as `{"type":"error"}` events on stdout and then retries internally with
backoff, emitting nothing else. `src/drivers/ocstream.ts` parses those events and
classifies them, so quota exhaustion now aborts the run in seconds with a clear
message instead of burning the full timeout on every task.

### One non-obvious implementation detail

Every child process is spawned with `stdin: 'ignore'`. execa's default is a pipe
that is never closed, and opencode blocks reading it — it never reaches the model
call at all. This presents as a total hang with zero output, and it cost real time
to find. If you write a new driver, carry that setting over.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `doctor` says repo is not a git repository | never initialised | `git init` in that path, make one commit |
| Commits land but graph stays grey | commit email ≠ GitHub account | `git config user.email` |
| `NO_CHANGES` on many tasks | tasks too vague | tighten milestone detail, re-run `plan:one` |
| Report shows several `dropped` | planner proposing existing work | run `npx tsx scripts/probe-planner.ts` |
| `VERIFY_FAIL` on many tasks | `verify_cmd` is wrong for the stack | fix `verify_cmd` in `repos.yaml` |
| Run does nothing | killswitch / outside work hours | `npm run status` |
| Brain returns unparseable JSON | model drift | it self-repairs twice, then falls back to `brain.fallback_model` |

Every raw model response is archived under `data/artifacts/<runId>/` before it is
parsed, and every run writes `data/runs/<date>.jsonl`. Failures stay debuggable
after the fact.

---

## Layout

```
config/      system.yaml, drivers.yaml, repos.yaml, prompts/
ideas/       inbox.md  (you write here), archive/
data/        shanauto.db, reports/, runs/, artifacts/
state/       KILLSWITCH, run.lock
src/
  drivers/   contracts.ts + one module per tool  <- swap point
  core/      planner, allocator, router, executor, verifier, reporter
  ledger.ts  git.ts  config.ts  schemas.ts  logger.ts  index.ts
scripts/     install-scheduler.ps1
```

---

## Licence

MIT — see [LICENSE](LICENSE). Use it, fork it, sell it; keep the copyright
notice. No warranty, which is worth reading literally for a tool that commits to
your repositories unattended: the gate, the repo allowlist and the rollback are
careful, and they are not a guarantee. Point it at projects whose history you
could afford to lose, and keep the `verify_cmd` for each one honest.
