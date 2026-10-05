<#
.SYNOPSIS
  Creates a low-privilege Windows account for ShanAuto to run under, so an agent
  shell command cannot reach the rest of the machine.

.DESCRIPTION
  This is the only measure in the whole system that genuinely CONTAINS an agent.
  Everything else - the commit gate, protected paths, rollback - inspects the git
  diff after the fact. A file deleted outside the repo never appears in a diff,
  and rollback cannot bring it back.

  What a standard (non-admin) account blocks for free:
    - writing to C:\Windows and C:\Program Files  (needs admin)
    - reading or writing C:\Users\<you>           (other profiles are protected)

  What it does NOT block by default, and why this script exists:
    On this machine 'NT AUTHORITY\Authenticated Users' has Modify on D:\ and
    everything beneath it. A new account would therefore inherit write access to
    every project on that drive. This script denies the agent account D:\ and then
    grants it back ONLY the repos you name.

  ACL note: an explicit ALLOW on a child beats an inherited DENY from its parent.
  That is what makes the deny-the-drive / allow-the-repos pattern work.

.NOTES
  Run from an ELEVATED PowerShell. Review it before running - it changes account
  and filesystem security settings.

.EXAMPLE
  .\scripts\setup-restricted-account.ps1 -Repos 'D:\repos\shanauto','D:\my-project'
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]   $UserName    = 'shanauto-agent',
    [string]   $ProtectDrive = 'D:\',
    [Parameter(Mandatory)]
    [string[]] $Repos
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Run as administrator).'
    }
}

Assert-Admin

foreach ($r in $Repos) {
    if (-not (Test-Path $r)) { throw "Repo path does not exist: $r" }
}

Write-Host ''
Write-Host '  ShanAuto restricted account setup' -ForegroundColor Cyan
Write-Host '  ---------------------------------'
Write-Host "  account        : $UserName  (standard user, NOT an administrator)"
Write-Host "  deny write to  : $ProtectDrive  (and everything inheriting from it)"
Write-Host '  grant write to :'
$Repos | ForEach-Object { Write-Host "                   $_" }
Write-Host ''
Write-Host '  C:\Windows, C:\Program Files and your own user profile are already'
Write-Host '  protected from a standard account by Windows itself.'
Write-Host ''

if (-not $PSCmdlet.ShouldProcess("$UserName and ACLs on $ProtectDrive", 'Create account and apply restrictions')) {
    Write-Host '  Nothing changed.' -ForegroundColor Yellow
    return
}

# --- 1. the account -------------------------------------------------------
if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
    Write-Host "  account $UserName already exists, leaving it alone" -ForegroundColor Yellow
}
else {
    # Prompted here so the password is never written into a script or a log.
    $pw = Read-Host -AsSecureString "  Choose a password for $UserName"
    New-LocalUser -Name $UserName -Password $pw -FullName 'ShanAuto agent' `
        -Description 'Low-privilege account for autonomous coding agents' `
        -PasswordNeverExpires -UserMayNotChangePassword | Out-Null

    # Deliberately NOT added to Administrators. Membership of Users is enough.
    Add-LocalGroupMember -Group 'Users' -Member $UserName -ErrorAction SilentlyContinue
    Write-Host "  created $UserName" -ForegroundColor Green
}

$account = "$env:COMPUTERNAME\$UserName"

# --- 2. deny the whole data drive ----------------------------------------
Write-Host "  denying $account write access to $ProtectDrive ..."
$acl = Get-Acl $ProtectDrive
$deny = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $account,
    'Modify',
    'ContainerInherit,ObjectInherit',
    'None',
    'Deny')
# Idempotent: an identical ACE is added once. A second AddAccessRule would just
# pile up a duplicate that shows in every ACL listing and never gets cleaned up.
$alreadyDenied = @($acl.Access | Where-Object {
        $_.AccessControlType -eq 'Deny' -and
        $_.IdentityReference.Value -ieq $account -and
        $_.FileSystemRights -eq 'Modify' -and
        $_.InheritanceFlags -eq 'ContainerInherit,ObjectInherit'
    })
if ($alreadyDenied.Count -gt 0) {
    Write-Host '    already denied - nothing to do' -ForegroundColor DarkGray
}
else {
    $acl.AddAccessRule($deny)
    Set-Acl -Path $ProtectDrive -AclObject $acl
    Write-Host '    done' -ForegroundColor Green
}

# --- 3. grant back only the repos ----------------------------------------
# An explicit ALLOW on the child overrides the inherited DENY above.
foreach ($repo in $Repos) {
    Write-Host "  granting $account full access to $repo ..."
    $racl = Get-Acl $repo
    $allow = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $account,
        'FullControl',
        'ContainerInherit,ObjectInherit',
        'None',
        'Allow')
    $alreadyAllowed = @($racl.Access | Where-Object {
            $_.AccessControlType -eq 'Allow' -and
            $_.IdentityReference.Value -ieq $account -and
            $_.FileSystemRights -eq 'FullControl' -and
            $_.InheritanceFlags -eq 'ContainerInherit,ObjectInherit'
        })
    if ($alreadyAllowed.Count -gt 0) {
        Write-Host '    already allowed - nothing to do' -ForegroundColor DarkGray
    }
    else {
        $racl.AddAccessRule($allow)
        Set-Acl -Path $repo -AclObject $racl
        Write-Host '    done' -ForegroundColor Green
    }
}

# --- 4. allow Task Scheduler to run jobs as this account ------------------
Write-Host '  granting "Log on as a batch job" ...'
$tmp = Join-Path $env:TEMP "sa-secpol-$PID"
secedit /export /cfg "$tmp.inf" /quiet
$sid = (Get-LocalUser $UserName).SID.Value
$content = Get-Content "$tmp.inf"
# Idempotent: a re-run must not append the SID to SeBatchLogonRight a second
# time (harmless to Windows, but the secedit round-trip is an admin change).
if ($content -match [regex]::Escape($sid)) {
    Write-Host '    already granted - nothing to do' -ForegroundColor DarkGray
}
else {
    if ($content -match '^SeBatchLogonRight') {
        $content = $content -replace '^(SeBatchLogonRight\s*=\s*.*)$', "`$1,*$sid"
    }
    else {
        $content += "SeBatchLogonRight = *$sid"
    }
    $content | Set-Content "$tmp.inf"
    secedit /configure /db "$tmp.sdb" /cfg "$tmp.inf" /areas USER_RIGHTS /quiet
}
Remove-Item "$tmp.*" -Force -ErrorAction SilentlyContinue
Write-Host '    done' -ForegroundColor Green

Write-Host ''
Write-Host '  Account is ready. THREE MANUAL STEPS REMAIN:' -ForegroundColor Cyan
Write-Host ''
Write-Host '  1. Install the toolchain for this account. node, opencode and agy are'
Write-Host '     all installed per-user under C:\Users\<you>, so the new account'
Write-Host '     cannot see any of them. Sign in as the account once and install:'
Write-Host '        node (or add a machine-wide install to PATH), opencode, agy'
Write-Host ''
Write-Host '  2. Authenticate as that account:'
Write-Host '        opencode auth       # Google / Groq credentials'
Write-Host '        agy                 # sign in to Antigravity'
Write-Host '     Credentials live in the user profile and are NOT shared.'
Write-Host ''
Write-Host '  3. Re-register the scheduled tasks to run as this account:'
Write-Host "        .\scripts\install-scheduler.ps1 -RunAsUser '$account'"
Write-Host ''
Write-Host '  To verify containment afterwards, signed in as the agent account:'
Write-Host '        Get-ChildItem C:\Users\<you>     # should be Access Denied'
Write-Host "        New-Item $ProtectDrive\canary.txt -ItemType File   # should fail"
Write-Host "        New-Item $($Repos[0])\canary.txt -ItemType File    # should succeed"
Write-Host ''
Write-Host '  To undo everything:' -ForegroundColor Yellow
Write-Host "        Remove-LocalUser $UserName"
Write-Host "        # then remove the deny/allow ACEs for $account from the paths above"
Write-Host ''
