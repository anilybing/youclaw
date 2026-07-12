# ============================================================================
# make-usb.ps1  -  One-command USB assembly for XiaoJuClaw portable delivery.
#
# Self-contained: assembles the portable app straight from src-tauri\target\release
# (does NOT depend on make-portable.ps1) and bundles the offline toolchain via
# make-usb-payload.ps1. Kept ASCII-only so it parses on Windows PowerShell 5.1.
#
# Produces a three-root ready-to-copy folder:
#   <portable>\
#     XiaoJuClaw\                immutable program files (replace on upgrade)
#       XiaoJuClaw.exe
#       XiaoJuClaw-server.exe
#       package.json
#       _up_\
#       resources\
#       portable-layout.json
#     XiaoJuClawRuntime\         replaceable toolchain
#       tools\manifest.json
#       tools\win-x64\{bun,git,uv,python[,node]}
#     XiaoJuClawData\            NOT shipped; created on first run and never overwritten
#
# Why: the marker resolves data/runtime as siblings of the program directory.
# Shipping tools outside XiaoJuClawData means a program/runtime upgrade cannot
# overwrite the database, API keys, login token, chats, or workspace.
# users never see the "install bun/git..." screen - it works offline, no admin,
# no CDN, no antivirus-tripping installers.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\make-usb.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\make-usb.ps1 -IncludeNode
#
# Prerequisite: build the desktop app first (build-release.bat / bun run build:tauri)
# so src-tauri\target\release has XiaoJuClaw.exe, XiaoJuClaw-server.exe,
# package.json and _up_\.
# ============================================================================

[CmdletBinding()]
param(
  [string]$ReleaseRoot,
  [string]$CacheDir,
  [string]$OutputPathFile,
  [switch]$IncludeNode,
  # Local-intelligence payload (semantic memory + local OCR); see make-usb-payload.ps1.
  [string]$PytoolsSource,
  [switch]$SkipPytools
)

$ErrorActionPreference = "Stop"
# $PSScriptRoot is not reliably populated in param() defaults on Windows
# PowerShell 5.1, so resolve everything here in the body instead.
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$RepoRoot = Resolve-Path (Join-Path $here "..")
if (-not $ReleaseRoot) { $ReleaseRoot = Join-Path $RepoRoot "release" }
if (-not $CacheDir)    { $CacheDir    = Join-Path $RepoRoot "tool-cache" }
$TargetRelease = Join-Path $RepoRoot "src-tauri\target\release"

Write-Host ""
Write-Host "============================================================"
Write-Host "  XiaoJuClaw USB assembly (portable app + offline toolchain)"
Write-Host "============================================================"

$mainExe = Join-Path $TargetRelease "XiaoJuClaw.exe"
$sidecarExe = Join-Path $TargetRelease "XiaoJuClaw-server.exe"
if (-not (Test-Path $mainExe)) {
  Write-Host "[ERROR] $mainExe not found. Build the app first (build-release.bat)." -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $sidecarExe)) {
  Write-Host "[ERROR] $sidecarExe not found. Run bun run build:sidecar." -ForegroundColor Red
  exit 1
}

# ---- Resolve version + build a timestamped output folder -------------------
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
$portableDir = Join-Path $ReleaseRoot ("XiaoJuClaw-$version-windows-$stamp-portable")

Write-Host "[1/4] Preparing portable folder"
# Prune older *-portable folders first: each is ~700MB and, if left in release/,
# they also get picked up by the root `tsc` typecheck (bundled PortableGit ships
# binary *.js terminfo files). Keep only the folder we are about to build.
Get-ChildItem $ReleaseRoot -Directory -EA SilentlyContinue |
  Where-Object { $_.Name -like '*-portable' -and $_.FullName -ne $portableDir } |
  ForEach-Object { Write-Host ("      [prune] " + $_.Name); Remove-Item -Recurse -Force $_.FullName }
if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
$appDir = Join-Path $portableDir "XiaoJuClaw"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Write-Host "      -> $portableDir"

# ---- 2) Copy the app + everything the sidecar needs from target\release ----
Write-Host "[2/4] Copying app, sidecar, package.json, _up_, resources"
Copy-Item $mainExe $appDir -Force
Copy-Item $sidecarExe $appDir -Force

$pkg = Join-Path $TargetRelease "package.json"
if (Test-Path $pkg) { Copy-Item $pkg $appDir -Force; Write-Host "      + package.json" }
else {
  Write-Host "[ERROR] package.json missing in target\release (run build:sidecar)." -ForegroundColor Red
  exit 1
}

$up = Join-Path $TargetRelease "_up_"
if (Test-Path $up) { Copy-Item $up (Join-Path $appDir "_up_") -Recurse -Force; Write-Host "      + _up_ (agents/skills/prompts/playwright)" }
else { Write-Host "      [WARN] _up_ missing in target\release (run bun tauri build)" -ForegroundColor Yellow }

$res = Join-Path $TargetRelease "resources"
if (Test-Path $res) { Copy-Item $res (Join-Path $appDir "resources") -Recurse -Force; Write-Host "      + resources" }

# Runtime DLLs, if the build produced any next to the exe (WebView2 is usually
# provided by the system runtime / statically linked, so this is best-effort).
Get-ChildItem $TargetRelease -Filter *.dll -File -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName $appDir -Force
  Write-Host ("      + {0}" -f $_.Name)
}

# Explicit marker: never infer portable mode from directory writability.
$layout = @'
{
  "schemaVersion": 1,
  "dataDir": "../XiaoJuClawData",
  "runtimeDir": "../XiaoJuClawRuntime"
}
'@
$layout | Set-Content -Path (Join-Path $appDir "portable-layout.json") -Encoding ASCII

# Convenience launcher kept outside the replaceable program directory.
$launcher = @'
@echo off
start "" "%~dp0XiaoJuClaw\XiaoJuClaw.exe"
'@
$launcher | Set-Content -Path (Join-Path $portableDir "Start-XiaoJuClaw.bat") -Encoding ASCII

$migrator = @'
@echo off
setlocal
if not exist "%~dp0XiaoJuClaw\portable-layout.json" (
  echo [ERROR] New XiaoJuClaw program directory is incomplete.
  pause
  exit /b 1
)
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

$guideSource = Join-Path $RepoRoot "web\public\user-guide"
$guideEntry = Join-Path $guideSource "index.html"
$guideTarget = Join-Path $portableDir "XiaoJuClaw-User-Guide"
if (-not (Test-Path $guideEntry)) {
  Write-Host "[ERROR] Illustrated user guide missing: $guideEntry" -ForegroundColor Red
  exit 1
}
Copy-Item $guideSource $guideTarget -Recurse -Force

$readme = @'
XiaoJuClaw portable edition

Start:
  Double-click Start-XiaoJuClaw.bat or XiaoJuClaw\XiaoJuClaw.exe.

Help:
  Double-click XiaoJuClaw-User-Guide\index.html, or select User Guide in the app sidebar.

Directory ownership:
  XiaoJuClaw\         program files; replace this directory when upgrading
  XiaoJuClawRuntime\  bundled tools; safe to replace when upgrading
  XiaoJuClaw-User-Guide\ illustrated manual; replace when upgrading
  XiaoJuClawData\     user data; created on first run; NEVER delete or overwrite

Safe upgrade:
  Copy XiaoJuClaw\, XiaoJuClawRuntime\, and XiaoJuClaw-User-Guide\ from the new
  package over the old deployment. The release package intentionally contains
  no XiaoJuClawData\ directory, so direct merge-copy preserves user data.

Old flat-layout upgrade:
  After merge-copying this package, run Migrate-Legacy-Layout.bat once. It only
  removes obsolete root-level program files and never touches XiaoJuClawData\.
'@
$readme | Set-Content -Path (Join-Path $portableDir "README-portable.txt") -Encoding ASCII

# ---- 3) Bundle the offline toolchain into <portable>\XiaoJuClawRuntime ------
Write-Host "[3/4] Bundling toolchain (make-usb-payload.ps1 -> XiaoJuClawRuntime\tools)"
$payloadArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',
  (Join-Path $here 'make-usb-payload.ps1'),
  '-Target', $portableDir, '-CacheDir', $CacheDir)
if ($IncludeNode) { $payloadArgs += '-IncludeNode' }
if ($PytoolsSource) { $payloadArgs += @('-PytoolsSource', $PytoolsSource) }
if ($SkipPytools) { $payloadArgs += '-SkipPytools' }
& powershell @payloadArgs
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] make-usb-payload.ps1 failed" -ForegroundColor Red; exit 1 }

# ---- 4) Verify the final layout -------------------------------------------
Write-Host "[4/4] Verifying USB folder layout"
$must = @(
  (Join-Path $portableDir 'XiaoJuClaw\XiaoJuClaw.exe'),
  (Join-Path $portableDir 'XiaoJuClaw\XiaoJuClaw-server.exe'),
  (Join-Path $portableDir 'XiaoJuClaw\package.json'),
  (Join-Path $portableDir 'XiaoJuClaw\portable-layout.json'),
  (Join-Path $portableDir 'Migrate-Legacy-Layout.bat'),
  (Join-Path $portableDir 'XiaoJuClawRuntime\tools\manifest.json'),
  (Join-Path $portableDir 'XiaoJuClawRuntime\tools\win-x64\bun\bun.exe'),
  (Join-Path $portableDir 'XiaoJuClawRuntime\tools\win-x64\git\cmd\git.exe'),
  (Join-Path $portableDir 'XiaoJuClawRuntime\tools\win-x64\uv\uv.exe'),
  (Join-Path $portableDir 'XiaoJuClawRuntime\tools\win-x64\python\python.exe')
)
$missing = @($must | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
  Write-Host "[FAIL] Missing required files:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
  exit 1
}

& bun (Join-Path $here "verify-portable-layout.mjs") $portableDir
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] Portable layout/data isolation verification failed" -ForegroundColor Red
  exit 1
}
if ($OutputPathFile) {
  $outputParent = Split-Path -Parent $OutputPathFile
  if ($outputParent -and -not (Test-Path $outputParent)) {
    New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
  }
  Set-Content -LiteralPath $OutputPathFile -Value $portableDir -Encoding ASCII
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  USB folder ready" -ForegroundColor Green
Write-Host "============================================================"
Write-Host "  $portableDir"
Write-Host ""
Write-Host "  Copy the ENTIRE folder contents to the USB root."
Write-Host "  Users double-click Start-XiaoJuClaw.bat - bun/git/uv are already on"
Write-Host "  the USB, so the environment-setup screen never appears."
Write-Host "  Future upgrades replace XiaoJuClaw\, XiaoJuClawRuntime\, and"
Write-Host "  XiaoJuClaw-User-Guide\."
Write-Host "  XiaoJuClawData\ is user-owned and is never shipped."
Write-Host ""
exit 0
