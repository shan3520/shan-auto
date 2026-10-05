# Inbox

Write what you want built here, then run `npm run plan`.

One idea per `##` heading: the heading is the title, everything under it is the
detail. The planner reads this file at the start of every `plan`, shapes each
idea into milestones and tasks, then moves what it consumed into
`ideas/archive/`.

**The `##` heading is required.** `parseInbox` splits the file on `##` at the
start of a line and ignores everything before the first one, so a bare paragraph
with no heading above it is not an idea the parser can see — `plan` will report
finding nothing and you will have no indication why.

Add `repo: <id>` on any line to pin an idea to one project. Without it, the idea
goes to the first repo in `config/repos.yaml`.

The format, indented here so that this file ships with no idea in it — the
example would otherwise be planned as real work on the first run:

    ## Export the ledger as CSV

    There is no way to get the task history out of the database without writing
    SQL. Add a command that writes every task — id, repo, title, status, commit
    sha, dates — to a CSV, and refresh it whenever a report is written so the
    file is never stale.

    repo: my-project

Write your first idea below.
