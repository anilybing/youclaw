# release-gate.ps1 - XiaoJuClaw quality and release gate.
# Kept ASCII-only for Windows PowerShell 5.1.
#
# Default mode is practical desktop validation for local work and PRs.
# -Release is the strict shipping gate and rejects every skip switch.

[CmdletBinding()]
param(
  [Alias("FullRelease")]
  [switch]$Release,
  [switch]$WithMvp,
  [switch]$WithRust,
  [switch]$WithPlaywright,
  [switch]$WithBuild,
  [switch]$SkipBackendTests,
  [switch]$SkipWebChecks,
  [switch]$SkipSkillsTests,
  [switch]$SkipDigitalStaff,
  [switch]$SkipArtifactChecks,
  [string]$MvpDir = "",
  [string[]]$ArtifactRoot = @()
)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$results = @()
$ok = $true

function Stop-InvalidArguments {
  param([string]$Message)
  Write-Host ("[ERROR] " + $Message) -ForegroundColor Red
  exit 2
}

if ($Release) {
  $requestedSkips = @()
  if ($SkipBackendTests) { $requestedSkips += "SkipBackendTests" }
  if ($SkipWebChecks) { $requestedSkips += "SkipWebChecks" }
  if ($SkipSkillsTests) { $requestedSkips += "SkipSkillsTests" }
  if ($SkipDigitalStaff) { $requestedSkips += "SkipDigitalStaff" }
  if ($SkipArtifactChecks) { $requestedSkips += "SkipArtifactChecks" }
  if ($requestedSkips.Count -gt 0) {
    Stop-InvalidArguments ("Strict release mode rejects skips: " + ($requestedSkips -join ", "))
  }
  $WithMvp = $true
  $WithRust = $true
  $WithPlaywright = $true
}

if ($env:XJC_TEST_FAIL_BASELINE -and $env:XJC_TEST_FAIL_BASELINE -ne "0") {
  Write-Host "[WARN] XJC_TEST_FAIL_BASELINE is ignored; the failure baseline is always zero." -ForegroundColor Yellow
}

function Invoke-Step {
  param(
    [string]$Name,
    [string]$WorkDir,
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  Write-Host ""
  Write-Host ("== " + $Name + " ==") -ForegroundColor Cyan
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $code = 1
  try {
    Push-Location $WorkDir
    try {
      & $FilePath @ArgumentList 2>&1 | Out-Host
      $code = $LASTEXITCODE
      if ($null -eq $code) { $code = 1 }
    } finally {
      Pop-Location
    }
  } catch {
    Write-Host ("[ERROR] " + $_.Exception.Message) -ForegroundColor Red
    $code = 127
  } finally {
    $watch.Stop()
  }

  $script:results += [pscustomobject]@{
    Step = $Name
    Result = $(if ($code -eq 0) { "PASS" } else { "FAIL($code)" })
    Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1)
  }
  if ($code -ne 0) { $script:ok = $false }
}

function Resolve-MvpDirectory {
  if ($MvpDir) {
    if (Test-Path (Join-Path $MvpDir "package.json")) {
      return (Resolve-Path $MvpDir).Path
    }
    return $null
  }

  $candidates = @()
  if ($env:XJC_MVP_DIR) { $candidates += $env:XJC_MVP_DIR }
  $candidates += (Join-Path $repo "..\mvp")
  $candidates += (Join-Path $repo "..\MVPClawToC\mvp")
  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate "package.json")) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

function Get-PortableArtifactRoots {
  $seen = @{}
  $found = @()
  $candidates = @($ArtifactRoot)

  $releaseDir = Join-Path $repo "release"
  if (Test-Path $releaseDir) {
    $candidates += @(Get-ChildItem -Path $releaseDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  $candidates += (Join-Path $repo "..\dist-production\usb-portable")
  $candidates += (Join-Path $repo "..\dist-production\offline-portable")
  $candidates += (Join-Path $repo "..\MVPClawToC\dist-production\usb-portable")
  $candidates += (Join-Path $repo "..\MVPClawToC\dist-production\offline-portable")

  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path $candidate -PathType Container)) { continue }
    $marker = Join-Path $candidate "XiaoJuClaw\portable-layout.json"
    $flatExe = Join-Path $candidate "XiaoJuClaw.exe"
    $launcher = Join-Path $candidate "Start-XiaoJuClaw.bat"
    $leaf = Split-Path -Leaf $candidate
    $looksPortable = (Test-Path $marker) -or (Test-Path $flatExe) -or (Test-Path $launcher)
    if (-not $looksPortable -and $leaf -notlike "*portable*") { continue }
    $resolved = (Resolve-Path $candidate).Path
    $key = $resolved.ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      $found += $resolved
    }
  }
  return $found
}

function Get-FinalizedArtifactRoots {
  $seen = @{}
  $found = @()
  $candidates = @($ArtifactRoot)
  $releaseDir = Join-Path $repo "release"
  if (Test-Path $releaseDir) {
    $candidates += @(Get-ChildItem -Path $releaseDir -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  foreach ($relative in @(
    "..\dist-production\usb-portable",
    "..\dist-production\offline-portable",
    "..\dist-production\desktop-exe",
    "..\dist-production\offline-exe",
    "..\MVPClawToC\dist-production\usb-portable",
    "..\MVPClawToC\dist-production\offline-portable",
    "..\MVPClawToC\dist-production\desktop-exe",
    "..\MVPClawToC\dist-production\offline-exe"
  )) {
    $candidates += (Join-Path $repo $relative)
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate -or -not (Test-Path (Join-Path $candidate "artifact-manifest.json"))) { continue }
    $resolved = (Resolve-Path $candidate).Path
    $key = $resolved.ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      $found += $resolved
    }
  }
  return $found
}

Write-Host ("Release gate mode: " + $(if ($Release) { "STRICT RELEASE" } else { "DESKTOP" })) -ForegroundColor Cyan
Write-Host "Test failure baseline: 0"

Invoke-Step "Desktop version consistency" $repo "bun" @("scripts/desktop-version.mjs", "check")
Invoke-Step "Root typecheck" $repo "bun" @("run", "typecheck")
if (-not $SkipWebChecks) {
  Invoke-Step "Web typecheck" (Join-Path $repo "web") "bun" @("run", "typecheck")
  Invoke-Step "Web lint" (Join-Path $repo "web") "bun" @("run", "lint")
}
Invoke-Step "Brand audit" $repo "bun" @("run", "brand-audit")
Invoke-Step "Trusted execution evals" $repo "bun" @("run", "test:release-evals")
if (-not $SkipBackendTests) {
  Invoke-Step "Backend tests" $repo "bun" @("run", "test")
}
if (-not $SkipSkillsTests) {
  Invoke-Step "Skills golden tests" (Join-Path $repo "skills-dev") "bun" @("run", "test")
  Invoke-Step "Recommended skills" $repo "bun" @("run", "validate:recommended-skills")
}
if (-not $SkipDigitalStaff) {
  Invoke-Step "Digital staff verify" $repo "bun" @("scripts/verify-digital-staff.mjs")
}
Invoke-Step "CycloneDX SBOM check" $repo "bun" @("scripts/generate-sbom.mjs", "check")

if ($WithMvp) {
  $resolvedMvp = Resolve-MvpDirectory
  if (-not $resolvedMvp) {
    Write-Host "[ERROR] MVP directory was not found. Use -MvpDir or XJC_MVP_DIR." -ForegroundColor Red
    $ok = $false
    $results += [pscustomobject]@{ Step = "MVP directory"; Result = "FAIL(not found)"; Seconds = 0 }
  } else {
    Invoke-Step "MVP tests" $resolvedMvp "npm" @("test")
    Invoke-Step "MVP hermetic smoke" $resolvedMvp "npm" @("run", "smoke:hermetic")
  }
}

if ($WithRust) {
  Invoke-Step "Rust release check" (Join-Path $repo "src-tauri") "cargo" @("check", "--release", "--locked")
}

if ($WithPlaywright) {
  Invoke-Step "Playwright release smoke" $repo "bun" @("run", "test:e2e:release")
}

if (-not $SkipArtifactChecks) {
  $portableRoots = @(Get-PortableArtifactRoots)
  if ($portableRoots.Count -eq 0) {
    Write-Host ""
    Write-Host "[skip] No portable artifacts exist; layout verification is not applicable." -ForegroundColor Yellow
  }
  foreach ($portableRoot in $portableRoots) {
    $leaf = Split-Path -Leaf $portableRoot
    Invoke-Step ("Portable layout: " + $leaf) $repo "bun" @("scripts/verify-portable-layout.mjs", $portableRoot)
  }
  foreach ($finalizedRoot in @(Get-FinalizedArtifactRoots)) {
    $leaf = Split-Path -Leaf $finalizedRoot
    Invoke-Step ("Artifact hashes: " + $leaf) $repo "bun" @("scripts/release-artifacts.mjs", "verify", $finalizedRoot)
  }
}

if ($WithBuild) {
  Invoke-Step "Tauri fast build" $repo "bun" @("run", "build:tauri:fast")
}

Write-Host ""
Write-Host "==================== RELEASE GATE SUMMARY ====================" -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 140 | Write-Host
if (-not $ok) {
  Write-Host "RELEASE GATE: FAILED" -ForegroundColor Red
  exit 1
}
Write-Host "RELEASE GATE: ALL PASS" -ForegroundColor Green
exit 0
