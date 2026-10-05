# Feature 1 — Durable project memory

## The acceptance test

> It is January 2027. You ask:
> `sa ask "what do you know about the shanauto project?"`
> and get a coherent, specific answer drawn from a year of work.

If that question does not answer well, the feature is not done. Everything below
exists to serve that one sentence.

---

## 1. What already exists (do not rebuild)

Built and tested on 2026-08-07, commits `5a7c587`..`049bebc`. This is the
substrate and it is sound:

| Piece | State |
|---|---|
| `resolutions` table, append-only, never pruned | done |
| `task_claims` table | done |
| Git-history ingestion (`src/core/ingest.ts`), idempotent by SHA | done |
| Export-symbol extraction from `.ts` diffs | done |
| Keyword search (`searchResolutions`, LIKE, terms ANDed) | done |
| `sa recall "<query>"`, works with the killswitch set | done |
| Pre-dispatch staleness check | done |

**Scale is not a problem.** Measured: 135 bytes per memory, so 30 commits/day for
three years is **4.2 MB**. Nothing needs pruning, ever. "Infinite" is already true
for storage; it is the *usefulness* that does not yet survive scale.

---

## 2. The three real gaps

### Gap 1 — it remembers code changes, not work

A stored memory today is a commit:

```
kind:    external_commit
paths:   [".env.example", "README.md", "config/drivers.yaml"]
symbols: ["loadConfig", "resolveRepo"]
reason:  "chore: scaffold shanauto orchestrator"
```

It has no idea that agy was granted shell access and why, that FTS5 was rejected
deliberately, that the verify gate was being bypassed by per-task commands, or
that 41 of 51 tasks went stale in one session. **Every one of those is what you
would actually ask about in 2027**, and none of it is in memory — it lives in
`docs/DECISIONS.md` and in chat transcripts.

### Gap 2 — it matches text, it does not answer

`sa recall "sparkline"` greps. Ask *"what do you know about shanauto?"* and it
returns nothing, because no row contains that phrase. Answering an open question
requires retrieval plus one model call.

### Gap 3 — old memory drowns rather than compresses

The planner digest is capped at 2000 chars and recent-first. Correct for
staleness; useless for history. At 30 commits/day, 2027 has ~11,000 rows and the
useful signal is invisible. Years must **compress**, not merely accumulate.

---

## 3. What to build

### 3.1 Wider capture

Extend `resolutions` kinds beyond commits. Every one of these is a thing you
would later ask about:

| kind | Written when | Carries |
|---|---|---|
| `task_failed` | a task exhausts attempts | failure reason, gate verdict |
| `gate_rejection` | the gate rejects | which rule, the detail |
| `task_dropped` | a task is retired | the reason given |
| `config_change` | `config/**` changes in a commit | which file, which keys |
| `decision` | ingested from `docs/DECISIONS.md` | the heading and its rationale |
| `incident` | recorded by hand via `sa remember` | free text |

`shanauto_commit`, `external_commit`, `manual_park`, `already_done` already exist.

Add `sa remember "<text>"` so a human can write a memory directly. Cheap, and the
only way some context ever reaches the store.

### 3.2 Ingest the written record

`docs/DECISIONS.md` already holds the reasoning behind every significant choice,
in dated sections. Parse it into `decision` rows — heading, date, body. Idempotent
by heading+date. Same for run logs in `data/runs/*.jsonl`: extract terminal
outcomes, not every line.

This is the single highest-value step. It converts documentation already written
into memory that can be retrieved.

### 3.3 Rollups — the compression layer

New table `memory_rollups`: `period` (`day`|`week`|`month`), `starts_at`,
`ends_at`, `repo`, `stats` JSON, `narrative` TEXT, `source_count`.

- **Deterministic stats are free**: commits, parks, failures, top paths, top
  symbols, distinct kinds. Compute with SQL, no model call.
- **A narrative sentence or two per period** needs one brain call — but only when
  a period *closes*. That is ~52 weekly + ~12 monthly calls a year. Negligible
  against a daily budget.

Retrieval then reads **rollups for old periods and raw events for recent ones**,
so a question about last March costs one summary row, not 900 commits.

### 3.4 Retrieval — deterministic, no embeddings

No vector store, no embeddings, no new dependency. Score candidates by:

- term overlap with the question (terms ANDed as now, then OR-widened if empty)
- recency, mildly weighted — recent work matters more, old work must still surface
- layer: prefer a rollup when it covers the period, fall back to raw events

Assemble a context block under a hard character cap (~6000). Deterministic and
testable, exactly like `apiSurface` and `resolutionDigest`.

### 3.5 `sa ask "<question>"`

1. Retrieve (deterministic, no model call).
2. **One** brain call: the retrieved context plus the question.
3. Print the answer with citations — dates and SHAs — so it can be checked.

Costs one provider request per question, on demand. `sa recall` stays as the
zero-cost keyword path.

### 3.6 Durability

The store must outlive the SQLite file. `sa memory:export` writes
`data/memory/<year>.jsonl`, append-only and diffable; `sa memory:import` restores.
Without this, "infinite memory" is one corrupted file from zero.

---

## 4. Hard constraints

1. **No new runtime dependencies.** No embeddings, no vector DB, no local model.
   `node:sqlite`, `simple-git`, `execa`, `zod` only.
2. **No LLM call outside a driver.** Retrieval is deterministic; only `sa ask`
   and rollup narratives call a model.
3. **Quota:** zero added per commit. Rollups ~64 calls/year. `sa ask` on demand.
4. **Read commands work with the killswitch set** — `recall`, `ask`,
   `memory:export`. Inspection is what you do while it is stopped.
5. **Append-only. Nothing is ever deleted or rewritten**, including by rollups.
   A rollup summarises; it never replaces its sources.
6. **Do not touch** `src/core/verifier.ts`, `config/repos.yaml`,
   `src/drivers/**`, or any `verify_cmd`.
7. **Fail open.** A memory failure must never block a run. Wrap every write so a
   full disk or a locked database degrades to a warning.
8. Windows-first paths; subprocesses use `stdin: 'ignore'` + timeout + SIGKILL.

---

## 5. Phases

Green typecheck and tests after each, commit before moving on.

**Phase 1 — Wider capture.** New kinds, written from `executor.ts` where
outcomes are already known. `sa remember "<text>"`. Tests per kind.

**Phase 2 — Ingest the written record.** Parse `docs/DECISIONS.md` into
`decision` rows; extract terminal outcomes from `data/runs/*.jsonl`. Idempotent.
**Verify by asking `sa recall "agy shell access"` and getting the real decision.**

**Phase 3 — Rollups, deterministic half.** `memory_rollups` + SQL stats +
`sa rollup [--period week]`. No model call yet. Test the maths.

**Phase 4 — Rollup narratives.** One brain call per closed period, via the
existing driver. Skip silently if the brain is unavailable — stats alone are
still useful.

**Phase 5 — Retrieval.** Pure, deterministic, capped. Table-driven tests:
question with obvious hits, question with none, question matching only old
periods, cap enforcement.

**Phase 6 — `sa ask`.** Wire retrieval to one brain call. Test with a mocked
brain asserting exactly one call and that the answer includes retrieved context.

**Phase 7 — Durability.** `memory:export` / `memory:import`, round-trip tested.

**Phase 8 — Docs + acceptance.** MANUAL and DECISIONS entries. Then run the real
acceptance test and **paste the actual output into the summary**.

---

## 6. Definition of done

- `sa ask "what do you know about the shanauto project?"` returns a specific,
  accurate answer citing real dates and commits.
- `sa ask "why does agy have shell access?"` answers from the ingested decision
  record, not from a guess.
- `sa ask "what went wrong on 2026-08-06?"` recalls the stale-task incident.
- A question about a period covered only by a rollup answers from the rollup.
- `sa recall` and `sa ask` both work with the killswitch set.
- Export/import round-trips without loss.
- Zero additional provider requests per commit.
- 212 existing tests still green; `verifier.ts`, `repos.yaml`, `drivers/**`
  unchanged — verified by diff against the base commit.

## 7. Explicitly out of scope

- Embeddings or semantic search. Keyword plus rollups first; revisit only with
  evidence that it is insufficient.
- Memory shared across machines or repos.
- Per-task agent context injection (deferred on evidence — it would spend quota
  on ~40 daily calls to fix a problem originating one layer up).
- Any refactor not required by the above.
