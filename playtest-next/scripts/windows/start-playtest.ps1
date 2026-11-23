<#
  Start PlayTest AI in the background (no VS Code, no console window).

  - Already running?  Only opens the browser (with -Open).
  - Code changed since the last build (or never built)?  Builds first (~1 min).
  - Runs `next start` on 127.0.0.1:<Port>, logs to logs\playtest.log, waits until the API answers.

  Used by the Windows logon task and the "PlayTest AI" shortcut (see install-autostart.ps1).
#>
param(
  [int]$Port = 4300,
  [switch]$Open,
  [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LogDir = Join-Path $Project 'logs'
$Log = Join-Path $LogDir 'playtest.log'
$ErrLog = Join-Path $LogDir 'playtest.err.log'
$Url = "http://127.0.0.1:$Port"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Note([string]$msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Write-Host $line
  Add-Content -Path (Join-Path $LogDir 'launcher.log') -Value $line -Encoding utf8
}

function Test-Up {
  try {
    $r = Invoke-WebRequest -Uri "$Url/api/v1/health" -UseBasicParsing -TimeoutSec 5
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (Test-Up) {
  Write-Note "PlayTest is already running at $Url"
  if ($Open) { Start-Process $Url }
  exit 0
}

# Something else on the port?
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Note "Port $Port is used by another program (PID $($busy[0].OwningProcess)). Close it or start with -Port 4310."
  exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Note 'Node.js not found on PATH. Install Node.js 22.13+ and try again.'
  exit 1
}
$next = Join-Path $Project 'node_modules\next\dist\bin\next'
if (-not (Test-Path $next)) {
  Write-Note "Dependencies missing - running npm install in $Project"
  Push-Location $Project
  try { & npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }
}

# Build when there is no build yet, or sources are newer than it.
$buildId = Join-Path $Project '.next\BUILD_ID'
$needBuild = $Rebuild -or -not (Test-Path $buildId)
if (-not $needBuild) {
  $builtAt = (Get-Item $buildId).LastWriteTimeUtc
  $sources = @(Get-ChildItem -Path (Join-Path $Project 'src') -Recurse -File) + @(Get-Item (Join-Path $Project 'package.json'), (Join-Path $Project 'next.config.ts'))
  $newest = ($sources | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
  $needBuild = $newest -gt $builtAt
}
if ($needBuild) {
  Write-Note 'Building PlayTest (first start or code changed) - about a minute...'
  Push-Location $Project
  try {
    & $node $next build *> (Join-Path $LogDir 'build.log')
    if ($LASTEXITCODE -ne 0) {
      Write-Note "Build failed - see $(Join-Path $LogDir 'build.log')"
      exit 1
    }
  } finally {
    Pop-Location
  }
}

# Keep the previous run's logs once.
foreach ($f in @($Log, $ErrLog)) {
  if (Test-Path $f) { Move-Item -Force $f "$f.old" }
}

# PORT tells instrumentation.ts where to knock so background services start right away.
$env:PORT = "$Port"
$env:NODE_ENV = 'production'
$proc = Start-Process -FilePath $node -ArgumentList @("`"$next`"", 'start', '-H', '127.0.0.1', '-p', "$Port") `
  -WorkingDirectory $Project -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $Log -RedirectStandardError $ErrLog
Set-Content -Path (Join-Path $LogDir 'playtest.pid') -Value $proc.Id -Encoding ascii
Write-Note "Starting PlayTest (PID $($proc.Id)) at $Url ..."

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if ($proc.HasExited) {
    Write-Note "PlayTest stopped right away - see $ErrLog"
    exit 1
  }
  if (Test-Up) {
    Write-Note "PlayTest is running at $Url"
    if ($Open) { Start-Process $Url }
    exit 0
  }
}
Write-Note "PlayTest did not answer within 60 s - see $Log"
exit 1
