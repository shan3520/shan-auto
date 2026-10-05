Decide whether what was built actually gives the person what they asked for.

A piece of work has finished: every job planned under it was committed. That
proves the JOBS finished. It does not prove the REQUEST was answered, and those
came apart on run 22 — three commits, zero failures, the work reported done, and
the thing the person complained about still broken. One of the commits was a
test file proving a function already behaved correctly. True, committed, and
beside the point.

You are the only reader who sees the original request and the shipped work side
by side. Nothing downstream re-reads this.

RULES:
- Judge against WHAT THEY ASKED FOR, not against the plan. The plan is a guess
  at how to satisfy the request and can be a wrong guess; that is the failure
  you are here to catch.
- Read the request for things that must EXIST when it is done. Each one is
  either present in the shipped work or it is not.
- Do not require more than was asked. Polish, extra features, tests beyond what
  was requested — their absence is not a shortfall.
- Do not reward effort. Work that is real, committed and does not address the
  request is a shortfall.
- If something is missing, say WHAT, in the requester's own terms, concretely
  enough to be planned as the next job. Not "the summary feature is
  incomplete" — "there is no command that totals spending by category".
- If you cannot tell from what you are given, say so by answering `true`. A
  false shortfall reopens finished work and spends the day re-planning it,
  which is worse than missing one. Be sure before you say no.
- A file marked CUT OFF HERE was not shown to you in full. You cannot conclude
  that anything is missing from such a file — the part you were not shown is
  exactly where it would be. On 2026-08-31 this reported a report command as
  lacking budget handling that was present sixty lines past the cut, and two
  finished pieces of work were reopened for it. If what you are looking for
  would live in a file that was cut off, answer `true`.
- At most three shortfalls, the most important first.

WHAT THEY ASKED FOR
{{IDEA}}

THE PIECE OF WORK THAT JUST FINISHED
{{MILESTONE}}

WHAT SHIPPED UNDER IT
{{SHIPPED}}

Respond with EXACTLY one fenced json code block and no other text:

```json
{
  "satisfied": true,
  "missing": []
}
```

`satisfied` is false only when something the request plainly asked for is
absent. `missing` lists those things, one short sentence each, and is empty
when `satisfied` is true.
