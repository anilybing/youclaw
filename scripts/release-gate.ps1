# release-gate.ps1 - XiaoJuClaw release gate (T-F2)
#
# Runs every automated quality gate in sequence and prints a summary table.
# Any failure => exit 1 (build-release.bat calls this before packaging).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\release-gate.ps1
#   powershell -File scripts\release-gate.ps1 -WithMvp        # also run MVP cloud tests
#   powershell -File scripts\release-gate.ps1 -WithBuild      # also run tauri fast build (slow, needs Rust)
#   powershell -File scripts\release-gate.ps1 -SkipBackendTests

param(
  [switch]$WithMvp,
  [switch]$WithBuild,
  [switch]$SkipBackendTests,
  [string]$MvpDir = "D:\code\MVPClawToC\mvp"
)

$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$results = @()

function Invoke-Step {
  param([string]$Name, [string]$WorkDir, [string]$Command)
  Write-Host ""
  Write-Host ("== " + $Name + " ==") -ForegroundColor Cyan
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Push-Location $WorkDir
  try {
    # Out-Host：若让 stdout 流入函数返回值，返回值会变成「输出行数组 + 布尔」，
    # 上层 `(Invoke-Step ...) -and $ok` 对非空数组恒为真 —— 失败步骤会被误判 PASS。
    cmd /c $Command | Out-Host
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $sw.Stop()
  }
  $script:results += [pscustomobject]@{
    Step = $Name
    Result = $(if ($code -eq 0) { "PASS" } else { "FAIL($code)" })
    Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  }
  return ($code -eq 0)
}

$ok = $true
$ok = (Invoke-Step "Root typecheck"        $repo              "bun run typecheck") -and $ok
$ok = (Invoke-Step "Web typecheck"         (Join-Path $repo 'web') "bun run typecheck") -and $ok
$ok = (Invoke-Step "Web lint"              (Join-Path $repo 'web') "bun run lint") -and $ok
$ok = (Invoke-Step "Brand audit"           $repo              "bun run brand-audit") -and $ok
if (-not $SkipBackendTests) {
  # 已知存量失败（logs/browser/registry 等，见任务书 T-B5 备注）——
  # 门禁按“失败数不高于基线”执行：基线由 XJC_TEST_FAIL_BASELINE 控制，默认 37。
  $baseline = if ($env:XJC_TEST_FAIL_BASELINE) { [int]$env:XJC_TEST_FAIL_BASELINE } else { 37 }
  Write-Host ""
  Write-Host "== Backend tests (baseline <= $baseline fails) ==" -ForegroundColor Cyan
  Push-Location $repo
  $out = cmd /c "bun test `".test.`" 2>&1"
  Pop-Location
  $failLine = ($out | Select-String -Pattern '(\d+)\s+fail' | Select-Object -Last 1)
  $failCount = if ($failLine) { [int]$failLine.Matches[0].Groups[1].Value } else { 9999 }
  $pass = $failCount -le $baseline
  $results += [pscustomobject]@{ Step = "Backend tests"; Result = $(if ($pass) { "PASS($failCount fails<=baseline)" } else { "FAIL($failCount fails)" }); Seconds = 0 }
  $ok = $pass -and $ok
}
$ok = (Invoke-Step "Skills golden tests"   (Join-Path $repo 'skills-dev') "bun test") -and $ok
$ok = (Invoke-Step "Digital staff verify"  $repo              "bun scripts/verify-digital-staff.mjs") -and $ok

if ($WithMvp) {
  $ok = (Invoke-Step "MVP unit tests"      $MvpDir            "npm test") -and $ok
  $ok = (Invoke-Step "MVP smoke"           $MvpDir            "npm run smoke") -and $ok
}
if ($WithBuild) {
  $ok = (Invoke-Step "Tauri fast build"    $repo              "bun run build:tauri:fast") -and $ok
} else {
  Write-Host ""
  Write-Host "[skip] Tauri fast build (use -WithBuild; requires Rust toolchain)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "==================== RELEASE GATE SUMMARY ====================" -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 120 | Write-Host
if (-not $ok) {
  Write-Host "RELEASE GATE: FAILED" -ForegroundColor Red
  exit 1
}
Write-Host "RELEASE GATE: ALL PASS" -ForegroundColor Green
exit 0
