# build-lock.ps1 - Cross-process release build lock (PowerShell 5.1 compatible).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("acquire", "release")]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$Token,
  # Optional override for the lock location (used by tests). Production callers
  # rely on the default: the desktop repo root that owns this script.
  [string]$LockRoot
)

$ErrorActionPreference = "Stop"
$repo = if ($LockRoot) { $LockRoot } else { Split-Path -Parent $PSScriptRoot }
$lockDir = Join-Path $repo ".xjc-build-lock"
$tokenPath = Join-Path $lockDir "token.txt"
$createdPath = Join-Path $lockDir "created-at.txt"
$ownerPidPath = Join-Path $lockDir "owner-pid.txt"
$ownerStartPath = Join-Path $lockDir "owner-start.txt"

# The parent of this PowerShell process is the cmd.exe that runs the top-level
# build script and stays alive for the whole build. Recording it lets a crashed
# or Ctrl+C'd build release the lock automatically on the next attempt instead
# of blocking every retry until the 12-hour age fallback expires.
function Get-OwnerProcessInfo {
  try {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    if (-not $me) { return $null }
    $ppid = [int]$me.ParentProcessId
    if ($ppid -le 0) { return $null }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $ppid" -ErrorAction Stop
    if (-not $parent) { return $null }
    $start = ([DateTime]$parent.CreationDate).ToUniversalTime().ToString("o")
    return [pscustomobject]@{ Pid = $ppid; Start = $start }
  } catch {
    return $null
  }
}

function Test-OwnerAlive([int]$ownerPid, [string]$ownerStartIso) {
  if ($ownerPid -le 0) { return $false }
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
    if (-not $p) { return $false }
    if ($ownerStartIso) {
      $recorded = ([DateTime]::Parse($ownerStartIso)).ToUniversalTime()
      $actual = ([DateTime]$p.CreationDate).ToUniversalTime()
      # A different start time means the PID was recycled for another process.
      if ([Math]::Abs(($recorded - $actual).TotalSeconds) -gt 5) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

function New-BuildLock {
  New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
  Set-Content -LiteralPath $tokenPath -Value $Token -Encoding ASCII
  Set-Content -LiteralPath $createdPath -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ASCII
  $owner = Get-OwnerProcessInfo
  if ($owner) {
    Set-Content -LiteralPath $ownerPidPath -Value ([string]$owner.Pid) -Encoding ASCII
    Set-Content -LiteralPath $ownerStartPath -Value $owner.Start -Encoding ASCII
  }
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

    # Auto-reclaim when the owning build process is no longer running.
    $ownerPid = 0
    try { $ownerPid = [int]((Get-Content -LiteralPath $ownerPidPath -Raw).Trim()) } catch { $ownerPid = 0 }
    $ownerStart = ""
    try { $ownerStart = (Get-Content -LiteralPath $ownerStartPath -Raw).Trim() } catch { $ownerStart = "" }

    if ($ownerPid -gt 0) {
      if (-not (Test-OwnerAlive $ownerPid $ownerStart)) {
        Write-Host ("[WARN] Reclaiming a build lock whose owner (PID " + $ownerPid + ") is no longer running.") -ForegroundColor Yellow
        Remove-Item -LiteralPath $lockDir -Recurse -Force
        New-BuildLock
        Write-Host ("[OK] Build lock acquired after stale-lock cleanup: " + $lockDir)
        exit 0
      }
      Write-Host ("[ERROR] Another release build (PID " + $ownerPid + ") owns: " + $lockDir) -ForegroundColor Red
      Write-Host "Wait for it to finish, or stop that process before retrying." -ForegroundColor Yellow
      exit 1
    }

    # Legacy locks without owner metadata fall back to an age threshold.
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
