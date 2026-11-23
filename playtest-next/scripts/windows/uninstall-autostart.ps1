<#
  Undo install-autostart.ps1: remove the log-on task and the shortcuts. Does not stop a running server
  (use the "Stop PlayTest AI" shortcut or stop-playtest.ps1 first if you want that).
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'PlayTest AI'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "No scheduled task '$TaskName'."
}
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($f in @((Join-Path $desktop 'PlayTest AI.lnk'), (Join-Path $desktop 'Stop PlayTest AI.lnk'))) {
  if (Test-Path $f) { Remove-Item -Force $f }
}
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'PlayTest AI'
if (Test-Path $menu) { Remove-Item -Recurse -Force $menu }
Write-Host 'Shortcuts removed.'
