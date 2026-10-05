# Registers ShanAuto with Windows Task Scheduler.
# Run once, from an elevated PowerShell:  .\scripts\install-scheduler.ps1
#
# To run under the restricted account created by setup-restricted-account.ps1
# (strongly recommended if any agent is allowed to run shell commands):
#   .\scripts\install-scheduler.ps1 -RunAsUser 'MACHINE\shanauto-agent'
param(
    [string]$RunAsUser,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = if ($NodePath) { $NodePath } else { (Get-Command node).Source }
if (-not (Test-Path $node)) { throw "node executable not found at: $node" }

$cred = $null
if ($RunAsUser) {
    # Prompted, so the password never lands in a script, a log, or the task XML.
    $cred = Get-Credential -UserName $RunAsUser -Message "Password for $RunAsUser"
    Write-Host "Tasks will run as $RunAsUser" -ForegroundColor Cyan
    Write-Host "NOTE: that account needs its own node/opencode/agy install and its own"
    Write-Host "      opencode+agy credentials. See setup-restricted-account.ps1."
    Write-Host ""
    # (Get-Command node).Source resolves to where THIS admin shell sees node -
    # usually a per-user install under C:\Users\<you>, which the restricted
    # account cannot read. The task would be registered against a path that
    # fails for that account. Refuse to guess silently: point -NodePath at a
    # machine-wide node instead.
    if (-not $NodePath) {
        Write-Host "WARNING: no -NodePath given. This task will execute:" -ForegroundColor Yellow
        Write-Host "         $node" -ForegroundColor Yellow
        Write-Host "         If that is under a user profile, the restricted account cannot run it." -ForegroundColor Yellow
        Write-Host "         Re-run with -NodePath 'C:\Program Files\nodejs\node.exe' (or wherever a" -ForegroundColor Yellow
        Write-Host "         machine-wide node lives) and re-apply -RunAsUser." -ForegroundColor Yellow
        Write-Host ""
    }
}

function New-SaTask {
    param([string]$Name, [string]$Arg, [string]$At)

    $action  = New-ScheduledTaskAction -Execute $node `
        -Argument "`"$root\node_modules\tsx\dist\cli.mjs`" `"$root\src\index.ts`" $Arg" `
        -WorkingDirectory $root

    $trigger = New-ScheduledTaskTrigger -Daily -At $At

    # WakeToRun so a sleeping machine still makes progress; StartWhenAvailable so a
    # missed window (laptop shut) is picked up as soon as the machine is back.
    $settings = New-ScheduledTaskSettingsSet `
        -WakeToRun `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 9) `
        -MultipleInstances IgnoreNew

    $common = @{
        TaskName    = $Name
        Action      = $action
        Trigger     = $trigger
        Settings    = $settings
        Description = "ShanAuto: $Arg"
        Force       = $true
    }
    if ($cred) {
        Register-ScheduledTask @common -User $cred.UserName `
            -Password $cred.GetNetworkCredential().Password -RunLevel Limited | Out-Null
    }
    else {
        Register-ScheduledTask @common | Out-Null
    }

    Write-Host "  registered $Name at $At -> $Arg"
}

Write-Host "Installing ShanAuto scheduled tasks..."
New-SaTask -Name 'ShanAuto Plan'   -Arg 'plan' -At '06:30'
New-SaTask -Name 'ShanAuto Run'    -Arg 'run'  -At '07:00'
New-SaTask -Name 'ShanAuto Report' -Arg 'report' -At '19:00'
# Retention runs after the report, so a day is always summarised before any of
# its raw material can age out. Harmless when the windows in system.yaml are 0,
# which is the default: prune then deletes nothing at all.
New-SaTask -Name 'ShanAuto Prune'  -Arg 'prune'  -At '19:15'

Write-Host ""
Write-Host "Done. Inspect with:  Get-ScheduledTask -TaskName 'ShanAuto*'"
Write-Host "Run one now with:    Start-ScheduledTask -TaskName 'ShanAuto Run'"
Write-Host "Remove with:         Get-ScheduledTask -TaskName 'ShanAuto*' | Unregister-ScheduledTask -Confirm:`$false"
