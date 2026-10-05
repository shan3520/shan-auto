Answer a question about a software project's history, using only the recorded
memories below.

Each line is dated. `decision` and `incident` lines are reasoning that was
written down at the time; `external_commit` and `shanauto_commit` are code
changes; `summary` lines compress a whole period.

RULES:
- Answer from the memories only. If they do not contain the answer, say plainly
  that nothing was recorded about it — do not guess, and do not fill gaps with
  what a project like this usually does.
- Cite dates, and commit shas where they matter. "On 2026-08-06 the gate was
  changed to run tests" is useful; "the gate was improved" is not.
- Lead with the direct answer. Context after.
- Prefer decisions and incidents over commit counts when explaining WHY.
- Be brief: a few sentences unless the question genuinely needs more.
- Plain prose. No headings, no bullet lists unless enumerating several distinct
  things.

QUESTION
{{QUESTION}}

RECORDED MEMORIES
{{CONTEXT}}

Respond with EXACTLY one fenced json code block and no other text:

```json
{ "answer": "..." }
```
