# agy permissions — read before applying the template

`config/agy-permissions.example.json` grants agy shell access. It was written to
do that with destructive commands blocked. As applied today it blocks nothing at
all — see **Measured, 2026-08-20** below. Read this first, because the template
is far weaker protection than it looks.

## What it is, and what it is not

It is **defence against sloppiness** — a cleanup task with a bad path, a recursive
delete pointed at the wrong directory. That is the realistic failure mode, and
this catches a lot of it.

It is **not a security boundary**, and cannot be made into one. Three reasons, in
increasing order of how much they matter.

### 1. Deny-lists enumerate badness

There is no complete list of ways to destroy files. The template blocks the ones
worth blocking, plus interpreter one-liners (`node -e`, `python -c`, `cmd /c`)
which are the standard way around a command allow-list. It will not be complete.

### 2. On Windows, the matching itself is buggy

[antigravity-cli issue #614](https://github.com/google-antigravity/antigravity-cli/issues/614)
reports two bugs on Windows 10+:

- **`command()` allow rules fail to match.** The parser splits on spaces before
  handling quotes, so `git` resolving to `C:\Program Files\Git\cmd\git.exe` is
  evaluated as just `C:\Program`. Clicking "Yes permanently" saves a malformed
  rule that never matches again.
- **Path wildcards crash it** — `write_file(C:\path\*)` fails with
  `globs not supported` and blocks all agent actions. The template therefore uses
  bare directory paths, which are recursive anyway.

The documented workaround for the first is `command(*)` — allow everything, which
defeats the point. So expect the allow side to be unreliable here. Deny rules use
the same matching, so they may be affected too.

**Measured, 2026-08-20 — they are affected, and fatally.**
`scripts/probe-agy-deny.ts` was run with `command(*)` in the allow list. agy was
asked to delete a canary file and did so in 33 seconds, with `command(del)`
present both in the deny list and in the driver's non-negotiable
`MINIMUM_DENY`.

The cause is the same whole-string matching: `command(del)` matches only the
literal string `del`, never `del do-not-delete.txt`. Every deny rule has that
shape, so **none of them fire against a real command carrying arguments**. With
`command(*)` applied, agy has an unrestricted shell on this account.

Until this was measured the deny list was believed to be a working backstop. The
earlier canary that appeared to prove it ran under default-deny, where the file
would have survived an empty deny list too. See `docs/DECISIONS.md`,
"2026-08-20 — Widen agy to command(*)".

### 3. Running tests *is* running arbitrary code

This is the one that decides it. For a coding agent, permission to run the test
suite is permission to execute anything, because the agent writes the tests:

```ts
// src/anything.test.ts, authored by the agent
import { rmSync } from 'node:fs';
rmSync('C:/Users/you', { recursive: true, force: true });
```

`npm test` is on any workable allow-list. No command rule prevents this.

And note this exposure **already exists in ShanAuto regardless of agy**: the gate
runs `npm run typecheck && npm test`, so the orchestrator executes agent-authored
test files on every task, with your full user privileges. Gating on tests is still
the right call — it is what makes commits mean something — but it is worth knowing
that the door is already ajar before deciding how much the agy question changes.

## Applying it

The automated version of everything below is
`scripts/agy-access.ps1 -Apply` — it reads the template, substitutes the paths,
backs up the original settings.json, flips agy back into `config/drivers.yaml`
rotation, and sets `sandbox: false`. Manual application is only for when you want
something different from the template:

1. Read `config/agy-permissions.example.json` end to end.
2. Replace every `REPLACE_ME` path with real absolute paths.
3. **Replace** the `permissions` block in
   `%USERPROFILE%\.gemini\antigravity-cli\settings.json` with the template's.
   Keep every OTHER top-level key you already have (`model`,
   `trustedWorkspaces`, …) — those you merge; the `permissions` block itself you
   overwrite wholesale.
4. Strip the `_README` and `_comment` entries if agy complains; they are notes.

### Why the permissions block is replaced and not merged

A merge would permanently bless any rule that had found its way into the live
file, and an allow-list that can grow on its own is not an allow-list. The cost
is that a rule existing *only* in the live file is dropped, so **the template has
to be a superset of what is actually in use**.

It drifted out of superset once. Measured 2026-08-15: the live file carried 24
allow rules the template did not (`command(dir)`, the pytest and read-only git
variants, the `--version` probes). `-Apply` would have silently removed all 24
and reported only `applied N allow and M deny rules`; the operator would have
discovered it as a run full of denials with no stated cause. The template now
carries them.

`-Apply` prints any such rule and refuses to continue without a typed `drop`
(or `-Force`). A host with nobody to ask counts as "no" and cancels, changing
nothing. So a future drift costs you one cancelled command, not a silently
weakened permission set.

Precedence is **Deny > Ask > Allow**, so deny wins. In headless `-p` mode there is
nobody to answer an `ask`, so anything in `ask` behaves as a deny.

Then re-enable agy in `config/drivers.yaml`:

```yaml
routing:
  complex_agents: [agy]           # ensure agy is in this array. It is the only
                                  # member since copilot was removed 2026-08-15,
                                  # so leaving it out stops complex work entirely.
agents:
  registry:
    agy:
      sandbox: false             # REQUIRED for command access. With the sandbox ON,
                                 # every command additionally needs `escalate_admin`,
                                 # which headless mode cannot prompt for — so nothing
                                 # would run at all. This is why the config schema
                                 # defaults an omitted `sandbox` to true and production
                                 # writes false explicitly.
      skip_permissions: false    # leave OFF — the allow-list is the point
```

(The old singular `complex_agent: agy` key is gone — routing uses the
`complex_agents` array. `scripts/agy-access.ps1 -Apply` / `-Revert` add and
remove `agy` from that array for you.)

The driver does not trust this silently. `agent.agy.ts` carries a non-negotiable
deny set (`MINIMUM_DENY` + a self-protection rule on settings.json itself), and
before every **unsandboxed** run it reads the live settings.json and refuses the
run (`AGY_PERMISSIONS`) if any rule is missing — a degraded allow-list can no
longer pass unremarked. `sa doctor` surfaces the same check. Run
`scripts/agy-access.ps1 -Apply` (or add the missing rules by hand) to restore it.

## Verify it actually took effect

Do not trust it silently, given issue #614. Signed in as yourself:

```bash
npx tsx scripts/probe-agy.ts
```

A pass means agy can still edit files. Then check a denied command is genuinely
refused — ask agy to run `del` against a throwaway file in a scratch directory and
confirm it is blocked rather than performed. If a deny rule does not fire, the
matching is broken on your machine and this whole layer is providing nothing.

## The honest recommendation

Measured on this machine: agy contributed **0 commits from 9 attempts** without
command permission, because real tasks need to inspect the codebase first. So the
choice is binary — grant shell access, or leave agy out.

Its only benefit is a second, independent provider quota. The system already
produces commits without it. If you have ever seen an agent damage this machine,
that trade is not obviously worth it.

If you do grant it, the meaningful protections are, in order:

1. `scripts/setup-restricted-account.ps1` — the only real boundary
2. the in-driver fail-closed check — an unsandboxed agy whose settings.json is
   missing any mandatory deny rule refuses to run, so a degraded allow-list
   cannot silently pass (`agent.agy.ts` / `sa doctor`)
3. this template — catches accidents, not intent

Note the sandbox is not on this list: it is **mutually exclusive** with command
access, so an agy that can run commands at all is unsandboxed by definition. The
trade is the whole reason this file exists.
