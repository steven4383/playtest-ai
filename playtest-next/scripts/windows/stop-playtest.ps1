<#
  Stop the background PlayTest AI server started by start-playtest.ps1 (or the logon task).
  Only stops the process listening on the port if it is this project's Next.js server.
  Emulators PlayTest started keep running; the next start re-attaches them (stop them in the dashboard if you like).
#>
param([int]$Port = 4300)

$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  Write-Host "PlayTest is not running on port $Port."
  exit 0
}
$procId = $listen[0].OwningProcess
$info = Get-CimInstance Win32_Process -Filter "ProcessId = $procId"
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($info.ParentProcessId)" -ErrorAction SilentlyContinue
$proj = $Project.ToLower()
# The listener is this project's Next.js server if its command line (or its parent's — Next may run the server in a
# child process) points into this folder.
$ours = ($info.Name -eq 'node.exe') -and (
  "$($info.CommandLine)".ToLower().Contains($proj) -or ($parent -and "$($parent.CommandLine)".ToLower().Contains($proj))
)
if (-not $ours) {
  Write-Host "Port $Port belongs to another program ($($info.Name), PID $procId) - not stopping it."
  exit 1
}

# Stop the whole tree (next start + its server process).
$root = $procId
if ($parent -and $parent.Name -eq 'node.exe' -and "$($parent.CommandLine)".ToLower().Contains($proj)) { $root = $parent.ProcessId }
& taskkill /PID $root /T /F | Out-Null
Start-Sleep -Seconds 1
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "Could not stop PlayTest (PID $root)."
  exit 1
}
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Project 'logs\playtest.pid')
Write-Host 'PlayTest stopped.'
