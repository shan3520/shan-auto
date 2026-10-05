# Part 5 — §9.1: agy driver deep review

agy is the one agent that cannot take a deny-list on the command line. Copilot
has `--deny-tool`, opencode has injected config; agy's permissions live in
`%USERPROFILE%\.gemini\antigravity-cli\settings.json`, a file only
`scripts/agy-access.ps1 -Apply` writes. The audit's §9.1 named this the #1
uncovered surface: the allow-list was loaded by a manual script and nothing in
the orchestrator checked it. This part moved enforcement into the driver — an
unsandboxed agy whose settings.json has lost any mandatory deny rule now refuses
to run — locked the security defaults into the config schema, and reconciled the
three places (schema, drivers.yaml, agy-permissions.md) that said different
things about `sandbox`. `npm run typecheck` clean, full suite green (**736 passed
/ 53 files**, +17 tests in a new file), one commit.

---

## Done

### §9.1a — In-driver deny-list enforcement (`src/drivers/agent.agy.ts`)

- **`MINIMUM_DENY`** — the non-negotiable deny tokens, mirrored from the
  *currently deployed* settings.json set (not the strongest imaginable set), so
  the new fail-closed check cannot break the operator's production agy on the
  first night. Same categories as the opencode/copilot lists: destructive
  filesystem, interpreter one-liners (SEC-2), git history/remotes, machine and
  account state, network egress, publishing.
- **`agySettingsPath()`** — overridable via `SHANAUTO_AGY_SETTINGS`, which is
  what lets the tests point at a throwaway file instead of the live one.
- **`selfProtectionDeny()`** — `write_file(<settings path>)`: the agent must
  never be able to rewrite the very permissions that constrain it.
- **`readAgyDenies()`** — reads the live file; `null` on missing/unreadable/
  corrupt, which fails closed.
- **`missingAgyDenies()`** — which mandatory rules are absent, given the file's
  deny array (or null).

### §9.1b — The pre-flight in `execute()`

Before every run: read the settings.json, compare against `MINIMUM_DENY ∪
selfProtection`. **Sandbox OFF + missing rules → refuse** with reason
`AGY_PERMISSIONS` (non-fatal, no provider call), naming the file, the missing
rules, and the fix. **Sandbox ON + missing rules → warning only**, because the
sandbox itself denies every command. The distinction is the same one the schema
makes: the allow-list is only ever the *only* control when the sandbox is off.

### §9.1c — `healthCheck()` fails closed too

`sa doctor` must not report "all checks passed" over an unsandboxed agy whose
allow-list has degraded. It now returns `ok: false` in exactly that state, naming
`scripts/agy-access.ps1 -Apply`. Sandboxed, it stays green but notes the missing
rules in `detail`.

### §9.1d — Schema locks the defaults (`src/schemas.ts`)

`DriverEntry` now carries typed, defaulted security fields — `sandbox` (default
**true**), `skip_permissions` (default false), `deny` (default `[]`) — with
`.passthrough()` keeping every driver-specific key. An omitted `sandbox` means
ON; production must write `sandbox: false` *explicitly* to hand control to the
allow-list. The driver's old `?? true` guess is gone.

### §9.1e — Template strengthened, dead rule removed (`config/agy-permissions.example.json`)

- Removed `command(npm run lint)` — no such script has existed since Part 3, so
  the template offered an allow rule that always fails.
- Added the deny categories the deployed set was missing: `git remote` /
  `git credential`, `Clear-Content`, `attrib`, `Set-ExecutionPolicy`, `node -p` /
  `node --input-type=`, `python3 -c` / `py -c`, `powershell -EncodedCommand` /
  `powershell.exe -Command` / `pwsh -Command` / `pwsh -EncodedCommand`,
  `cmd /k`, `irm`, `net user`.
- The `_README` block now states the in-driver enforcement and flags the stronger
  rules as a **contract change** that takes effect on the next `-Apply`.

### §9.1f — Documentation reconciled

- `config/agy-permissions.md` said `sandbox: true # keep this ON` in "Applying
  it" and listed `sandbox: true` as a protection — both contradict the deployed
  reality (sandbox must be OFF for command access; the whole file is about the
  trade of granting it). Fixed, with the schema default documented, and "Applying
  it" now points at `scripts/agy-access.ps1 -Apply` as the automated path.
- `config/drivers.yaml` agy entry now notes that the driver enforces the
  mandatory deny set.

### §9.1g — Tests (`src/__tests__/agy-permissions.test.ts`, 17 tests)

`readAgyDenies` (missing / corrupt / absent / present), `missingAgyDenies`
(fail-closed-on-null, complete, names-the-absent), schema defaults (omitted →
safe values; explicit `sandbox:false`), **template contract** (every
`MINIMUM_DENY` token is present in the real example file), `execute()` pre-flight
(refuse-unsandboxed-without-calling-the-agent, sandboxed-still-runs-with
`--sandbox`, unsandboxed-clean-without-`--sandbox`), and `healthCheck()` posture
(degraded-unsandboxed fails, sandboxed notes-but-passes, clean passes exactly).

All execute/healthCheck tests use `SHANAUTO_AGY_SETTINGS` + `SHANAUTO_DB` so
neither the live settings.json nor the real run journal is touched.

---

## Not done (deferred)

| Observation | Where it lands |
|---|---|
| The strengthened deny rules (`git remote`, `git credential`, …) are **not yet in the operator's live settings.json** — that is `scripts/agy-access.ps1 -Apply`'s job, an operator action, deliberately not performed. The deployed set already satisfies `MINIMUM_DENY`, so nothing is blocked meanwhile | Next operator `-Apply` |
| The allow-side of the contract (`command(*)` backstop, per-repo workspaces) is unchanged — enforcement here only guarantees the deny set, it does not redesign the allow-list | consciously unchanged |
| `sandbox: true` as a *file-edit-only* mode for agy (commands denied, edits allowed) is now genuinely enforceable and documented, but not enabled | if ever wanted, `sandbox: true` in drivers.yaml |

---

## Design & architecture decisions

1. **Enforcement moves into the driver; the allow-list writer stays external.**
   agy cannot take a deny-list flag and has no injected config, so the choice
   was: validate `agy-permissions.example.json` in the orchestrator at boot, or
   have the driver read the *live* settings.json before each run. We chose the
   driver reading the file the agent actually consults — enforcement is
   co-located with the code that depends on it, fails closed with a reason code,
   and cannot drift from what agy truly sees. `scripts/agy-access.ps1` remains
   the only *writer* (single owner of the allow-list contract), but it is no
   longer the only *enforcer*.

2. **`MINIMUM_DENY` mirrors what is deployed, not the strongest possible set.**
   A fail-closed check that demanded rules the live settings.json lacks would
   have broken the operator's production agy on the first unsandboxed run. The
   driver enforces the deployed set; the template carries the stronger
   opencode/copilot categories as a forward-looking contract change applied on
   the next `-Apply`. The strength of the check is bounded by the weakest apply,
   deliberately — failing safe is not the same as failing loud.

3. **Fail-closed only where the allow-list is the only control: sandbox OFF.**
   With the sandbox on, every command is already denied, so a missing deny rule
   rates a warning, not a refusal. The refusal is reserved for the one state
   where nothing else contains the agent. `doctor` follows the same rule: it must
   not bless a degraded allow-list, but a sandboxed agy passes with a note.

4. **Self-protection is part of the non-negotiable set.** `write_file(<settings
   path>)` is included in what `execute()` refuses to run without. Without it
   every other rule is moot the first time the agent is talked into editing its
   own settings.

5. **Schema defaults are the lock; the driver no longer guesses.** An omitted
   `sandbox` defaults to true — the safe direction — and production writes
   `false` explicitly. This is why the schema comment says *"Production has to
   write `sandbox: false` explicitly"*: the enforcement handover is a deliberate
   act, not an accident of a default.

6. **Tests run against the real template, not a copy.** The contract test reads
   `config/agy-permissions.example.json` and asserts every `MINIMUM_DENY` token
   is present — the "test against the rule, not a copy of the rule" pattern this
   repo learned the hard way (ISSUES.md, O16). And the execute tests never read
   the operator's live settings.json: `SHANAUTO_AGY_SETTINGS` redirects the path
   and `SHANAUTO_DB` redirects the run journal.

7. **One change reverted for a legitimate reason.** A cosmetic simplification of
   copilot's `opts.deny` read broke a test that constructs the driver directly
   (bypassing the schema). Direct construction is a real pattern, so the
   defensive `?? []` stayed; the schema default is the config-path guarantee.
   The driver-no-longer-guesses rule applies to agy's `sandbox`, where the safe
   default is load-bearing.
