# ShanAuto issue register

Faults in **this system** — the orchestrator. Not in the projects it builds.

Latest entry: 2026-08-23. The register is cumulative — oldest first — and opens
with the thirteen issues from the first live night, fixed and merged 2026-08-08
(380 → 490 tests). What follows is what is left.

Faults found during live runs from 2026-08-21 onward are written up in full in
`docs/DECISIONS.md`, one section each, with the evidence they were found from.
OPEN below is the short list of what is known and NOT fixed.

---

## OPEN

### O21 — The brief and the plan can name different files, and nothing notices — CLOSED 2026-08-31

**Closed.** `briefIssues` now compares the brief's test files against the plan's
`files_hint` and refuses one the plan never declared, naming the file and the
files it may use instead. Caught inside the brain's repair loop, where it costs
one more model call; at the gate it costs an intern's ten minutes and the work
it wrote.

Test files only, and that is not a half-measure. The gate's file rule is
TEST_TAMPER, which refuses an edit to an EXISTING test in a file the task never
declared. An undeclared source file is not refused on those grounds, so
demanding one here would reject briefs the gate would have accepted — trading a
trap nobody has hit for rejections everybody would.

Proven at the call site as well: every one of the `briefIssues` tests passed
while `authorBrief` handed it an empty declaration. brief-declared.test.ts runs
the real function and fails that mutation.

The gate judges the diff against the task's `files_hint`, which the planner
wrote. The worker never sees that list — it works from the brief, which the
senior wrote separately. Nothing compares the two.

So a brief that mentions a file the plan did not declare is a trap: the worker
does as it is told, the gate refuses the file it was not told about, and the
work is thrown away with nobody at fault. Run 20 hit the same rejection through
the plan instead, and fixing the plan closed that route — see "A deletion the
plan could not legally finish" in DECISIONS.md — but this one is still open.

Not yet observed in a live run. Recorded because it is reachable, not because it
has happened.

### O22 — A provider that never ran still costs the task an attempt — CLOSED 2026-08-31

**Closed.** The remainder — "the run ends there, and with both pools pointed at
one agent an outage costs the rest of the day's work" — is fixed by waiting the
outage out once.

`FatalRunError` carries `transient`. A provider that is not ANSWERING (stalled)
or not FINISHING (timeouts) is having a bad few minutes; quota exhausted for the
day and bad credentials are not, and waiting on those is a hang dressed up as
patience. Only the first two set it.

When the last live agent goes out for a transient reason, the run waits two
minutes, puts it back in play and carries on with the queue. Once per run, which
is the whole of what keeps this from being the hang I dismissed it as: a
provider still down on the second outage ends the run exactly as before, two
minutes later. It costs one further task's worth of stalled dispatches to
discover that, which is the price of the attempt and is bounded.

The outage stays on the record with `recovered: true` rather than being deleted.
An outage the run survived is still something that happened, and tidying the
summary would hide the one fact that explains a short day.

What is genuinely NOT closed here is not a code problem: a second provider on an
independent quota would make all of this moot, and that is an account to obtain
rather than a change to make.

Mutations: never waiting fails 5; removing the once-per-run bound fails the test
that names it.

*(Titled "one of its two tries" until 2026-08-30. `max_attempts` was 2, then 4,
and is now a FLOOR rather than a budget — see `keepTrying`. The wording below
predates that; the mechanism it describes is unchanged.)*

A dispatch the provider abandoned before running anything — zero tokens in, zero
out — is redispatched twice without charging the attempt
(`STALLED_REDISPATCHES`, executor.ts). If all three go the same way, the attempt
is charged, and two of those exhaust the task.

That is a deliberate floor rather than an oversight: redispatching forever would
turn one bad provider hour into a run that never ends. It is recorded here
because the effect on the operator's screen is a task marked failed that no
model ever looked at. Run 15 lost two tasks that way, run 20 one.

The work such a session leaves behind is no longer discarded — see "Work a dead
session left behind" in DECISIONS.md.

**Mostly closed as of run 23.** Reaching the bound is now read as what it is —
the provider is not answering — so the attempt is refunded, the task is left
`ready`, and the agent is taken out of the run instead of the task being marked
failed. See "The run that blamed four tasks for an outage" in DECISIONS.md. What
remains open is narrower: the run ends there. On a machine with a second live
provider the queue reroutes, but with both pools pointed at one agent — the
current configuration — an outage still costs the rest of the day's work, it
just no longer costs the tasks.

### O23 — The brain still decides about code it has never read — CLOSED 2026-08-31

**The brief author reads the code now.** A new elastic section, BODIES, carries
the current contents of the files the task is planned to change — the planner's
own `files_hint`, usually one to four files, capped per file. Not the repo,
which is what makes it affordable inside a budget the symbol index was already
being halved to fit. A file that does not exist yet is SAID to be missing, which
is exactly the fact a brief author needs before it writes `action: "modify"`.

Second-last in ELASTIC_ORDER, above only PATCH: cutting it first would put the
reader back where it started, holding a list of names and asked what the things
behind them do. SYMBOLS is the name index for the whole repo and answers a
weaker question, so it is the right thing to spend first.

brief.md now says the difference out loud: this is the code and not a summary,
do not assert what a function does unless you can see it doing that here, and if
the plan contradicts the code then the plan is wrong — brief what is actually
needed and say so in `rationale`.

**The planner is closed too, and my reason for leaving it was wrong.** I said the
same fix does not fit because the planner has no file list yet. It does by the
time it has answered: the plan NAMES its files. So the question is asked as a
second, small pass — `dropTasksPlanningAgainstNothing` — over the one to four
files the proposals named, which is the same trade that made the brief
affordable. A job whose premise the code contradicts is dropped with the reason,
exactly like a `validateTasks` rejection.

Guarded by the lesson from the acceptance check, which made this identical
mistake inside its own fix a few hours earlier: it sees the CODE, it leans
towards keeping, an unexplained drop is refused, and it will not empty a plan
wholesale — four separate fictions is far less likely than one misread file, and
the cost of being wrong that way is the whole milestone.

**The reviewer is genuinely different** and stays as it is: it already gets the
patch, which is the code, so it is not deciding from names at all.

**The transport note stands, and is no longer blocking anything.**

**The stated blocker turns out to be escapable.** "Sending real file bodies to
the brain costs the symbol index: the Windows command line caps at 32767
characters" — true while the prompt rides in argv, and `agy --input-format
stream-json` reads NDJSON from stdin instead, which removes the cap entirely.
That is a rewrite of the brain driver's transport and its output parsing,
against the one component every other part depends on, and it is not something
to attempt at the end of a long session. Recorded so the work is scoped rather
than believed impossible.

A note on the fix itself: the section was computed and never rendered — `render`
names its variables explicitly and BODIES was not among them. All seven unit
tests passed against that dead section. The call-site test is what found it.

The planner, the brief author and the reviewer get a file tree and the names
each file declares. A name proves a thing exists and nothing else. Run 21 shows
what that costs: a plan instructed a task to remove an iterative fetch from a
one-line function that contained no loop, the brief hardened the claim into its
objective, and the junior — unable to decline without losing the attempt — made
the sentence true by hanging a value nothing reads. Committed, reviewed "ship".

Three prompts now forbid the move (decompose.md must not assert what a function
currently does; brief.md must not promote a plan's guess into the objective;
qa.md must name the production path that behaves differently, and put it in
`summary` rather than making it a finding). Prompts are the whole of the guard.
There is no mechanical check and the reasoning against one is written up in
DECISIONS.md — every cheap detector is a name scan, and a name scan passes this
exact commit.

Sending real file bodies to the brain would close it properly and costs the
symbol index: the Windows command line caps at 32767 characters and the brief
prompt already spends about twenty-nine thousand. Untried.

Full write-up: "A commit that runs and changes nothing" in DECISIONS.md.

### O24 — A rejected task's work survives only as a stash nobody looks at — CLOSED 2026-08-31

**First bullet closed.** The stash message now carries the task id, its title
and how it failed, so `git stash list` distinguishes the entries without any
tooling — and the run report prints the newest five with their labels and
`stash pop <ref>`, because choosing WHICH to restore is the only question
anybody asks of a stash list. Trimmed to one line, since a stash subject is one
line and a gate detail can run to paragraphs.

**Second bullet closed.** The named cost was "an existing assertion rewrapped
across lines by a formatter reads as a rewrite and costs the task an attempt".
Joining continuation lines already absorbed the wrap; what it did not absorb was
the trailing comma Black and Prettier ADD while exploding a call, nor the
padding the join leaves at each bracket. Both are now normalised away, so
`assertEqual(total, 340)` and its exploded form read as the same proof.

Safe because neither can hide anything: a comma before a closing bracket and
whitespace inside brackets assert nothing. The rule still errs toward refusing
for everything a parser would be needed to separate, and that direction stays
right — the false positive costs one attempt, the false negative costs the gate
the evidence it judges everything else by. A test covers each direction.

**The scratch-directory bullet is closed, and not by granting anything.** The
remedy recorded here does not fit the hazard: proving a test can fail means
breaking the code the test IMPORTS, and a copy in a scratch directory is not the
module under test. The run-21 agent broke and restored the repo's own files
because that is the only place the work can be done.

So the rule is stated instead. The task prompt now says: if you prove a test can
fail by temporarily breaking the code, put it back — and a file left broken
fails the project's own check, which rejects and reverts everything you wrote
including the parts that were right. The gate was always the backstop; saying so
turns a silent hazard into a known one, and an agent told what happens if it
forgets has a reason to remember.

No permission was widened, which was the reason this sat here.

Mutations: dropping the reason from the label fails the git test; dropping the
argument at the executor call site fails the executor test. It passed all 199
of the others, which is why the second test exists.

The gate rolls a rejected task back by stashing it. That is the right behaviour
and it has no other end: nothing lists those stashes, nothing tells the operator
one exists, and nothing offers to restore one. `stash@{0}` in example-api holds run
21's best work — the real fix for the global-slice bug, tested and hand
mutation-proven — thrown away by a `TEST_TAMPER` rule that has since been
narrowed so it would no longer refuse it. The stash is still all there is.

The rule itself is fixed (see "The rule that could not tell a fixture from an
assertion" in DECISIONS.md). What is open is everything around it:

- **The pile is named but not explained.** The run report does surface it —
  "38 set-aside change(s) are waiting in example-api, the oldest from 2026-08-08",
  eight of the files, and both `git stash list` and `git stash pop`. What it
  cannot say is which entry is which. Every one of the 38 is called
  `shanauto-rollback <timestamp>`, with no task id and no reason, so "restore
  the newest" is a coin toss over which rejected task you get back. Finding run
  21's fix in there took reading diffs.
- **The new check errs toward refusing, deliberately.** An existing assertion
  rewrapped across lines by a formatter reads as a rewrite and costs the task an
  attempt. Documented, mutation-tested, and still a live way to lose good work.
- **`external_directory: deny` leaves a junior nowhere to mutation-test.** The
  run-21 task broke and restored the repo's own files because it had no scratch
  directory outside the repo. It did that carefully; the next one may not.
  Granting opencode a writable scratch path would remove the pressure. The
  operator's call, and untaken.

### O25 — A milestone can close over the bug it was opened for — ADVISORY 2026-08-31

**Demoted to advisory the same day, on its own record.** Across the three runs
it was live for, the acceptance check reopened four milestones. Every one was
wrong, and it found no real shortfall at all:

| | |
|---|---|
| milestones falsely reopened | 4 |
| real shortfalls found | 0 |

The cause differed each time — shown task titles instead of code, then the first
2,500 characters of a 7,393-character file — and each time the cause was fixed
rather than the score counted. On the third run it would have sent a finished,
working budget feature back to be rebuilt.

The concept stands and the gap it names is real: nothing else re-reads the
request against what shipped. What it has not earned is AUTHORITY. It now prints
its doubt and leaves the milestone finished, because a check with no true
positives must not overrule work that already passed the gate, the reviewer and
the operator's own acceptance criteria. Being wrong costs finished work; being
merely ignored costs a warning nobody acts on.

To promote it back: a run in which it says something true. The evidence it needs
in order to say true things is exactly the part that keeps being wrong, so that
is what to fix first.

The original close-out follows.

**Corrected the same day, after its first live run.** The check was shown task
TITLES and file paths and nothing else, and it reopened two milestones for an
expense report that "does not show each category with its total and its
percentage" and had "no warning line when a category exceeds half the month's
spending". Both were present in `cli.py`, and both printed correctly when the
command was run by hand:

    Total: 340.00
    rent: 300.00 (88.2%)
    Warning: rent exceeds 50% of month's spending
    food: 40.00 (11.8%)

It called them missing because the task title that shipped them read "Implement
CLI report command for monthly spending" and mentioned neither. That is O23 —
deciding about code it has never read — committed inside the fix for O25, on the
day O23 was fixed. A bias towards accepting does not rescue a reader with no
evidence, because it does not know it is guessing.

`shippedSummary` now carries the current contents of the files the milestone's
work touched, via the same `hintedBodies` the brief author uses.

**Wrong a second time, on the next live run, and for a subtler reason.** It
reopened two budget milestones saying the report showed no usage against a limit
and flagged nothing over it. Both were in `cli.py` and both printed when the
command was run by hand. `hintedBodies` capped each file at 2,500 characters;
`cli.py` was 7,393 and `report_expenses` sits at line 125, so the evidence stopped
sixty lines short of the answer — and the reader did not know which third it was
missing. Same failure as showing it titles, one level down: judging from
evidence it could not see, without knowing that is what it was doing.

The cap is 8,000, which covers an ordinary source file whole, and a cut now says
what follows from it rather than noting itself in passing: "N more characters
were not shown to you. Nothing can be concluded to be ABSENT from this file."
`accept.md` carries the same rule. Callers inside `fitPrompt` pass their own cap,
where BODIES is trimmed on purpose rather than by accident. The junior's
own report stays excluded, which was the half of the original reasoning that
held. The two milestones were restored to `done` and the false STILL MISSING
paragraphs stripped from their detail, since a bug of mine had written them.

**Closed.** Something re-reads the request now. When a milestone settles to
`done`, `checkAcceptance` (core/accept.ts) shows a model the ORIGINAL IDEA and
what actually shipped under it — task titles and the files each touched — and
asks whether the request was answered. Deliberately not the task reports: run
22's junior reported truthfully that it had proved a function correct, and that
report is what talked everyone into closing the milestone.

A shortfall does two things. The missing items are appended to the milestone's
`detail`, which is what the planner decomposes from, and the status goes to
`blocked`. The second is what bounds it — `autoReplanBlocked` re-plans it on the
next run and stops after `MILESTONE_AUTO_REPLANS` — and the first is what makes
it useful, because `autoReplanBlocked` clears `last_error` on its way past, so a
shortfall recorded only there would be gone before the planner read it. That
was a real defect in the first version of this fix, caught by the call-site test.

Biased towards accepting, and the prompt says so: "if you cannot tell, answer
true". A false shortfall reopens finished work and spends a day re-planning it.
The failure this catches is silent and permanent; the failure it can cause is
noisy and bounded.

Wired at BOTH places a milestone can settle — the end of a run and
`settleAndRequeue` at the start — because a run that aborted settles at the
second, and a milestone through that door would close over its request just as
silently.

Mutations: bypassing the check fails the call-site test, as does dropping the
`noteShortfall` call. The 12 unit tests all passed against a bypassed call site
before that test existed — the fifth time that hole has appeared here.

Run 22 finished 3 committed / 0 failed and reported the operator's idea done.
One of the three commits was a single test file: the task was aimed at a
function that already did what the plan wanted, so the junior proved it and
committed. Reasonable. But the milestone closed, the backlog emptied, and the
part of the complaint that was still live — the `min_retrievals`
floor at `app/services/document_stats.py:143` — went unmentioned. (This entry
first named `staleness_scoring.py:44` here. Run 24 established that line is
unreachable with a real session and so cannot be the live fault; see the
correction in DECISIONS.md under "The complaint that never reached the person
judging it".)

The false `BREAKING CHANGE` claim that commit carried is fixed, and the report
now names tests-only commits so the operator can see the mismatch between a
task's title and its diff (see "The run that shipped a promise it had not kept"
in DECISIONS.md). That is a prompt to look, not a correction.

What stays open is the mechanism underneath: completion is measured by tasks
committing, and a task that commits something true but beside the point counts
the same as one that fixes the bug. Milestones do now reach a `done` status
(2026-08-26), which gives this failure a name without judging it: `done` means
the planned work finished, not that the operator got what they asked for.
Nothing re-reads the original idea against
what shipped, and nothing reopens a milestone. The operator is told the work is
finished by three separate channels — closed milestone, empty backlog, green run
— and the only thing that disagrees is the code.

### O26 — A retry is told its predecessor edited files, and quoted words it never said — CLOSED 2026-08-31

**Closed.** Both halves, and the reason for doing it now is that the objection
below — "wider changes than the inaccuracy justifies" — was tested and lost. On
2026-08-30 the refusal note added the day before was found telling an agent its
turn had ended when it had not, and this project's own finding is that a prompt
caught lying about the agent's own situation spends the credibility the rest of
it runs on. A sentence that is usually true is exactly the kind nobody checks.

`rollback` returns `RollbackResult` — how many files, which stash, and whether
it was skipped entirely because another process held the index. `treeNote` says
what is true of each: nothing reverted, reverted and stashed, reverted WITHOUT a
stash (the fallback path, which promises no stash and may have deleted through),
or not reverted at all and still sitting in the tree. That last one is the
version that could cause harm, and it read "you are starting from a clean tree".
The side-effects warning is now only printed when there was a revert for it to
qualify.

`ExecResult.spoke` carries what `OcParsed` already knew and the driver boundary
flattened: whether the agent said anything at all. With no agent text the driver
falls back to its own diagnosis, and that is now introduced as ShanAuto's
observation instead of under "What it reported before it stopped". Undefined
means "not stated", which every other driver leaves it at and which reads as
agent text — true for them, since they return the agent's output and nothing
else.

Mutations: restoring the unconditional sentence fails 4; ignoring `spoke` fails
the one test that names it.

The note handed to a second attempt opens with "Attempt 1 did not finish
(INCOMPLETE). Its file changes were reverted and stashed, so you are starting
from a clean tree", followed by a paragraph about side effects outside git that
the rollback could not undo. It is written unconditionally, and `git.rollback`
returns `void`, so nothing at that point knows whether there were any changes.
Run 23 logged "Nothing to roll back in example-api" beside every one of them.

It then prints "What it reported before it stopped:" over `res.stdout`, which on
this path is not the agent talking at all — it is ShanAuto's own sentence, *the
session stopped after a step that finished with reason "unknown"*. The next
model is shown a diagnosis of the provider and told its predecessor said it.

Neither is dangerous while the tree really is clean, which is why this is
recorded rather than patched: the fix wants `rollback` to report what it stashed
and the driver to mark whether any agent text exists, and both are wider changes
than the inaccuracy justifies. The path that made it visible — a provider
returning nothing — no longer reaches this note at all after the run-23 fix.

### O27 — A dropped task is the only outcome nobody reviews — CLOSED 2026-08-31

**Closed**, and not by the route recorded below. Routing a drop through the QA
reviewer really would mean teaching a reader of diffs to judge a claim about
code that did not change, and that objection stands. What was missed is that the
evidence had been in the ledger the whole time: `task_claims` records the files
and symbols each task was planned to add, and nothing read it back.

`checkDropClaim` (core/dropcheck.ts) answers three ways. A named file that does
not exist, or a named symbol that appears nowhere in the named files,
CONTRADICTS the claim — the task is not dropped, the agent is told exactly what
is missing, and crucially nothing is written to `already_done`, which is the
cost this whole issue is about. All names present CONFIRMS it, and the evidence
goes into the ledger row so a later reader can tell a checked drop from an
asserted one. Nothing declared leaves it UNCHECKED and it drops as before: 27 of
77 claims in the ledger name no symbols, and refusing those would turn an honest
absence of evidence into a rejection.

The test is deliberately the weakest one that cannot be wrong — does this name
occur in the file at all — rather than `publicSymbols`, which is right for the
dead-export gate and wrong here: it skips methods, decorated definitions and
leading underscores, each of them real work, and a false contradiction sends a
finished task back to fail twice. Catching "it was never written" is the whole
ambition, because that is the failure on record.

Costs no model call, which was the other objection.

The original entry follows.

Every other way a task can end leaves something a second reader can weigh. A
commit gets a gate result and a QA review. A failure gets a journal entry, a
stashed tree and a retry. `ALREADY_DONE` gets a sentence from the agent that
made the claim, and the task closes.

Run 24 showed what that costs. The junior's claim was sincere, careful and
wrong, and the two guards on that path — `NO_CHANGES` and `saysAlreadyDone` —
both ask whether the claim was *asserted*, which it was. Nothing asks whether it
is true. The finding AO fix (see DECISIONS.md) gives the junior the operator's
own complaint to measure against instead of the brief, which is the right
question to ask; it does not check the answer.

It is also the most expensive outcome to get wrong. A drop writes
`ledger.remember({ kind: 'already_done' })`, which feeds the reasoning pool at
`ask.ts:57` and the planner's dedupe at `planner.ts:1072`. A wrong failure costs
an attempt. A wrong drop teaches the brain the work is done and suppresses the
proposal that would have fixed it — and the run-24 record is still in the
ledger, because nothing retracts one.

Recorded rather than patched: the obvious fix is to route a drop through the QA
reviewer, and the reviewer reads diffs. Giving it a second job — judging a claim
about code that did not change — is a wider change than one run justifies, and
it spends a brain call on the outcome that currently costs nothing.

### O28 — Nothing keeps what an agent was asked — CLOSED 2026-08-31

**Closed.** Every prompt is archived beside the response it produced, in the
same `data/artifacts/<runId>/` directory, written BEFORE the call so a prompt
that ends in a hang, a crash or a refusal is still on disk — which is the case
worth having it for, and the one an after-the-fact write would lose.

One line in `askloop.ts` covers every brain call at once: decompose, brief, qa,
accept, shape, narrate and ask all pass through it, and each repair attempt is
kept separately because a repair sends a different prompt. The two agent drivers
archive theirs beside the output stream they already keep.

Disk was the stated reason this stayed open, and it was already answered:
`prune` sweeps `data/artifacts` on `retention.artifact_days`, so a prompt
inherits the retention rule of the response it belongs to. There was no new
policy to decide.

Mutation: removing the archive call fails all four tests.

Artifacts hold the senior's JSON and the junior's full output stream, per task,
per attempt. Neither prompt is written down anywhere. `reports/`, `journal/`,
`runs/*.jsonl` and the ledger all record what came back.

Confirming the finding AO fix had actually reached a live agent therefore could
not be done from run 25's own records. It took a script that reopened the run's
database, pulled the task row, re-resolved the idea and rebuilt the prompt by
hand — which proves the builder is deterministic, not that the agent saw it.
Close enough here. Not close enough the day a prompt is wrong.

This is the same shape as every finding in this document that took three runs to
see. O23, AF and AO were all lost meaning between a document and its reader, and
in each case the evidence was reconstructed after the fact rather than read.
Storing the two prompts beside the two artifacts that already exist is a small
change; the reason it is recorded rather than done is disk, since a brief prompt
runs to 14 KB and a junior prompt with a brief in it is larger, and a retention
rule wants deciding by the operator rather than by me.

### O29 — The daily report cannot tell "nothing to do" from "cannot go on" — CLOSED 2026-08-30

**Closed.** `writeReport` now opens a "Where the work stands" section, above the
task-level ones because it answers a bigger question than they do: those say
which JOBS did not land, this says whether the WORK is still moving. It leads
with the answer — nothing stuck / stopped but the next run handles it / stopped
and nothing will — then lists what is behind it, with each milestone's reason
and deliberately without its id, since the id exists only for a command the
operator should not have to run.

Fed by the same `partitionStuck` buckets the status screen uses, and split on
`replans` against `MILESTONE_AUTO_REPLANS`, so the two screens cannot drift into
telling different stories about one milestone.

Proven at the call site as well as the rule: deleting the one line in
`writeReport` that calls the section left all nine of its own tests green. Two
tests in `cli.test.ts` run the real command and read the file off disk — one
stalled day, one quiet — and that mutation fails both.

Fixing the milestone stall (see "The milestone that could not finish" in
DECISIONS.md) gave a stopped milestone a status, a place on `sa status`, its
failure reasons, and one automatic re-plan. What it did not touch is the one
document the operator actually reads.

`reports/<date>.md` has no milestone section at all. It reports committed,
failed, dropped, backlog and runway — all task-level — so a run whose every
milestone is blocked prints `1 committed`, `backlog ready 0`, `runway ~0
day(s)`, which is character for character what a run with nothing left to do
prints. Run 25 printed exactly that over three stalled milestones.

`sa status` now says it. The report does not, and the report is what gets read
when nobody is watching — which is the case this all exists for. The fix is a
milestone block in `writeReport`, fed by the same `partitionStuck` buckets the
status screen uses; it is recorded rather than done because the report has its
own layout conventions and this is a change to what the operator is told, not to
what the machine does.

Related: after its automatic re-plans a milestone that fails again stays
blocked until a person runs `sa retry <id>`. *(Was "one" re-plan, bounded on
quota. The operator withdrew that justification on 2026-08-28 — "shanauto should
complete its work no matter how much quota is needed" — and
`MILESTONE_AUTO_REPLANS` is 6. The bound is now about repetition, not spend: a
milestone decomposed six different ways and failed every time is saying it
cannot be built here.)* The bound is deliberate — but it
is still a point at which an unattended run stops, and O29 is what decides
whether anyone finds out.

### O30 — Only one kind of gate rejection is ever retried — CLOSED 2026-08-30

**Closed.** The expression below no longer exists. Retryability is now decided
by `keepTrying`, which asks whether the last attempt failed DIFFERENTLY from the
one before it rather than which verdict it carried, so every rejection is
retried and repetition is what stops it. `blocked` and `VERIFY_UNRELATED` are
the two carve-outs, and only the second remains: a refused agent is now told
what refused it and sent back (`refusalNote`), and `VERIFY_UNRELATED` means the
project was already red before the task ran, which a repair job clears in the
same run.

The unbounded-loop trap recorded below is real and was walked into twice more
while fixing this. What defuses it is that the repetition check runs BEFORE the
attempt floor: the suite's default `NO_CHANGES` verdict repeats identically on
the second dispatch, so it stops there instead of running for ever. Confirmed by
running — 1788 tests, unchanged duration.

The original entry follows, because the trap outlived the bug.

`executor.ts` decides whether a rejected task gets its second attempt with one
expression, and until 2026-08-27 it carried no comment at all:

    const retryable =
      attempt < cfg.system.limits.max_attempts && g.failure === 'VERIFY_FAIL';

So every rejection that is not `VERIFY_FAIL` fails its task on the spot with
attempts still on the clock. The one that matters is `NO_CHANGES` — the agent
produced no file changes whatsoever — which says nothing about the task and
everything about the dispatch. It is the same reading the `stalled` and
`TIMEOUT` rules already take of a provider answering with nothing, and it is
treated as the opposite.

Measured: run 33 burned `Tqoo0o7d4wo` "Integrate month-over-month deltas into
CLI report" at attempt 1 of 2, on a day the same provider had hung on four
dispatches in a row. The task was not wrong. Nothing was dispatched twice.

**Attempted and reverted the same day**, and the reason is the interesting part.
Adding `NO_CHANGES` to the retryable set is a one-line change and it passes
typecheck. It also makes `executor.test.ts` run for ever: `NO_CHANGES` is the
DEFAULT gate verdict in that suite's `beforeEach` (line 503), so the change
turns the baseline of every test that does not override the gate into a retry —
and any of those with a populated `refillWith` into an unbounded dispatch loop.
The pre-existing test "keeps holding the work when the repair does not land"
went from one dispatch to millions, producing a 217MB log.

That loop is a harness artifact — the mock pins `attempt` to 1 while the real
`bumpAttempt` increments — so the change is very probably safe in production.
"Very probably safe" is the wrong standard for a rule whose failure mode is an
unbounded loop spending real provider quota overnight. `max_repair_attempts`
turns out to be a brain setting, not a task cap, so the repair path has no
independent bound to fall back on.

Doing this properly wants a dispatch bound that does not depend on the attempt
counter being incremented correctly by every caller — at which point the retry
policy can widen safely. That is a bigger change than the one-liner it looks
like, which is why this is recorded rather than shipped.

---

## FIXED — 2026-08-08

Thirteen issues, in ten isolated worktrees, merged branch by branch.

| # | Was | Now |
|---|---|---|
| O1 | A milestone whose proposals were all rejected was marked `satisfied` and never revisited | Distinct `rejected` status, reasons stored, surfaced in status/doctor/triage, recovered by `sa retry --failed` |
| O2 | A blocked agent was reported as a lazy one — cost two debugging rounds across 17 tasks | The denial reaches the status reason, the ledger, the journal and the report, naming the permission |
| O3 | Nothing tracked what agents spent, on a system bound by quota | Per-run cost persisted, shown in status and report, soft daily budget |
| O4 | Nothing ever deleted anything; 8.5 MB in one night | `sa prune`, opt-in, dry-run, protected paths |
| O5 | The daily ceiling reset mid-run at midnight | A run's budget is clock-independent |
| O6 | One repo could consume the entire day | Weighted per-repo shares, spare capacity reused, global ceiling still binding |
| O7 | Routing was global, idling a whole quota | **Per-repo overrides removed 2026-08-08 — `router.ts:34`; both global slots now copilot** |
| O8 | The brain burned requests reaching for tools it does not have | Told once in a shared prompt fragment; denial classified fatal, 1 call not 3 |
| O9 | `runwayDays` read 0 for any backlog under a day's target | Honest fractional runway |
| O10 | `runOne` had no test at all | 12 orchestration tests with a fake agent |
| O11 | No contribution verification | Live via `gh`; explains surplus and private-repo settings instead of crying wolf |
| O12 | Journal→memory unproven on real data | Two real defects found and fixed (see below) |
| O13 | Dead export, 12 accumulating probes | Removed; probes down to 9 |

**Three defects found only because agents read the real data:**

- `condenseDay` deleted any line starting with `# `, intending only the day
  title. The first real journal already contained `## Changes Made` *inside* an
  agent's reply — it survived only by being H2.
- Journal days competed with commits for one 3000-row retrieval window. Measured:
  4 days against 3200 commits returned zero candidates and made no model call at
  all. They would have become unreachable in under two months.
- `probe-uncapped-scale.ts` ran `DELETE FROM resolutions` without setting a test
  database. It never fired — the real store is intact at 249 rows — but anyone
  running that file plainly would have destroyed the memory.

---

## FIXED — 2026-08-10 (Band 1–3 audit fixes)

| # | Was | Now |
|---|---|---|
| O14 | `npm test` overwrote tracked reports (`reporter.ts` used real `data/reports/`) | `reportsDir()` now mirrors `dataRoot()` via `SHANAUTO_DB`; temp DB → temp reports in tests |
| O15 | Two tests depended on state they didn't create (`recall.test.ts`, `state/KILLSWITCH`) | Tests create their own temp state dirs; isolated mode `SHANAUTO_DB` covers all |
| O16 | `brain-classify.test.ts` guarded a local copy of patterns, not the driver's | Test now imports `classifyBrainOutput` from the real `brain.agy.ts` (which owns the QUOTA/AUTH patterns) |
| O17 | `ingestJournal` read every stored day to check idempotency | Already-ingested days come from the resolutions table (`ingestedJournalDays()` — `SELECT DISTINCT date(occurred_at)`); no column added, no file read per day |
| O18 | Two definitions of "today" for agent spend vs commits | Both now use `date('now','localtime')` — `runs.day` and `tasks.committed_day` aligned |
| O19 | `sa prune` existed but was never called | **Scheduled at 19:15** in `scripts/install-scheduler.ps1`; retention defaults in `system.yaml` |

**Three defects found only because agents read the real data:**

Every one of the thirteen came from running the system for real, not from
reading it. The three above came from agents reading real *data* rather than
fixtures.

**7 committed, 0 failed, and the job was not done.** A passing gate is evidence,
not proof.

---

## QA round, 2026-08-09

Nine faults, from two testers. **None of them was caught by the 529-test suite**,
which is the finding behind the finding.

### CRITICAL — fixed

**A task could switch the repo's own check off.** The two were concatenated into
one shell string, `base && taskCmd`, on the assumption that appending can only
narrow. It cannot — a top-level `||` takes the whole baseline as its left
operand:

    node fail.js                              -> exit 1
    node fail.js && pytest tests/x.py || true -> exit 0

Not merely adversarial: `|| true` is ordinary, and
`test -f x && echo present || echo missing` is the exact shape decompose.md ASKS
for on removal tasks. A task obeying its brief could disable the gate. Now two
separate processes, both of which must exit 0.

**The gate was blind to every deletion.** `git add -A --intent-to-add .` was
there to reveal untracked files; `-A` also stages deletions for real, and the
next line read the UNSTAGED diff. The one line meant to make it see more is what
made it see less. Measured: the gate authorised 1 file and the commit contained
4, deleting `.github/workflows/ci.yml` — a FORBIDDEN path, protected against
editing and not against deletion. Also the true mechanism behind 2026-08-08:
"copied instead of moved" was not a semantic blind spot, the move half was
invisible. Now diffed against HEAD, and the commit names its pathspec.

That fix exposed a third: a true move arrives as one rename entry,
`old.ts => new.ts`, which is not a path — so a rename INTO a protected path would
have passed. Found by the test written for the fix.

### HIGH — fixed

**Rollback destroyed the owner's work.** It cannot tell the agent's changes from
the owner's: a task runs up to 15 minutes and `diffStat` reports anything written
in that window as the agent's. Untracked files were `rmSync`'d — no stash, no
recovery. Now stashed, so the worst case is "your file is in a stash".

**Pausing the system turned its own suite red.** 8 tests drove `runBatch`, which
read the real `state/KILLSWITCH`. ShanAuto's gate is `npm test`, so while paused
it could not have committed a change to itself.

**Reports invented history.** `getDailyCommitCounts` grouped UTC while `status`
counted local. Reported 63 commits on a day that saw 31, and omitted today
entirely. This system runs at night, so its work was filed a day early — the
owner would see a spectacular day, then a collapse that never happened.

**`doctor` said "all checks passed" over a halted system.** The one command a
non-technical owner runs to ask "is it OK?".

**`recall` reported the page size as the answer** — "25 result(s)" for a query
matching 107 — and dated every memory by when it was FILED rather than when it
happened, collapsing the whole history onto the ingestion day.

**Memory was stored once per repo.** DECISIONS.md and the run logs describe the
system, not a project. 40 duplicates removed; ingestion fixed.

### Still unexamined

The interface judged as a non-technical user; data-destruction paths; failure
recovery. A fourth — whether the suite catches a deliberate break — is running.

### The finding behind the findings

Nine faults, none caught by 529 tests. Several lived in what git actually does
rather than in what the code appeared to say, and the tests asserted on the code.
Others were tested against a copy of the rule instead of the rule. The suite is
necessary and it is not evidence.

---

## QA round, 2026-08-09 — first finding (superseded by the section above)

### Q1 — Pausing the system turns its own test suite red

Setting the killswitch makes 8 tests fail in `src/core/__tests__/executor.test.ts`.
Proved by toggling it: killswitch present → 8 failed; absent → 18 passed.

`runBatch` checks the real `state/KILLSWITCH` file, and those tests never control
it, so results depend on the machine rather than the code. ShanAuto's own gate is
`npm test`, so it cannot safely work on itself while paused — and the most
ordinary action an owner can take is the one that breaks it.

Same shape as the `recall.test.ts` finding: a test reading real machine state.
That was fixed by creating the missing directory rather than by isolating the
dependency, so the class of fault was never addressed.

### Still unexamined

Six QA areas were briefed and none reported: the terminal interface judged as a
non-technical user, the commit gate under attack, data-destruction paths, failure
recovery, whether the reported numbers are true, and whether the 514 tests catch
a deliberate break. The briefs are in the session transcript and are worth
re-running one or two at a time rather than six at once.

---

## QA round 2, 2026-08-09 (afternoon)

Twenty-six further faults, from driving the system rather than reading it. **None
was caught by the 549-test suite**, and one of them was a fix made earlier the
same day that did not work.

### The fix that did not work

`rollback`'s stash — added that morning to stop it destroying the owner's files —
**never engaged for the files it was protecting.** git refuses to stash a
pathspec containing an intent-to-add entry:

    error: Entry 'mine.md' not uptodate. Cannot merge.

`diffStat` runs `git add -A --intent-to-add .` moments earlier, so the stash
failed every time an untracked file was involved — which is the only case the
destructive fallback can destroy anything. The net engaged solely for tracked
files, which were recoverable from HEAD anyway.

The test mocked simple-git and asserted `stash push` was **called**, never that
it worked. That is the same failure this register has been recording all week,
in a test written hours earlier.

### Silent, and the record says it succeeded

| Fault | What actually happened |
|---|---|
| A rebase conflict read as "offline" | Task committed onto a detached HEAD, `HEAD 739` went into the ledger as the commit id, push rejected as a warning, `rebase --abort` made it unreachable. Marked committed, so never retried. **Work gone, record says success.** |
| A crashed agent disabled every safety net | Stale `.git/index.lock` — left by exactly the timeout this system uses — makes `reset`, `stash` and `checkout` all fail. safeGit swallows each. Rollback falls through to plain `rmSync`. |
| No `busy_timeout` | 4 processes × 300 rows landed 343 of 1200. **857 writes lost**, no corruption, one log line. |
| Export overwrote its own backup | Ignored `SHANAUTO_DB`, `rmSync` then append. 1682 bytes → 252. |
| Restore returned less than it was given | Keyed `kind:sha:reason`; 53 out, 46 back, 7 called "already present". |
| `dedupe-memory` deleted a superset of its report | 1 reported, 4 removed — and it ran against the real memory. |
| A retention window it could not express | Date overflow → `"NaN-NaN-NaN"` → string compare `'2026-08-09' >= 'NaN…'` is false → **"keep for three centuries" deleted everything.** |
| A rollup with an empty period | Collides with every other malformed row on the UNIQUE key and overwrites a real month. `importMemory` passes the literal `"undefined"` from a truncated line. |
| `open()` cached a half-migrated handle | Later errors named a missing table, not the cause; the next process migrated correctly, so the fault erased its own evidence. |
| A repo with no commits | `git diff HEAD` is fatal with no HEAD, and `diffStat` runs on every task. A brand-new project crashed. |

### The screen the owner uses

Two are silent and permanent:

- **One arrow press could stop the system forever.** "Stop working at" wrapped
  23:59 → 00:00, which is before every start time. The working day becomes zero
  minutes. No error, no warning, and the cause is one keystroke on a page
  visited weeks earlier.
- **"Nothing to build", seconds after being told what to build.** An idea is not
  a job until the planner runs, and nothing said the idea had landed. The
  obvious response is to type it again.

And: a stack trace on the first menu item when no project is configured (the
friendly handler sat below the throwing call, unreachable); Esc discarding a
written description silently; un-pausing asking nothing while pausing asked;
a paused system promising to start at 07:00; Home/End typing `[1~` into the
idea; `##` in a description splitting it into two jobs; `Example:` titles and
short descriptions dropped without a word; `Setting.warn` declared and never
called; a hand-edited value reset to the minimum on first touch; the diary cut
at 200 lines; Quit hanging until Ctrl-C.

### The gate was a syntax check

`example-api`'s `verify_cmd` was `python -m compileall` — it proves a file parses.
The repo has had 27 tests for days, **3 of them failing**, and the gate passed
every one of them through. `doctor` never ran the command at all.

Both fixed: the gate runs the suite, and "Check everything is working" now runs
each repo's own check and says plainly when a project cannot accept work.

### The pattern, again

Every fault above was found by running the thing. The suite went from 549 to 593
tests, and the 44 new ones are almost entirely against real git repositories,
real databases and real files — because every fault lived in what the tool
actually does, not in what the code appeared to say.

**A passing suite is evidence, not proof.** A green suite over a mocked
dependency is not even evidence.
