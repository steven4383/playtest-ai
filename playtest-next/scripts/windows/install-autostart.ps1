<#
  Make PlayTest AI start by itself when you log in to Windows, and add shortcuts:
    - Scheduled task "PlayTest AI" (at log-on, your user, no admin rights, no window, no time limit)
    - Desktop + Start Menu: "PlayTest AI" (start if needed, open the dashboard) and "Stop PlayTest AI"
  Undo with uninstall-autostart.ps1.
#>
param([int]$Port = 4300)

$ErrorActionPreference = 'Stop'
$Start = (Resolve-Path (Join-Path $PSScriptRoot 'start-playtest.ps1')).Path
$Stop = (Resolve-Path (Join-Path $PSScriptRoot 'stop-playtest.ps1')).Path
$Icon = Join-Path $PSScriptRoot 'playtest.ico'
$TaskName = 'PlayTest AI'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$user = "$env:USERDOMAIN\$env:USERNAME"

# 1) Log-on task (runs as you, limited rights, hidden). ExecutionTimeLimit 0 = never stopped by Task Scheduler.
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Start`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S' # let Windows, Wi-Fi and adb settle first
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Starts the PlayTest AI dashboard and API (http://127.0.0.1:4300) in the background.' -Force | Out-Null
Write-Host "Scheduled task '$TaskName' registered (runs 30 s after you log in)."

# 2) Shortcuts
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'PlayTest AI'))
New-Item -ItemType Directory -Force -Path $places[1] | Out-Null
foreach ($dir in $places) {
  $open = $shell.CreateShortcut((Join-Path $dir 'PlayTest AI.lnk'))
  $open.TargetPath = $ps
  $open.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Start`" -Port $Port -Open"
  $open.WorkingDirectory = Split-Path $Start
  $open.Description = 'Start PlayTest AI if needed and open the dashboard'
  if (Test-Path $Icon) { $open.IconLocation = $Icon }
  $open.Save()

  $stopLnk = $shell.CreateShortcut((Join-Path $dir 'Stop PlayTest AI.lnk'))
  $stopLnk.TargetPath = $ps
  $stopLnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Stop`" -Port $Port"
  $stopLnk.WorkingDirectory = Split-Path $Stop
  $stopLnk.Description = 'Stop the background PlayTest AI server'
  $stopLnk.Save()
}
Write-Host 'Shortcuts added to the Desktop and Start Menu: "PlayTest AI" and "Stop PlayTest AI".'
Write-Host "PlayTest will start by itself at your next log-in. To start it now, use the 'PlayTest AI' shortcut."
