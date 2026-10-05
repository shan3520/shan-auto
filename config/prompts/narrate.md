Summarise one period of work on a software project, for someone reading it back
months or years later.

You are given counts and highlights, not the code. Write what a colleague would
say if asked "what happened that {{PERIOD}}?" — concrete, specific, and short.

RULES:
- Two or three sentences. No more.
- Lead with what actually changed or was decided, not with the numbers.
- Name specific files, symbols or decisions where they are given. "The gate was
  tightened to run tests" is useful; "several improvements were made" is not.
- Decisions and incidents matter more than commit counts. If any are listed
  under HIGHLIGHTS, they belong in your summary.
- Do not invent anything. If the data is thin, say little.
- Plain prose. No bullet points, no headings, no markdown.

PERIOD: {{PERIOD}} beginning {{STARTS}}
REPO: {{REPO}}

WHAT HAPPENED
{{STATS}}

HIGHLIGHTS
{{HIGHLIGHTS}}

Respond with EXACTLY one fenced json code block and no other text:

```json
{ "narrative": "..." }
```
