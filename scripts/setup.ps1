# PlayTest AI — one-time setup on Windows 11 (run from the repo root in PowerShell)
$ErrorActionPreference = 'Stop'

$nodeVersion = (node -v) -replace 'v',''
if ([version]$nodeVersion -lt [version]'22.13.0') { throw "Node.js 22.13+ required (found $nodeVersion). Install Node 24 LTS." }

npm install
if (-not (Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env; Write-Host 'Created backend/.env' }

# Appium 2 + UiAutomator2 (used from Phase 3)
npm install -g appium
appium driver install uiautomator2

$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
if (Test-Path "$sdk\platform-tools\adb.exe") { Write-Host "Android SDK found: $sdk" -ForegroundColor Green }
else { Write-Warning "Android SDK not found at $sdk. Install Android Studio or set ANDROID_SDK_ROOT in backend/.env" }

Write-Host "`nDone. Start with: npm run dev  ->  http://localhost:5173" -ForegroundColor Cyan
