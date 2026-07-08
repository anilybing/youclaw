# ============================================================================
# make-usb.ps1  -  One-command USB assembly for XiaoJuClaw portable delivery.
#
# Self-contained: assembles the portable app straight from src-tauri\target\release
# (does NOT depend on make-portable.ps1) and bundles the offline toolchain via
# make-usb-payload.ps1. Kept ASCII-only so it parses on Windows PowerShell 5.1.
#
# Produces a single ready-to-copy folder:
#   <portable>\
#     XiaoJuClaw.exe            main app
#     XiaoJuClaw-server.exe     backend sidecar
#     package.json              required by the sidecar at startup
#     _up_\                     bundled agents/skills/prompts/playwright
#     resources\               bundled icon etc. (if present)
#     XiaoJuClawData\           portable data dir (sits NEXT TO the exe)
#       tools\manifest.json
#       tools\win-x64\{bun,git,uv,python[,node]}
#
# Why: the app resolves its data dir as <exe_dir>\XiaoJuClawData and loads the
# toolchain from XiaoJuClawData\tools\<platform>\. Shipping the tools here means
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
  [switch]$IncludeNode
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
$version = "1.0.0"
try { $version = ((Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json).version) } catch { }
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
Write-Host "      -> $portableDir"

# ---- 2) Copy the app + everything the sidecar needs from target\release ----
Write-Host "[2/4] Copying app, sidecar, package.json, _up_, resources"
Copy-Item $mainExe $portableDir -Force
Copy-Item $sidecarExe $portableDir -Force

$pkg = Join-Path $TargetRelease "package.json"
if (Test-Path $pkg) { Copy-Item $pkg $portableDir -Force; Write-Host "      + package.json" }
else { Write-Host "      [WARN] package.json missing in target\release (run build:sidecar)" -ForegroundColor Yellow }

$up = Join-Path $TargetRelease "_up_"
if (Test-Path $up) { Copy-Item $up (Join-Path $portableDir "_up_") -Recurse -Force; Write-Host "      + _up_ (agents/skills/prompts/playwright)" }
else { Write-Host "      [WARN] _up_ missing in target\release (run bun tauri build)" -ForegroundColor Yellow }

$res = Join-Path $TargetRelease "resources"
if (Test-Path $res) { Copy-Item $res (Join-Path $portableDir "resources") -Recurse -Force; Write-Host "      + resources" }

# Runtime DLLs, if the build produced any next to the exe (WebView2 is usually
# provided by the system runtime / statically linked, so this is best-effort).
Get-ChildItem $TargetRelease -Filter *.dll -File -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName $portableDir -Force
  Write-Host ("      + {0}" -f $_.Name)
}

# Portable data dir lives NEXT TO the exe (matches resolve_portable_data_dir).
New-Item -ItemType Directory -Force -Path (Join-Path $portableDir "XiaoJuClawData\logs") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $portableDir "XiaoJuClawData\workspace") | Out-Null

# ---- 3) Bundle the offline toolchain into <portable>\XiaoJuClawData --------
Write-Host "[3/4] Bundling toolchain (make-usb-payload.ps1 -> XiaoJuClawData\tools)"
$payloadArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',
  (Join-Path $here 'make-usb-payload.ps1'),
  '-Target', $portableDir, '-CacheDir', $CacheDir)
if ($IncludeNode) { $payloadArgs += '-IncludeNode' }
& powershell @payloadArgs
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] make-usb-payload.ps1 failed" -ForegroundColor Red; exit 1 }

# ---- 4) Verify the final layout -------------------------------------------
Write-Host "[4/4] Verifying USB folder layout"
$must = @(
  (Join-Path $portableDir 'XiaoJuClaw.exe'),
  (Join-Path $portableDir 'XiaoJuClaw-server.exe'),
  (Join-Path $portableDir 'package.json'),
  (Join-Path $portableDir 'XiaoJuClawData\tools\manifest.json'),
  (Join-Path $portableDir 'XiaoJuClawData\tools\win-x64\bun\bun.exe'),
  (Join-Path $portableDir 'XiaoJuClawData\tools\win-x64\git\cmd\git.exe'),
  (Join-Path $portableDir 'XiaoJuClawData\tools\win-x64\uv\uv.exe')
)
$missing = @($must | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
  Write-Host "[FAIL] Missing required files:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
  exit 1
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  USB folder ready" -ForegroundColor Green
Write-Host "============================================================"
Write-Host "  $portableDir"
Write-Host ""
Write-Host "  Copy the ENTIRE folder contents to the USB root."
Write-Host "  Users double-click XiaoJuClaw.exe - bun/git/uv are already on"
Write-Host "  the USB, so the environment-setup screen never appears."
Write-Host ""
exit 0
