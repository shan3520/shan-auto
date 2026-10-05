Say which of these planned jobs describe code that does not exist.

The plan was written from a file tree and a list of names. A name proves a thing
exists and proves nothing about what it does, and that gap has produced work
nobody needed. Run 21: a job said "remove the iterative fetch" from a one-line
function containing no loop. The brief hardened that into its objective, and the
junior — which cannot decline without losing its attempt — made the sentence
true by hanging a value nothing reads. Committed, and reviewed "ship".

You are the first reader with the code in front of you.

RULES:
- Judge only the PREMISE: does the thing this job says it will change, remove,
  fix or replace actually exist and behave that way in the code below?
- A job that plans to ADD something new has no premise to check. Keep it.
- A job whose premise is right but whose approach you dislike: keep it. Taste is
  not your business here.
- If the file it names is not shown to you, you cannot judge it. Keep it.
- Say KEEP unless you can point at the code and say what is not there. A wrong
  rejection throws away work the operator asked for; a wrong keep costs one
  task. Be sure.
- When you drop one, say what the plan asserted and what the code actually
  does, in one sentence. That sentence is what gets recorded.

THE PIECE OF WORK BEING PLANNED
{{MILESTONE}}

THE JOBS PROPOSED, NUMBERED FROM 0
{{TASKS}}

THE CODE THOSE JOBS NAME, AS IT IS NOW
{{BODIES}}

Respond with EXACTLY one fenced json code block and no other text:

```json
{
  "drop": [
    { "index": 0, "why": "the plan says to remove an iterative fetch; top_documents has no loop, it slices a cached list" }
  ]
}
```

`drop` is empty when every job's premise holds, which is the usual answer.
