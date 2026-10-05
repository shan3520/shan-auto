# Part 6 — §9 security & data-hygiene gaps

Three of the audit's §9 residuals: the orchestrator's own `.shanauto/` handoff
briefs were polluting gate diffs on worker repos (§9.4), `notify()` shipped
commit titles and failure bodies to a *public* ntfy.sh topic whenever
`NTFY_TOPIC` was set (§9.6), and the TUI's settings screen edited live YAML with
a dotted-path regex and a non-atomic write (§9.8). All three are closed.
`npm run typecheck` clean, full suite green (**745 passed / 53 files**, +9
tests), one commit.

---

## Done

### §9.4 — `.shanauto/` handoff briefs no longer reach the gate (`src/git.ts`, `src/core/verifier.ts`, `.gitignore`)

The handoff driver writes `repo/.shanauto/handoff/<id>.md` into a worker repo
while a task runs. On the next task on that repo, the brief is an uncommitted
file the gate measures — a one-line markdown file read as real agent work,
counted in the diff, scoped into the commit pathspec, and reverted by rollback.

- **`underShanauto(entry)`** (`src/git.ts`) — decides whether a raw diff entry
  (a path, or a rename `old => new` where either side may be a brief) lives
  under `.shanauto/`.
- **`diffStat` filters at the one shared measurement** — `git.ts:139`. Files
  under `.shanauto/` are dropped, and `insertions`/`deletions` are **recomputed
  from the kept entries** because git counts a brief as a real addition. The
  gate, `commitAndPush` (which stages only `diffStat`'s files), and rollback
  therefore all agree on what the agent actually changed. Binary and
  name-status entries (no line counts) read as 0/0.
- **FORBIDDEN path regex** — `/(^|\/)\.shanauto\//` added to the list in
  `src/core/verifier.ts` as defense-in-depth: a direct `gate()` call on a
  `mockDiff` that still names a brief fails loudly instead of passing some
  future path that bypasses `diffStat`.
- **`.gitignore` entry** — defensive only. Worker repos cannot ignore it (they
  do not know the orchestrator will write there); this stops a brief riding
  into an owner's own `git add -A` if a managed repo is the orchestrator's own.

Tests: `git.test.ts` asserts a brief is excluded from files *and* totals while
a real file keeps its per-file counts, and that a rename *into* `.shanauto/`
drops the whole entry (neither the source deletion nor the destination counts);
`verifier.test.ts` asserts a `.shanauto/` path in a `mockDiff` → `FORBIDDEN_PATH`.
The diffStat mocks were updated to carry per-file counts (the recompute reads
them), which the summary-totals-only mocks did not have.

### §9.6 — `notify()` no longer posts failure detail to a public topic (`src/core/reporter.ts`, `.env.example`)

An unauthenticated ntfy.sh topic is **public**: anyone who guesses the topic
string can read every message ever posted to it. The audit objected that failure
bodies — raw error text, commit titles — were sent to exactly that.

- **One invariant in `notify()`**: the body ships *only* with an `NTFY_TOKEN`
  (an access token for the topic, which makes it private, sent as
  `Authorization: Bearer …`). An unauthenticated notification carries the title
  alone. The title already carries the useful count (`ShanAuto 3/30`), which is
  enough to get a person to a screen. Both call sites (`on_run_complete` and
  `on_failure`) route through the same function, so the rule holds everywhere
  with no per-site body whitelisting.
- **`.env.example`** documents `NTFY_TOKEN` and warns that without it the topic
  is public and only the title is ever sent.

Tests (`reporter.test.ts`): title-only when unauthenticated (body `undefined`,
no `Authorization` header), full body + `Bearer` when a token is set, no fetch
at all when `NTFY_TOPIC` is unset, and best-effort — a rejected fetch never
throws.

### §9.8 — TUI settings edits are grammar-resolved and atomic (`src/tui/settings.ts`, `src/util.ts`)

The audit (§9.8) objected to a dotted-path regex edited against live YAML: a
hand-edited file could defeat the regex, and there was no protection against a
concurrent reader seeing a torn write.

- **`writeSetting` rewritten** to a YAML-AST-guided surgical edit: `parseDocument`
  resolves the path the same way the reader resolves it — by grammar, not by
  regex over lines — then only the value's exact source span is replaced.
  Comments, their column alignment, blank lines and the EOL convention survive
  byte-for-byte. A value that is shorter than the token it replaces is padded
  back to the token's width, so a trailing comment keeps its column. Invalid
  YAML is refused before anything is touched.
- **`writeFileAtomic`** (`src/util.ts`) — sibling temp + `renameSync`, atomic on
  the same volume. A reader racing the edit sees the old file or the new one,
  never a half-written one.
- A full `parseDocument` → mutate → serialise round-trip was measured and
  rejected: it collapses comment alignment (`daily_target`'s `#` col 26 → 17),
  drops CRLF, and re-indents multi-line comments — precisely the degradation
  this file exists to prevent.

Tests (`settings.test.ts`): a syntactically broken file is refused and left
byte-identical; a successful edit leaves no temp file behind. The existing
trailing-comment-column test is what caught the width-shift bug in the first
cut and now passes via padding.

---

## Not done (deferred)

| Observation | Where it lands |
|---|---|
| Worker repos still cannot gitignore `.shanauto/` on their side — the exclusion is orchestrator-side (`diffStat` + FORBIDDEN + commit pathspec). A worker's *own* tooling that runs `git add -A` in that repo could still sweep a brief | consciously unchanged — the orchestrator's commit path is the one covered; worker-side ignore is not ours to set |
| `notify()` is tested at the function level; the two call sites are not separately tested for what they pass as body | covered by the function contract; call sites only pass `sum` counts / error message, both gated by the same invariant |
| The TUI settings write is atomic but not *locked* against a concurrent hot-reload. No lock was added | atomic rename already prevents torn reads; a reader sees old or new. A lock would need a shared mutex between TUI and the config loader, adding a dependency for a race that the atomic write already wins |
| `writeSetting` still rejects rather than creating a key that is absent from the file | unchanged from before — the settings screen only edits values the schema already exposes |

---

## Design & architecture decisions

1. **§9.4 is fixed at the measurement, not at every consumer.** The briefs
   could not be gitignored in worker repos, so the options were "exclude in
   `diffStat`" vs "special-case every place that reads the diff". We chose the
   one shared measurement: `diffStat` is the single authority on what the agent
   changed, so the gate, the commit pathspec and rollback all inherit the
   exclusion and cannot drift apart. FORBIDDEN and `.gitignore` are both
   defense-in-depth, not the primary control.

2. **Honest totals after exclusion.** Once a brief is dropped from the file
   list, the summary `insertions`/`deletions` git reported (which include it)
   are wrong, so `diffStat` recomputes them from the kept per-file entries.
   Without this, the TRIVIAL floor would have judged a real change by a total
   inflated by a brief, and a task that only touched `.shanauto/` would have
   looked like work.

3. **§9.6: one invariant, not per-site whitelists.** The alternative was to
   audit each `notify()` call and allowlist its body — fragile, because the
   next call site would forget. A single rule in the one function every
   notification passes through ("body ⇔ token") is simpler and cannot be
   bypassed by a new caller. The trade is that a legitimate body is dropped
   until the operator adds a token — the safe direction, and the count in the
   title is enough to act on.

4. **§9.8: surgical edit over round-trip.** The audit offered "parse → mutate →
   serialize, or lock". We measured the serialize path and it degrades the very
   comments this file carries as reasoning — so neither full round-trip nor a
   lock is right. `parseDocument` *only* to resolve the key and locate the value
   span, replacing exactly that span, gives the audit's grammar-based resolution
   and adds atomicity, while preserving the file byte-for-byte everywhere except
   the value. The trailing-comment test is the regression guard for that.

5. **Padding keeps columns stable.** A plain-scalar value span is exactly the
   token (`30`), so replacing `30` with `5` would drag a trailing `#` left by
   one. Padding the replacement back to the token width keeps the column; a
   value that grows shifts the comment right, which is acceptable and rare. This
   fell out of an existing test failing, not from the audit — a good sign the
   test was asserting the real contract.
