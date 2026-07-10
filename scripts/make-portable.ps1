# ============================================================================
# make-portable.ps1 - Build a lightweight app-only portable folder.
#
# For the production USB package with bundled tools, use make-usb.ps1.
# This script still follows the permanent three-root contract:
#   XiaoJuClaw\         immutable program payload
#   XiaoJuClawRuntime\  replaceable runtime tools (empty in this lightweight build)
#   XiaoJuClawData\     user-owned data, NEVER included in a release artifact
# ============================================================================

[CmdletBinding()]
param(
  [string]$ReleaseRoot,
  [string]$Variant = "portable"
)

$ErrorActionPreference = "Stop"
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$RepoRoot = Resolve-Path (Join-Path $here "..")
if (-not $ReleaseRoot) { $ReleaseRoot = Join-Path $RepoRoot "release" }
$TargetRelease = Join-Path $RepoRoot "src-tauri\target\release"

$mainExe = Join-Path $TargetRelease "XiaoJuClaw.exe"
$sidecarExe = Join-Path $TargetRelease "XiaoJuClaw-server.exe"
$packageJson = Join-Path $TargetRelease "package.json"
foreach ($required in @($mainExe, $sidecarExe, $packageJson)) {
  if (-not (Test-Path $required)) {
    Write-Host "[ERROR] Missing program payload: $required" -ForegroundColor Red
    exit 1
  }
}

& bun (Join-Path $here "desktop-version.mjs") check
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERROR] Desktop version consistency check failed." -ForegroundColor Red
  exit 1
}
try {
  $version = ((Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).version)
} catch {
  Write-Host "[ERROR] Cannot read the desktop version from package.json." -ForegroundColor Red
  exit 1
}
if (-not $version) {
  Write-Host "[ERROR] Desktop package.json has no version." -ForegroundColor Red
  exit 1
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$portableDir = Join-Path $ReleaseRoot ("XiaoJuClaw-$version-windows-$stamp-$Variant")
$appDir = Join-Path $portableDir "XiaoJuClaw"
$runtimeDir = Join-Path $portableDir "XiaoJuClawRuntime"

if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
New-Item -Path $appDir -ItemType Directory -Force | Out-Null
New-Item -Path $runtimeDir -ItemType Directory -Force | Out-Null

Copy-Item $mainExe $appDir -Force
Copy-Item $sidecarExe $appDir -Force
Copy-Item $packageJson $appDir -Force

$up = Join-Path $TargetRelease "_up_"
if (Test-Path $up) { Copy-Item $up (Join-Path $appDir "_up_") -Recurse -Force }
$resources = Join-Path $TargetRelease "resources"
if (Test-Path $resources) { Copy-Item $resources (Join-Path $appDir "resources") -Recurse -Force }
Get-ChildItem $TargetRelease -Filter *.dll -File -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName $appDir -Force
}

$layout = @'
{
  "schemaVersion": 1,
  "dataDir": "../XiaoJuClawData",
  "runtimeDir": "../XiaoJuClawRuntime"
}
'@
$layout | Set-Content -Path (Join-Path $appDir "portable-layout.json") -Encoding ASCII

$launcher = @'
@echo off
start "" "%~dp0XiaoJuClaw\XiaoJuClaw.exe"
'@
$launcher | Set-Content -Path (Join-Path $portableDir "Start-XiaoJuClaw.bat") -Encoding ASCII

$migrator = @'
@echo off
setlocal
if not exist "%~dp0XiaoJuClaw\portable-layout.json" exit /b 1
if not exist "%~dp0XiaoJuClaw.exe" goto launch
taskkill /F /IM "XiaoJuClaw.exe" >nul 2>nul
taskkill /F /IM "XiaoJuClaw-server.exe" >nul 2>nul
if exist "%~dp0XiaoJuClaw.exe" del /f /q "%~dp0XiaoJuClaw.exe"
if exist "%~dp0XiaoJuClaw-server.exe" del /f /q "%~dp0XiaoJuClaw-server.exe"
if exist "%~dp0package.json" del /f /q "%~dp0package.json"
if exist "%~dp0_up_" rmdir /s /q "%~dp0_up_"
if exist "%~dp0resources" rmdir /s /q "%~dp0resources"
echo [OK] Legacy program files removed. XiaoJuClawData was not touched.
:launch
start "" "%~dp0XiaoJuClaw\XiaoJuClaw.exe"
exit /b 0
'@
$migrator | Set-Content -Path (Join-Path $portableDir "Migrate-Legacy-Layout.bat") -Encoding ASCII

$readme = @'
XiaoJuClaw lightweight portable edition

Run Start-XiaoJuClaw.bat.

Safe upgrade:
  Replace XiaoJuClaw\ and XiaoJuClawRuntime\ only.
  Never delete or overwrite XiaoJuClawData\.
  For an old flat-layout package, run Migrate-Legacy-Layout.bat once.

This lightweight package does not bundle bun/git/python/uv. Use make-usb.ps1
for the complete offline-toolchain USB package.
'@
$readme | Set-Content -Path (Join-Path $portableDir "README-portable.txt") -Encoding ASCII

if (Test-Path (Join-Path $portableDir "XiaoJuClawData")) {
  Write-Host "[ERROR] Release artifact contains user data." -ForegroundColor Red
  exit 1
}

Write-Host "[OK] Lightweight portable package: $portableDir" -ForegroundColor Green
exit 0
