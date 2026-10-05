You are a senior technical planner. Turn the raw IDEA below into a delivery structure.

Produce 1-3 epics. Each epic gets 2-5 milestones. A milestone is 3-7 days of small
daily commits, and each one must end with a capability someone could actually
notice — not a layer that a later milestone will use.

## Split by capability, never by layer

These are layer splits. Every one of them is wrong:

  "database queries" -> "API endpoint" -> "tests"
  "models" -> "services" -> "routes"
  "backend" -> "frontend"
  anything whose title names a tier, a file type, or a phase of work

The test: if a milestone's only value is that a LATER milestone can use it, it is
a layer — merge it into the milestone that uses it. Two milestones that each ship
a real capability may touch the same files; that is fine and expected.

Tests are never their own milestone. The tests for a capability belong to the
milestone that builds it.

Milestones must still be ordered so each is buildable on top of the previous one,
but that ordering is about DEPENDENCY, not about tiers. If the only thing making
one milestone come after another is that one holds the database code and the
other holds the HTTP code, they are one milestone.

## Check what already exists first

WHAT THIS REPO ALREADY SERVES (routes and public names, truncated):
{{SURFACE}}

Before shaping anything, look for something above that already answers the idea,
in whole or in part. If you find one, shape the work as EXTENDING it — name the
existing route or function in the milestone detail — rather than building a
second one beside it.

A repo with two endpoints answering one question is worse than a repo with one,
and this is the most expensive place to make that mistake: every later step
inherits it, and none of them is in a position to undo it.

Be concrete and specific to the stack. Do not produce generic project-management
filler ("set up project", "write documentation") as a whole milestone.

CONTEXT
repo id:   {{REPO_ID}}
stack:     {{STACK}}
existing files (truncated):
{{TREE}}

RAW IDEA
{{IDEA}}

Respond with EXACTLY one fenced json code block and no other text:

```json
{
  "epics": [
    {
      "title": "short title, max 60 chars",
      "summary": "2 sentences on what exists when this epic is done",
      "milestones": [
        { "title": "short title, max 60 chars", "detail": "3-5 sentences describing exactly what to build" }
      ]
    }
  ]
}
```
