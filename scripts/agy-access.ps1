<#
.SYNOPSIS
  Grants or revokes agy's shell access, in one command each way.

.DESCRIPTION
  -Apply   REPLACES the permissions block in agy's settings.json with the one built
           from config/agy-permissions.example.json (backing up the original first)
           and puts agy back in the routing rotation.

           Replaces, not merges. This is deliberate: a merge would permanently bless
           any rule that had found its way into the live file, and the one thing an
           allow-list must never do is grow on its own. The cost is that a rule which
           exists ONLY in the live file is dropped, so -Apply prints every such rule
           and asks before writing. If you want to keep one, put it in the template.
  -Revert  restores the pre-ShanAuto settings backup and takes agy out of rotation.
           This is the nuke button. It is safe to run at any time, including when
           nothing has been applied.
  -Status  prints what is currently in effect, changing nothing.

  The backup is written ONCE, on the first -Apply, so -Revert always returns you to
  the state before ShanAuto ever touched the file - not to an intermediate state.

.EXAMPLE
  .\scripts\agy-access.ps1 -Status
  .\scripts\agy-access.ps1 -Apply -Repos 'D:\repos\shanauto'
  .\scripts\agy-access.ps1 -Revert
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    [Parameter(ParameterSetName = 'Apply')]  [switch]   $Apply,
    [Parameter(ParameterSetName = 'Revert')] [switch]   $Revert,
    [Parameter(ParameterSetName = 'Status')] [switch]   $Status,
    [Parameter(ParameterSetName = 'Apply')]  [string[]] $Repos,
    # Answer yes to the "these live rules will be dropped" prompt. For a caller
    # that already knows what it is discarding, never as a way past reading it.
    [Parameter(ParameterSetName = 'Apply')]  [switch]   $Force
)

$ErrorActionPreference = 'Stop'

$root       = Split-Path -Parent $PSScriptRoot
$settings   = Join-Path $env:USERPROFILE '.gemini\antigravity-cli\settings.json'
$backup     = "$settings.pre-shanauto.bak"
$template   = Join-Path $root 'config\agy-permissions.example.json'
$driversCfg = Join-Path $root 'config\drivers.yaml'

function Read-Json([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    Get-Content $Path -Raw | ConvertFrom-Json
}

function Write-Json([string]$Path, $Object) {
    # UTF-8 WITHOUT a BOM, written through .NET rather than Set-Content.
    #
    # In Windows PowerShell 5.1 -- which is what runs this on this machine --
    # `-Encoding UTF8` means "UTF-8 WITH BOM". agy parses settings.json strictly
    # and a leading U+FEFF makes the whole file invalid JSON, so it loads NO
    # permissions at all and auto-denies every single command. The failure looks
    # exactly like a missing allow-rule, which is how it survived: the script
    # that grants shell access was silently revoking it.
    #
    # Caught on 2026-08-10 by applying the file and then failing to parse it:
    #   SyntaxError: Unexpected token '﻿'
    $json = $Object | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

# agy rejects entries that are not real rules, so the human-readable notes in the
# template (anything starting with "_") are stripped on the way in.
function Select-Rules($Items) {
    if (-not $Items) { return @() }
    @($Items | Where-Object { $_ -is [string] -and -not $_.StartsWith('_') })
}

function Set-AgyRotation([bool]$Present) {
    # The rotation toggle used to target a single `complex_agent:` key that no
    # longer exists (routing is the ARRAY form `complex_agents: [...]` in
    # config/drivers.yaml) — it silently wrote nothing while claiming success.
    # This rewrites the real array: $true inserts agy, $false removes it, and an
    # absent array is a hard error, never a silent no-op.
    $yaml = Get-Content $driversCfg -Raw
    $m = [regex]::Match($yaml, '(?m)^(\s*complex_agents:\s*)\[[^\]]*\]')
    if (-not $m.Success) {
        throw "config/drivers.yaml: no 'complex_agents: [...]' array found - cannot change agy's rotation"
    }
    # Only the text INSIDE the brackets is the array; splitting the whole match
    # would leak the 'complex_agents:' key itself into the agent list.
    $inner = [regex]::Match($m.Value, '\[([^\]]*)\]').Groups[1].Value
    $agents = @($inner -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($Present) {
        if ($agents -notcontains 'agy') { $agents = @($agents + 'agy') }
    }
    else {
        $agents = @($agents | Where-Object { $_ -ne 'agy' })
    }
    $rendered = "$($m.Groups[1].Value)[$($agents -join ', ')]"
    $yaml = $yaml.Substring(0, $m.Index) + $rendered + $yaml.Substring($m.Index + $m.Length)
    Set-Content -Path $driversCfg -Value $yaml -NoNewline
    Write-Host "  drivers.yaml: complex_agents = [$($agents -join ', ')]" -ForegroundColor Green

    # Copilot was removed on 2026-08-15, leaving agy the only complex agent — so
    # a revoke now EMPTIES this array, which it never used to. The router keeps
    # working (it borrows routing.default), but that default is opencode, the
    # SIMPLE-work agent, and every heavy multi-file job then goes to it.
    #
    # Not blocked. This is the panic button; it has to work in a hurry and must
    # not argue. It is said, loudly, so the consequence is not discovered from a
    # day of failed jobs.
    if ($agents.Count -eq 0) {
        Write-Host ''
        Write-Host '  WARNING: no complex agent is left in rotation.' -ForegroundColor Yellow
        Write-Host '  Complex jobs will fall through to routing.default, which is the simple-work' -ForegroundColor Yellow
        Write-Host '  agent. Expect them to fail their gate. `npm run sa -- route` now says so on' -ForegroundColor Yellow
        Write-Host '  every affected job. Re-run this script with -Apply to put agy back.' -ForegroundColor Yellow
    }
}

# --sandbox and shell commands are mutually exclusive: in sandbox mode a terminal
# command also needs `escalate_admin`, which headless mode cannot prompt for, so
# every command is denied. Granting command access therefore requires sandbox off.
function Set-AgySandbox([string]$Value) {
    $yaml = Get-Content $driversCfg -Raw
    $pattern = '(?m)^(\s*sandbox:\s*)\S+'
    if (-not [regex]::IsMatch($yaml, $pattern)) {
        throw "config/drivers.yaml: no 'sandbox:' key found - cannot set agy sandbox mode"
    }
    $yaml = [regex]::Replace($yaml, $pattern, "`${1}$Value")
    Set-Content -Path $driversCfg -Value $yaml -NoNewline
    Write-Host "  drivers.yaml: sandbox -> $Value" -ForegroundColor Green
}

function Show-Status {
    Write-Host ''
    Write-Host '  agy shell access status' -ForegroundColor Cyan
    Write-Host '  -----------------------'

    $cur = Read-Json $settings
    if ($null -eq $cur) {
        Write-Host '  settings.json  : NOT FOUND'
    }
    elseif ($cur.PSObject.Properties.Name -contains 'permissions') {
        $allow = Select-Rules $cur.permissions.allow
        $deny  = Select-Rules $cur.permissions.deny
        Write-Host "  permissions    : PRESENT  ($($allow.Count) allow, $($deny.Count) deny)" -ForegroundColor Yellow
        if ($allow -contains 'command(*)') {
            # Measured 2026-08-20 by scripts/probe-agy-deny.ts: with command(*)
            # applied, agy deleted a canary that command(del) denies. agy matches
            # rules as whole strings and supports no globs (issue #614), so a deny
            # rule never matches a real command carrying arguments. Printing a deny
            # COUNT and nothing else reads as protection that is not there.
            Write-Host '  shell          : UNRESTRICTED - command(*) is allow-listed' -ForegroundColor Red
            Write-Host "                   the $($deny.Count) deny rules do NOT fire (verified)" -ForegroundColor Red
        }
    }
    else {
        Write-Host '  permissions    : absent (agy cannot run shell commands)' -ForegroundColor Green
    }

    Write-Host "  backup exists  : $(Test-Path $backup)"

    $m = [regex]::Match((Get-Content $driversCfg -Raw), '(?m)^\s*complex_agents:\s*\[[^\]]*\]')
    if ($m.Success) { Write-Host "  complex_agents : $($m.Value.Trim())" }
    Write-Host ''
}

# ---------------------------------------------------------------- status ----
if ($Status -or $PSCmdlet.ParameterSetName -eq 'Status') {
    Show-Status
    Write-Host '  -Apply to grant, -Revert to nuke.' -ForegroundColor DarkGray
    Write-Host ''
    return
}

# ---------------------------------------------------------------- revert ----
if ($Revert) {
    Write-Host ''
    Write-Host '  Revoking agy shell access' -ForegroundColor Cyan

    if (Test-Path $backup) {
        Copy-Item $backup $settings -Force
        Write-Host '  restored settings.json from pre-ShanAuto backup' -ForegroundColor Green
    }
    elseif (Test-Path $settings) {
        # No backup: strip the permissions key rather than guessing at the original.
        $cur = Read-Json $settings
        if ($cur.PSObject.Properties.Name -contains 'permissions') {
            $cur.PSObject.Properties.Remove('permissions')
            Write-Json $settings $cur
            Write-Host '  removed the permissions block (no backup found)' -ForegroundColor Green
        }
        else {
            Write-Host '  nothing to remove - permissions was already absent' -ForegroundColor Green
        }
    }
    else {
        Write-Host '  settings.json not found - nothing to do' -ForegroundColor Green
    }

    Set-AgyRotation $false
    Set-AgySandbox 'true'

    Write-Host ''
    Write-Host '  DONE. agy can no longer run shell commands and is out of rotation.' -ForegroundColor Green
    Write-Host '  Verify with:  .\scripts\agy-access.ps1 -Status'
    Write-Host ''
    return
}

# ----------------------------------------------------------------- apply ----
if ($Apply) {
    <#
      Default to EVERY enabled repo in repos.yaml, not just this one.

      This defaulted to $root — the shanauto directory. agy's allow-list and
      repos.yaml were therefore two independent lists with nothing keeping them
      in step: adding example-api to repos.yaml granted agy nothing, and all nine
      tasks of the first real run were auto-denied before writing a line. The
      run reported "agent produced no file changes" nine times, which reads as a
      lazy agent rather than a permission list nobody remembered existed.
    #>
    if (-not $Repos -or $Repos.Count -eq 0) {
        $reposCfg = Join-Path $root 'config\repos.yaml'
        $Repos = @(
            Get-Content $reposCfg |
                Select-String -Pattern '^\s{2,}path:\s*(\S+)\s*$' |
                ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() -replace '/', '\' }
        )
        if (-not $Repos -or $Repos.Count -eq 0) { $Repos = @($root) }
    }
    foreach ($r in $Repos) {
        if (-not (Test-Path $r)) { throw "Repo path does not exist: $r" }
    }

    Write-Host ''
    Write-Host '  Granting agy shell access' -ForegroundColor Yellow
    Write-Host '  This lets an unattended agent run shell commands as you.'
    Write-Host '  This is NOT a security boundary - see config/agy-permissions.md.'
    Write-Host '  Whether the deny list stops anything is reported at the end of'
    Write-Host '  this run. Undo at any time with -Revert.'
    Write-Host ''

    $tpl = Read-Json $template
    if ($null -eq $tpl) { throw "Template not found: $template" }

    $deny  = Select-Rules $tpl.permissions.deny
    $allow = Select-Rules $tpl.permissions.allow

    # Substitute the real paths the template leaves as placeholders.
    $deny = @($deny | ForEach-Object {
            $_.Replace('REPLACE_ME_USERPROFILE\', "$env:USERPROFILE\")
        })
    $allow = @(
        $allow | Where-Object { $_ -notmatch 'REPLACE_ME_REPO_PATH' }
    )

    foreach ($repo in $Repos) {
        $allow += "read_file($repo)"
        $allow += "write_file($repo)"
    }

    $cur = Read-Json $settings
    if ($null -eq $cur) { throw "agy settings not found at $settings. Run agy once first." }

    <#
      -Apply REPLACES the permissions block, so any rule living only in the live
      file is about to disappear. That is the right default — an allow-list must
      never grow on its own — but it must never happen silently either.

      Measured 2026-08-15: the live file had drifted to 24 allow rules the
      template did not carry (`command(dir)`, the pytest and read-only git
      variants, the version probes). -Apply would have dropped all 24 and said
      only "applied N allow and M deny rules", and the operator would have found
      out as a run full of denials with no obvious cause. The template now
      carries them, so this prints nothing on a matched pair — it exists to catch
      the NEXT drift, not that one.
    #>
    $liveAllow = Select-Rules $cur.permissions.allow
    $liveDeny  = Select-Rules $cur.permissions.deny
    $lostAllow = @($liveAllow | Where-Object { $allow -notcontains $_ })
    $lostDeny  = @($liveDeny  | Where-Object { $deny  -notcontains $_ })

    if ($lostAllow.Count -or $lostDeny.Count) {
        Write-Host ''
        Write-Host "  $($lostAllow.Count + $lostDeny.Count) rule(s) in effect right now are NOT in the template," -ForegroundColor Yellow
        Write-Host '  and applying it will remove them:' -ForegroundColor Yellow
        foreach ($r in $lostDeny)  { Write-Host "    - DENY   $r" -ForegroundColor Red }
        foreach ($r in $lostAllow) { Write-Host "    - allow  $r" -ForegroundColor Yellow }
        Write-Host ''
        Write-Host '  A dropped DENY rule widens what agy may do. A dropped allow rule'
        Write-Host '  makes jobs fail as denials with no obvious cause. To keep any of'
        Write-Host "  them, add the line to $template and run this again."
        Write-Host ''
        if (-not $Force) {
            # Read-Host THROWS on a non-interactive host rather than returning
            # empty. Either way there is nobody to consent, so both paths land on
            # the same answer: cancel. Caught so that reads as one plain line and
            # not a PowerShell stack trace at an operator who cannot act on it.
            $answer = ''
            try { $answer = Read-Host '  Type "drop" to apply anyway, anything else to cancel' }
            catch { Write-Host '  (nothing here can ask you, so taking that as no)' -ForegroundColor DarkGray }
            if ($answer -ne 'drop') {
                Write-Host '  Cancelled. Nothing was changed.' -ForegroundColor Green
                return
            }
        }
        else {
            Write-Host '  -Force given, dropping them.' -ForegroundColor Yellow
        }
    }
    else {
        Write-Host '  template covers everything currently in effect - no rule will be lost' -ForegroundColor Green
    }

    # Written once, so -Revert always returns to the true original.
    if (-not (Test-Path $backup)) {
        Copy-Item $settings $backup -Force
        Write-Host "  backed up original -> $backup" -ForegroundColor Green
    }
    else {
        Write-Host '  backup already exists, leaving it as the pristine copy' -ForegroundColor DarkGray
    }

    $perms = [pscustomobject]@{ allow = $allow; deny = $deny; ask = @() }
    if ($cur.PSObject.Properties.Name -contains 'permissions') {
        $cur.permissions = $perms
    }
    else {
        $cur | Add-Member -NotePropertyName permissions -NotePropertyValue $perms
    }
    Write-Json $settings $cur

    Write-Host "  applied $($allow.Count) allow and $($deny.Count) deny rules" -ForegroundColor Green
    foreach ($repo in $Repos) { Write-Host "    workspace: $repo" }

    Set-AgyRotation $true
    # Required: with the sandbox on, every command needs escalate_admin, which
    # headless cannot grant, so nothing would run at all.
    Set-AgySandbox 'false'

    Write-Host ''
    Write-Host '  TRADE-OFF YOU HAVE JUST ACCEPTED:' -ForegroundColor Yellow
    Write-Host '    agy sandbox is now OFF. It has to be - in sandbox mode every command'
    Write-Host '    also needs escalate_admin, which headless mode cannot prompt for.'
    if ($allow -contains 'command(*)') {
        Write-Host ''
        Write-Host '    AND command(*) is allow-listed, so there is NO default-deny.' -ForegroundColor Red
        Write-Host '    agy can run ANY shell command as you. The deny rules do NOTHING:' -ForegroundColor Red
        Write-Host '    agy matches whole strings and has no globs (issue #614), so the' -ForegroundColor Red
        Write-Host '    rule command(del) never matches an actual del of a named file.' -ForegroundColor Red
        Write-Host '    Verified 2026-08-20: probe-agy-deny.ts watched agy delete the' -ForegroundColor Red
        Write-Host '    canary anyway. Your only real protection is the nuke button.' -ForegroundColor Red
    }
    else {
        Write-Host '    Your protection is now the default-deny allow-list, nothing else.'
    }
    Write-Host ''
    Write-Host '  VERIFY BEFORE ANY UNATTENDED RUN:' -ForegroundColor Yellow
    Write-Host '    npx tsx scripts/probe-agy.ts        # agy can still edit files'
    Write-Host '    npx tsx scripts/probe-agy-deny.ts   # do the deny rules actually fire?'
    Write-Host ''
    Write-Host '  NUKE BUTTON:  double-click scripts\NUKE-agy-access.cmd' -ForegroundColor Cyan
    Write-Host '            or:  .\scripts\agy-access.ps1 -Revert'
    Write-Host ''
}
