# make-usb-payload.ps1 - Build the USB tools payload for XiaoJuClaw portable delivery.
#
# Produces:  <Target>\XiaoJuClawData\tools\<platform>\{bun,git,python,uv,node}
#            <Target>\XiaoJuClawData\tools\manifest.json
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\make-usb-payload.ps1
#   powershell -File scripts\make-usb-payload.ps1 -Target E:\ -IncludeNode
#   powershell -File scripts\make-usb-payload.ps1 -DryRun          # print plan only
#   powershell -File scripts\make-usb-payload.ps1 -Only uv         # single tool (debug)
#
# Notes:
#   - Downloads are cached in -CacheDir (default .\tool-cache), re-runs are cheap.
#   - Versions follow app.config.ts (keep in sync manually when bumping there).
#   - Only win-x64 payload is supported for now (T-E5 scope).

param(
  [string]$Target = ".\usb-payload",
  [string]$Platform = "win-x64",
  [string]$CacheDir = ".\tool-cache",
  [switch]$IncludeNode,
  [switch]$DryRun,
  [string]$Only = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Platform -ne "win-x64") {
  Write-Host "[ERROR] Only win-x64 payload is supported in this version." -ForegroundColor Red
  exit 1
}

# ---- Tool matrix (versions aligned with app.config.ts) ----------------------
$tools = @(
  @{
    name = "bun"; version = "1.2.15";
    url = "https://github.com/oven-sh/bun/releases/download/bun-v1.2.15/bun-windows-x64.zip";
    kind = "zip"; stripRoot = $true    # zip contains bun-windows-x64/bun.exe
  },
  @{
    name = "git"; version = "2.53.0.2";
    url = "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/PortableGit-2.53.0.2-64-bit.7z.exe";
    kind = "sfx7z"; stripRoot = $false # self-extracting 7z: run with -y -o<dir>
  },
  @{
    name = "python"; version = "3.12.8";
    url = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip";
    kind = "zip"; stripRoot = $false
  },
  @{
    name = "uv"; version = "0.7.12";
    url = "https://github.com/astral-sh/uv/releases/download/0.7.12/uv-x86_64-pc-windows-msvc.zip";
    kind = "zip"; stripRoot = $false
  }
)
if ($IncludeNode) {
  $tools += @{
    name = "node"; version = "22.14.0";
    url = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip";
    kind = "zip"; stripRoot = $true
  }
}
if ($Only) {
  $tools = @($tools | Where-Object { $_.name -eq $Only })
  if ($tools.Count -eq 0) { Write-Host "[ERROR] Unknown tool: $Only" -ForegroundColor Red; exit 1 }
}

$toolsRoot = Join-Path (Join-Path $Target "XiaoJuClawData") "tools"
$platformRoot = Join-Path $toolsRoot $Platform

Write-Host "== XiaoJuClaw USB payload builder =="
Write-Host "   Platform : $Platform"
Write-Host "   Target   : $toolsRoot"
Write-Host "   Cache    : $CacheDir"
foreach ($t in $tools) { Write-Host ("   - {0} {1}" -f $t.name, $t.version) }
if ($DryRun) { Write-Host "[dry-run] no downloads performed."; exit 0 }

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $platformRoot | Out-Null

function Get-FileSha256([string]$path) {
  (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLowerInvariant()
}

function Download-Tool([hashtable]$tool) {
  $fileName = Split-Path $tool.url -Leaf
  $cachePath = Join-Path $CacheDir $fileName
  if (Test-Path $cachePath) {
    Write-Host ("[cache] {0}" -f $fileName)
  } else {
    Write-Host ("[download] {0}" -f $tool.url)
    Invoke-WebRequest -Uri $tool.url -OutFile $cachePath -UseBasicParsing
  }
  return $cachePath
}

function Install-Zip([string]$archive, [string]$dest, [bool]$stripRoot) {
  $tmp = Join-Path $env:TEMP ("xjc-payload-" + [Guid]::NewGuid().ToString("N"))
  Expand-Archive -Path $archive -DestinationPath $tmp -Force
  $entries = @(Get-ChildItem -Path $tmp)
  $src = $tmp
  if ($stripRoot -and $entries.Count -eq 1 -and $entries[0].PSIsContainer) {
    $src = $entries[0].FullName
  }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Path (Join-Path $src "*") -Destination $dest -Recurse -Force
  Remove-Item -Recurse -Force $tmp
}

function Install-Sfx7z([string]$archive, [string]$dest) {
  # PortableGit self-extracting archive supports silent extraction.
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $proc = Start-Process -FilePath $archive -ArgumentList @("-y", "-o`"$dest`"") -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "PortableGit extraction failed with exit code $($proc.ExitCode)" }
}

$manifestTools = @()
foreach ($t in $tools) {
  $dest = Join-Path $platformRoot $t.name
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  $archive = Download-Tool $t
  $sha = Get-FileSha256 $archive
  Write-Host ("[install] {0} -> {1}" -f $t.name, $dest)
  switch ($t.kind) {
    "zip"   { Install-Zip $archive $dest $t.stripRoot }
    "sfx7z" { Install-Sfx7z $archive $dest }
    default { throw "Unknown kind: $($t.kind)" }
  }
  $manifestTools += [ordered]@{
    name = $t.name
    version = $t.version
    dir = "$Platform/$($t.name)"
    sha256 = $sha
    source = $t.url
  }
}

$manifest = [ordered]@{
  schemaVersion = 1
  platform = $Platform
  tools = $manifestTools
  createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$manifestPath = Join-Path $toolsRoot "manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8
Write-Host "[ok] manifest written: $manifestPath"

# ---- Self check --------------------------------------------------------------
$checks = @(
  @{ tool = "bun";    file = "bun.exe" },
  @{ tool = "git";    file = "cmd\git.exe" },
  @{ tool = "python"; file = "python.exe" },
  @{ tool = "uv";     file = "uv.exe" }
)
if ($IncludeNode) { $checks += @{ tool = "node"; file = "node.exe" } }
$failed = 0
foreach ($c in $checks) {
  if ($Only -and $c.tool -ne $Only) { continue }
  $p = Join-Path (Join-Path $platformRoot $c.tool) $c.file
  if (Test-Path $p) {
    Write-Host ("[check] {0} OK" -f $c.tool)
  } else {
    Write-Host ("[check] {0} MISSING: {1}" -f $c.tool, $p) -ForegroundColor Red
    $failed++
  }
}
if ($failed -gt 0) { Write-Host "[FAIL] $failed tool(s) missing." -ForegroundColor Red; exit 1 }
Write-Host "== payload ready: $toolsRoot =="
exit 0
