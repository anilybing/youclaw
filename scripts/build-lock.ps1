# build-lock.ps1 - Cross-process release build lock (PowerShell 5.1 compatible).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("acquire", "release")]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$Token
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$lockDir = Join-Path $repo ".xjc-build-lock"
$tokenPath = Join-Path $lockDir "token.txt"
$createdPath = Join-Path $lockDir "created-at.txt"

function New-BuildLock {
  New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
  Set-Content -LiteralPath $tokenPath -Value $Token -Encoding ASCII
  Set-Content -LiteralPath $createdPath -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ASCII
}

if ($Action -eq "acquire") {
  try {
    New-BuildLock
    Write-Host ("[OK] Build lock acquired: " + $lockDir)
    exit 0
  } catch {
    $existing = ""
    try { $existing = (Get-Content -LiteralPath $tokenPath -Raw).Trim() } catch {}
    if ($existing -eq $Token) {
      Write-Host "[OK] Reusing caller-owned build lock"
      exit 0
    }
    $created = [DateTime]::MinValue
    try { $created = [DateTime]::Parse((Get-Content -LiteralPath $createdPath -Raw)).ToUniversalTime() } catch {}
    if ($created -ne [DateTime]::MinValue -and $created -lt [DateTime]::UtcNow.AddHours(-12)) {
      Write-Host "[WARN] Removing a build lock older than 12 hours." -ForegroundColor Yellow
      Remove-Item -LiteralPath $lockDir -Recurse -Force
      New-BuildLock
      Write-Host ("[OK] Build lock acquired after stale-lock cleanup: " + $lockDir)
      exit 0
    }
    Write-Host ("[ERROR] Another release build owns: " + $lockDir) -ForegroundColor Red
    Write-Host "If no build is running, remove this stale directory manually." -ForegroundColor Yellow
    exit 1
  }
}

if (-not (Test-Path -LiteralPath $lockDir)) { exit 0 }
$existing = ""
try { $existing = (Get-Content -LiteralPath $tokenPath -Raw).Trim() } catch {}
if ($existing -ne $Token) {
  Write-Host "[ERROR] Refusing to release a build lock owned by another process." -ForegroundColor Red
  exit 1
}
Remove-Item -LiteralPath $lockDir -Recurse -Force
Write-Host "[OK] Build lock released"
