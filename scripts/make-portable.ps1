# ============================================================================
# make-portable.ps1
#
# 用途：把 Tauri 打出的 NSIS installer 解包，生成便携版目录
#       用户直接把整个目录复制到 U 盘就能用，无需安装
#
# 原理：
#   1. 从 target/release/bundle/nsis/ 找到最新的 *_setup.exe
#   2. 用 7z 或 NSIS 自解压参数解压到 portable 目录
#   3. 在 portable 目录创建空的 XiaoJuClawData/ 占位
#   4. 写一个 "双击此文件运行.txt" 说明
#
# 依赖：7-Zip（便携版编译服务器需要安装）
#       如未装 7z，回退到原生的 `$TARGET_DIR\release` 里的 exe + resources 手动拼接
#
# 参数：
#   -ReleaseRoot     release 根目录（默认 ../release）
#   -Variant         命名后缀（默认 portable）
# ============================================================================

[CmdletBinding()]
param(
    [string]$ReleaseRoot = (Join-Path $PSScriptRoot "..\release"),
    [string]$Variant = "portable"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TargetRelease = Join-Path $RepoRoot "src-tauri\target\release"
$NsisDir = Join-Path $TargetRelease "bundle\nsis"

Write-Host ""
Write-Host "=========================================="
Write-Host "  XiaoJuClaw 便携版打包"
Write-Host "=========================================="
Write-Host "  仓库根:    $RepoRoot"
Write-Host "  发布根:    $ReleaseRoot"
Write-Host "  变体:      $Variant"
Write-Host ""

# --- 定位版本号与时间戳 ---
$pkgJson = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$version = $pkgJson.version
$buildStamp = Get-Date -Format "yyyyMMdd-HHmmss"

$portableName = "XiaoJuClaw-$version-windows-$buildStamp-$Variant"
$portableDir = Join-Path $ReleaseRoot $portableName

Write-Host "[STEP] 准备产物目录: $portableDir"
if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
New-Item -Path $portableDir -ItemType Directory -Force | Out-Null

# --- 方式 A: 直接从 target/release 收集 exe + resources ---
# 优点：不依赖 7z；包含所有原始文件
# 缺点：需要手动处理依赖 DLL（WebView2Loader 等）

$mainExe = Join-Path $TargetRelease "XiaoJuClaw.exe"
$sidecarExe = Join-Path $TargetRelease "XiaoJuClaw-server.exe"

if (-not (Test-Path $mainExe)) {
    Write-Host "[ERROR] 未找到主程序 exe: $mainExe" -ForegroundColor Red
    Write-Host "        请先运行 bun run build:tauri 或 build-release.bat"
    exit 1
}

Write-Host "[STEP] 复制主程序 exe"
Copy-Item $mainExe $portableDir -Force
Rename-Item (Join-Path $portableDir "XiaoJuClaw.exe") "XiaoJuClaw.exe"

if (Test-Path $sidecarExe) {
    Write-Host "[STEP] 复制 sidecar"
    Copy-Item $sidecarExe $portableDir -Force
}

# resources 文件夹（如果 Tauri 把资源输出到独立目录）
$targetResources = Join-Path $TargetRelease "resources"
if (Test-Path $targetResources) {
    Write-Host "[STEP] 复制 resources/"
    Copy-Item $targetResources (Join-Path $portableDir "resources") -Recurse -Force
}

# --- 从 NSIS installer 补齐运行依赖（DLL 等） ---
if (Test-Path $NsisDir) {
    $setupExe = Get-ChildItem $NsisDir -Filter "*_setup.exe" -File |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1

    if ($setupExe) {
        Write-Host "[STEP] 尝试从 NSIS installer 解包依赖 DLL"
        Write-Host "       源: $($setupExe.FullName)"

        # 优先尝试 7z
        $sevenZip = $null
        $candidates = @(
            "C:\Program Files\7-Zip\7z.exe",
            "C:\Program Files (x86)\7-Zip\7z.exe",
            "$env:USERPROFILE\scoop\apps\7zip\current\7z.exe"
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { $sevenZip = $c; break }
        }
        if (-not $sevenZip) {
            $sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue)?.Source
        }

        if ($sevenZip) {
            $extractDir = Join-Path $env:TEMP "XiaoJuClaw-nsis-extract-$buildStamp"
            New-Item -Path $extractDir -ItemType Directory -Force | Out-Null
            try {
                & $sevenZip x "-o$extractDir" $setupExe.FullName -y | Out-Null
                # NSIS installer 里的 $PLUGINSDIR 是临时资源，$_OUTDIR 是目标
                # 实际应用文件通常在解压根目录下
                $filesToCopy = @(
                    "WebView2Loader.dll",
                    "vcruntime140*.dll",
                    "msvcp140*.dll"
                )
                foreach ($pattern in $filesToCopy) {
                    Get-ChildItem $extractDir -Filter $pattern -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
                        Copy-Item $_.FullName $portableDir -Force
                        Write-Host "       + $($_.Name)"
                    }
                }
            } finally {
                if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue }
            }
        } else {
            Write-Host "[WARN] 未安装 7-Zip，跳过 DLL 自动提取" -ForegroundColor Yellow
            Write-Host "       便携版可能缺少 WebView2Loader.dll 等运行时文件"
            Write-Host "       建议安装 https://www.7-zip.org/ 后重新运行"
        }
    }
}

# --- 预置 XiaoJuClawData 空目录 ---
Write-Host "[STEP] 创建便携数据目录占位"
$dataDir = Join-Path $portableDir "XiaoJuClawData"
New-Item -Path $dataDir -ItemType Directory -Force | Out-Null
New-Item -Path (Join-Path $dataDir "logs") -ItemType Directory -Force | Out-Null
New-Item -Path (Join-Path $dataDir "workspace") -ItemType Directory -Force | Out-Null

# --- 使用说明 ---
$readmePath = Join-Path $portableDir "请先阅读.txt"
@"
XiaoJuClaw 便携版 $version
========================================

使用方法：
  1. 把整个文件夹（包含 XiaoJuClaw.exe 和 XiaoJuClawData）复制到 U 盘或任意目录
  2. 双击 XiaoJuClaw.exe 启动
  3. 首次运行会在同目录自动生成用户数据到 XiaoJuClawData\
  4. 拔掉 U 盘后，数据保留在 U 盘里；插到其他电脑继续用

首次运行前的系统要求：
  - Windows 10 64 位或更新
  - 已安装 Microsoft Edge WebView2 Runtime
    （Windows 11 自带，Windows 10 可能需要手动安装）
    下载: https://developer.microsoft.com/microsoft-edge/webview2

目录结构：
  XiaoJuClaw.exe          主程序，双击运行
  XiaoJuClaw-server.exe   后台服务（AI 能力）
  XiaoJuClawData\         用户数据目录（首次运行自动创建）
    settings.json         用户设置
    secrets.json          用户自带 API Key（本地加密）
    logs\                 运行日志
    workspace\            工作区文件

注意事项：
  - 不要把此文件夹放在只读 U 盘或需要管理员权限的目录
  - U 盘建议 NTFS 或 exFAT 格式，不要用 FAT32
  - U 盘剩余空间建议大于 2GB
  - 正式版已连接线上服务，需要联网使用

出问题时：
  - 打开 XiaoJuClawData\logs\ 查看日志
  - 联系运维提供日志文件
"@ | Set-Content -Path $readmePath -Encoding UTF8

Write-Host ""
Write-Host "=========================================="
Write-Host "  便携版打包完成"
Write-Host "=========================================="
Write-Host "  位置: $portableDir"
Write-Host ""

# 列出目录内容
Get-ChildItem $portableDir | ForEach-Object {
    $size = if ($_.PSIsContainer) { "<DIR>" } else { "{0:N2} MB" -f ($_.Length / 1MB) }
    Write-Host ("  {0,-35} {1}" -f $_.Name, $size)
}

Write-Host ""
Write-Host "后续：整个目录复制到 U 盘即可交付用户"
Write-Host ""
