# make-usb-payload.ps1 - Build the USB tools payload for XiaoJuClaw portable delivery.
#
# Produces:  <Target>\XiaoJuClawRuntime\tools\<platform>\{bun,git,python,uv,node}
#            <Target>\XiaoJuClawRuntime\tools\manifest.json
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\make-usb-payload.ps1
#   powershell -File scripts\make-usb-payload.ps1 -Target E:\ -IncludeNode
#   powershell -File scripts\make-usb-payload.ps1 -DryRun          # print plan only
#   powershell -File scripts\make-usb-payload.ps1 -Only uv         # single tool (debug)
#   powershell -File scripts\make-usb-payload.ps1 -Only pytools    # local-intelligence only (debug)
#   powershell -File scripts\make-usb-payload.ps1 -PytoolsSource D:\staging\pytools
#   powershell -File scripts\make-usb-payload.ps1 -SkipPytools     # ship without semantic memory / local OCR
#
# Notes:
#   - Downloads are cached in -CacheDir (default .\tool-cache), re-runs are cheap.
#   - Versions follow app.config.ts (keep in sync manually when bumping there).
#   - Only win-x64 payload is supported for now (T-E5 scope).
#   - pytools (semantic memory + local OCR) is an OPTIONAL payload: auto-detected from
#     %APPDATA%\com.youclaw.app\pytools (built by scripts\setup-local-intelligence.mjs).
#     Missing -> warn and ship without it; explicit -PytoolsSource failing validation -> error.
#     Bundled wheels must be cp312 to match the embedded Python 3.12 (validated).

param(
  [string]$Target = ".\usb-payload",
  [string]$Platform = "win-x64",
  [string]$CacheDir = ".\tool-cache",
  [switch]$IncludeNode,
  [switch]$DryRun,
  [string]$Only = "",
  # Optional local-intelligence payload (semantic memory + local OCR).
  # Default: auto-detect the operator machine's installed pytools directory
  # (%APPDATA%\com.youclaw.app\pytools, produced by setup-local-intelligence.mjs).
  # Missing source is a WARN+skip (optional capability); an explicit -PytoolsSource
  # that fails validation is an ERROR.
  [string]$PytoolsSource = "",
  [switch]$SkipPytools
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
$onlyPytools = ($Only -eq "pytools")
if ($Only -and -not $onlyPytools) {
  $tools = @($tools | Where-Object { $_.name -eq $Only })
  if ($tools.Count -eq 0) { Write-Host "[ERROR] Unknown tool: $Only" -ForegroundColor Red; exit 1 }
}
if ($onlyPytools) { $tools = @() }

$toolsRoot = Join-Path (Join-Path $Target "XiaoJuClawRuntime") "tools"
$platformRoot = Join-Path $toolsRoot $Platform

# ---- Local-intelligence payload (pytools: semantic memory + local OCR) -------
# Expected python ABI tag for bundled wheels (python 3.12.x -> cp312).
$expectedCpTag = "cp312"

function Resolve-PytoolsSource {
  if ($SkipPytools) { return $null }
  if ($PytoolsSource) { return (Resolve-Path $PytoolsSource -ErrorAction SilentlyContinue) }
  if ($env:APPDATA) {
    $candidate = Join-Path $env:APPDATA "com.youclaw.app\pytools"
    if (Test-Path (Join-Path $candidate "pytools.json")) { return $candidate }
  }
  return $null
}

function Test-PytoolsSource([string]$src) {
  $problems = @()
  $manifestPath = Join-Path $src "pytools.json"
  if (-not (Test-Path $manifestPath)) {
    return ,@("missing pytools.json (run scripts\setup-local-intelligence.mjs first)")
  }
  try {
    $raw = (Get-Content $manifestPath -Raw) -replace "^\xEF\xBB\xBF", ""
    $meta = $raw | ConvertFrom-Json
  } catch {
    return ,@("unreadable pytools.json: $($_.Exception.Message)")
  }
  if ($meta.schemaVersion -ne 1) { $problems += "pytools.json schemaVersion must be 1" }
  $site = Join-Path $src "site-packages"
  if (-not (Test-Path $site) -or (@(Get-ChildItem $site -ErrorAction SilentlyContinue).Count -eq 0)) {
    $problems += "site-packages missing or empty"
  }
  if ($meta.embedding -eq $true) {
    $model = Join-Path $src "models\bge-small-zh-v1.5\model.onnx"
    $tokenizer = Join-Path $src "models\bge-small-zh-v1.5\tokenizer.json"
    if (-not (Test-Path $model) -or (Get-Item $model).Length -lt 1MB) { $problems += "embedding model.onnx missing or truncated" }
    if (-not (Test-Path $tokenizer) -or (Get-Item $tokenizer).Length -lt 10KB) { $problems += "embedding tokenizer.json missing or truncated" }
  }
  # ABI guard: bundled wheels must be loadable by the bundled embedded python (3.12).
  # Compatible: py*-none-any (pure python), cp3XX-abi3 with XX <= 12 (stable ABI is
  # forward compatible), or exactly cp312-cp312. Incompatible: cp3XX-cp3XX with XX != 12,
  # or abi3 built against a NEWER python than 3.12.
  $expectedCpMinor = [int]($expectedCpTag -replace "^cp3", "")
  if (Test-Path $site) {
    $wheelFiles = Get-ChildItem $site -Directory -Filter "*.dist-info" -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "WHEEL" } | Where-Object { Test-Path $_ }
    foreach ($wheel in $wheelFiles) {
      $tagLines = @(Select-String -Path $wheel -Pattern "^Tag:\s*(\S+)" -ErrorAction SilentlyContinue)
      if ($tagLines.Count -eq 0) { continue }
      $anyCompatible = $false
      $seenTags = @()
      foreach ($line in $tagLines) {
        $tag = $line.Matches[0].Groups[1].Value
        $seenTags += $tag
        $parts = $tag -split "-"
        if ($parts.Count -lt 2) { continue }
        $pyTag = $parts[0]; $abiTag = $parts[1]
        if ($abiTag -eq "none") { $anyCompatible = $true; break }               # pure python
        if ($pyTag -match "^cp3(\d+)$") {
          $minor = [int]$Matches[1]
          if ($abiTag -eq "abi3" -and $minor -le $expectedCpMinor) { $anyCompatible = $true; break }
          if ($abiTag -eq $expectedCpTag -and $pyTag -eq $expectedCpTag) { $anyCompatible = $true; break }
        }
      }
      if (-not $anyCompatible) {
        $problems += ("wheel ABI mismatch: {0} tags [{1}] not loadable by bundled Python 3.{2} (re-run setup with Python 3.{2})" -f (Split-Path (Split-Path $wheel) -Leaf), ($seenTags -join ", "), $expectedCpMinor)
      }
    }
  }
  return ,$problems
}

$pytoolsSrc = Resolve-PytoolsSource
if ($PytoolsSource -and -not $pytoolsSrc) {
  Write-Host "[ERROR] -PytoolsSource path not found: $PytoolsSource" -ForegroundColor Red
  exit 1
}

Write-Host "== XiaoJuClaw USB payload builder =="
Write-Host "   Platform : $Platform"
Write-Host "   Target   : $toolsRoot"
Write-Host "   Cache    : $CacheDir"
foreach ($t in $tools) { Write-Host ("   - {0} {1}" -f $t.name, $t.version) }
if ($SkipPytools) {
  Write-Host "   - pytools: skipped (-SkipPytools)"
} elseif ($pytoolsSrc) {
  Write-Host ("   - pytools: {0}" -f $pytoolsSrc)
} else {
  Write-Host "   - pytools: not found (optional; run setup-local-intelligence.mjs to enable semantic memory + local OCR)" -ForegroundColor Yellow
}
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

# ---- Local-intelligence payload copy (optional) ------------------------------
$pytoolsCopied = $false
if (-not $SkipPytools -and $pytoolsSrc) {
  $problems = Test-PytoolsSource $pytoolsSrc
  if ($problems.Count -gt 0) {
    Write-Host "[ERROR] pytools source failed validation:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "        $_" -ForegroundColor Red }
    if ($PytoolsSource) { exit 1 }   # explicit source must be valid
    Write-Host "        (auto-detected source rejected; shipping without pytools)" -ForegroundColor Yellow
  } else {
    $pytoolsDest = Join-Path $platformRoot "pytools"
    if (Test-Path $pytoolsDest) { Remove-Item -Recurse -Force $pytoolsDest }
    Write-Host ("[install] pytools -> {0}" -f $pytoolsDest)
    # robocopy: exclude __pycache__ (regenerated at runtime) and runtime-materialized scripts/
    # (the app re-materializes them from its embedded sources, keeping script/binary in lockstep).
    & robocopy $pytoolsSrc $pytoolsDest /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ scripts | Out-Null
    if ($LASTEXITCODE -ge 8) {
      Write-Host "[ERROR] robocopy failed copying pytools (exit $LASTEXITCODE)" -ForegroundColor Red
      exit 1
    }
    $global:LASTEXITCODE = 0
    try {
      $rawMeta = (Get-Content (Join-Path $pytoolsSrc "pytools.json") -Raw) -replace "^\xEF\xBB\xBF", ""
      $pytoolsMeta = $rawMeta | ConvertFrom-Json
      $pytoolsVersion = if ($pytoolsMeta.installedAt) { [string]$pytoolsMeta.installedAt } else { "unversioned" }
    } catch { $pytoolsVersion = "unversioned" }
    $manifestTools += [ordered]@{
      name = "pytools"
      version = $pytoolsVersion
      dir = "$Platform/pytools"
    }
    $pytoolsCopied = $true
  }
}

$manifest = [ordered]@{
  schemaVersion = 1
  platform = $Platform
  tools = $manifestTools
  createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$manifestPath = Join-Path $toolsRoot "manifest.json"
# -Only debug mode must not clobber entries from a previous full run: merge by name.
if ($Only -and (Test-Path $manifestPath)) {
  try {
    $existingRaw = (Get-Content $manifestPath -Raw) -replace "^\xEF\xBB\xBF", ""
    $existing = $existingRaw | ConvertFrom-Json
    if ($existing.tools) {
      $newNames = @($manifestTools | ForEach-Object { $_.name })
      $kept = @($existing.tools | Where-Object { $newNames -notcontains $_.name })
      $manifest.tools = @($kept) + @($manifestTools)
    }
  } catch { <# unreadable old manifest: overwrite with fresh one #> }
}
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
if ($pytoolsCopied) { $checks += @{ tool = "pytools"; file = "pytools.json" } }
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
