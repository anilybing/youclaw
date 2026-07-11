// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { Hono } from 'hono'
import { existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v4'
import { which, resetShellEnvCache, getShellEnv } from '../utils/shell-env.ts'
import { getLogger } from '../logger/index.ts'
import { fetchRemoteMediaToBuffer } from '../channel/media-fetch.ts'
import {
  BUN_CDN_BASE, BUN_GITHUB_BASE, BUN_VERSION,
  GIT_CDN_URL, GIT_VERSION,
  UV_CDN_BASE, UV_GITHUB_BASE, UV_VERSION,
} from '../config/tools.ts'
import {
  ensurePortableToolsInPath,
  getPortableToolInstallDir,
  isPathInPortableTools,
  upsertToolsManifestEntry,
} from '../config/portable-tools.ts'
import { isPortableMode } from '../config/paths.ts'

// ---------------------------------------------------------------------------
// Portable Tools Directory — 实现已迁至 src/config/portable-tools.ts（T-E2）
// 此处 re-export 保持旧导入路径兼容
// ---------------------------------------------------------------------------
export {
  getPlatformKey,
  getPortableToolsDir,
  getPortableToolDir,
  getPortableToolInstallDir,
  resolvePortableToolDir,
  ensurePortableToolsInPath,
  readToolsManifest,
  writeToolsManifest,
  upsertToolsManifestEntry,
  isPathInPortableTools,
  checkManifestVersions,
  getExpectedToolVersions,
} from '../config/portable-tools.ts'

// 模块加载时立即执行，确保后续所有 which() 调用都能找到便携工具
// （dev 下此刻 loadEnv() 可能未执行导致静默失败，src/index.ts 启动序列会兜底再调一次并打日志）
try {
  ensurePortableToolsInPath()
} catch { /* 首次启动 data dir 可能还没初始化 */ }

const health = new Hono()

/** 安装结果统一结构；installedTo 为安装目录绝对路径（系统级安装如 winget/xcode-select 为 null） */
interface InstallResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  installedTo: string | null
}

function sha256Hex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  return createHash('sha256').update(bytes).digest('hex')
}

/** 安装成功后写入 tools/manifest.json；失败仅告警，不影响安装结果 */
function recordToolInManifest(entry: { name: string; version: string; dir: string; sha256?: string }): void {
  try {
    upsertToolsManifestEntry(entry)
    getLogger().info({ category: 'install', tool: entry.name }, `[manifest] Recorded ${entry.name}@${entry.version} -> ${entry.dir}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    getLogger().warn({ category: 'install', tool: entry.name }, `[manifest] Failed to update manifest: ${msg}`)
  }
}

/**
 * 下载 URL 到内存缓冲（流式读取 + 整体超时）。
 * 不用 resp.arrayBuffer()：部分环境下 Bun 对重定向后的大响应调用 arrayBuffer()
 * 异常缓慢（同一文件流式读取数秒完成，arrayBuffer 需分钟级），导致下载超时。
 * 非 2xx 或超时均抛错，由调用方按"CDN 优先 GitHub 兜底"逐个 URL 重试。
 */
async function downloadToBuffer(url: string, timeoutMs: number): Promise<Buffer> {
  return (await fetchRemoteMediaToBuffer(url, {
    maxBytes: 256 * 1024 * 1024,
    timeoutMs,
    headers: { Accept: 'application/zip,application/octet-stream,*/*' },
  })).buffer
}

health.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

/**
 * Read live PATH from Windows registry (not inherited process.env).
 * System PATH: HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment\Path
 * User PATH:   HKCU\Environment\Path
 * Combines both, then searches for git.exe in each directory.
 */
function findGitFromRegistry(): string | null {
  const paths: string[] = []

  // Read system PATH from registry
  try {
    const sysOut = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const m = sysOut.match(/Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i)
    if (m?.[1]) {
      // Expand %SystemRoot% etc. by resolving env vars
      let expanded = m[1].trim()
      expanded = expanded.replace(/%([^%]+)%/g, (_, key: string) => process.env[key] || `%${key}%`)
      paths.push(...expanded.split(';').filter(Boolean))
    }
  } catch { /* ignore */ }

  // Read user PATH from registry
  try {
    const userOut = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf-8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const m = userOut.match(/Path\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i)
    if (m?.[1]) {
      let expanded = m[1].trim()
      expanded = expanded.replace(/%([^%]+)%/g, (_, key: string) => process.env[key] || `%${key}%`)
      paths.push(...expanded.split(';').filter(Boolean))
    }
  } catch { /* ignore */ }

  // Search for git.exe in each path entry
  for (const dir of paths) {
    const gitExe = resolve(dir, 'git.exe')
    if (existsSync(gitExe)) return gitExe
  }

  return null
}

/**
 * Detect a tool by trying a list of commands and retrieving its version.
 * Resets the shell env cache first so newly installed tools are picked up.
 */
function checkTool(commands: string[], versionFlag = '--version'): { path: string | null; version: string | null } {
  resetShellEnvCache()
  ensurePortableToolsInPath()
  for (const cmd of commands) {
    const p = which(cmd)
    if (p) {
      let version: string | null = null
      try {
        version = execSync(`"${p}" ${versionFlag}`, {
          timeout: 5000,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
      } catch { /* ignore version detection failure */ }
      return { path: p, version }
    }
  }
  return { path: null, version: null }
}

/**
 * Detect Git, with special handling for Windows (registry lookup).
 */
function checkGit(): { path: string | null; version: string | null } {
  let gitPath: string | null = null

  if (process.platform === 'win32') {
    // Windows: try registry first, then fall back to which
    gitPath = findGitFromRegistry() ?? which('git')
  } else {
    // macOS/Linux: refresh cache and use which
    resetShellEnvCache()
    gitPath = which('git')
  }

  if (!gitPath) return { path: null, version: null }

  let version: string | null = null
  try {
    version = execSync(`"${gitPath}" --version`, {
      timeout: 5000,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch { /* ignore */ }

  return { path: gitPath, version }
}

/**
 * Check if a Node.js version string satisfies the minimum requirement (>=18).
 */
function isNodeVersionSufficient(version: string): boolean {
  const major = parseInt(version.replace(/^v/, '').split('.')[0] ?? '0', 10)
  return major >= 18
}

// GET /api/git-check — check if git is available (backward compatible)
health.get('/git-check', (c) => {
  const result = checkGit()
  return c.json({ available: result.path !== null, path: result.path })
})

// GET /api/env-check — check all environment dependencies
health.get('/env-check', (c) => {
  const platform = process.platform
  const isWindows = platform === 'win32'

  const dependencies: Array<{
    name: string
    available: boolean
    path: string | null
    version: string | null
    required: boolean
    source: 'portable' | 'system' | null
  }> = []

  // 来源标注：path 位于便携 tools 目录 → 'portable'；其他 → 'system'；缺失 → null
  const sourceOf = (path: string | null): 'portable' | 'system' | null => {
    if (!path) return null
    return isPathInPortableTools(path) ? 'portable' : 'system'
  }

  // 1. Git (required on all platforms)
  const git = checkGit()
  dependencies.push({
    name: 'git',
    available: git.path !== null,
    path: git.path,
    version: git.version,
    required: true,
    source: sourceOf(git.path),
  })

  // 2. Bun (required on all platforms)
  const bun = checkTool(['bun'])
  dependencies.push({
    name: 'bun',
    available: bun.path !== null,
    path: bun.path,
    version: bun.version,
    required: true,
    source: sourceOf(bun.path),
  })

  // 3. Node.js (optional — fallback runtime on Windows if Bun compat is insufficient)
  const node = checkTool(['node'])
  let nodeAvailable = node.path !== null
  if (isWindows && nodeAvailable && node.version) {
    if (!isNodeVersionSufficient(node.version)) {
      nodeAvailable = false
    }
  }
  dependencies.push({
    name: 'node',
    available: nodeAvailable,
    path: node.path,
    version: node.version,
    required: false,
    source: sourceOf(node.path),
  })

  // 4. Python (optional, all platforms)
  const pythonCmds = isWindows ? ['python3', 'python', 'py'] : ['python3', 'python']
  const python = checkTool(pythonCmds)
  dependencies.push({
    name: 'python',
    available: python.path !== null,
    path: python.path,
    version: python.version,
    required: false,
    source: sourceOf(python.path),
  })

  // 5. uv (optional, all platforms)
  const uv = checkTool(['uv'])
  dependencies.push({
    name: 'uv',
    available: uv.path !== null,
    path: uv.path,
    version: uv.version,
    required: false,
    source: sourceOf(uv.path),
  })

  return c.json({ platform, dependencies })
})

// POST /api/install-tool — install a system tool
const installToolSchema = z.object({
  tool: z.enum(['bun', 'git', 'node', 'uv', 'python']),
})


/**
 * Get the Bun zip filename for the current platform.
 */
function getBunZipTarget(): string | null {
  const arch = process.arch // 'arm64' | 'x64'
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? 'bun-darwin-aarch64.zip' : 'bun-darwin-x64.zip'
  }
  if (process.platform === 'win32') {
    return 'bun-windows-x64.zip'
  }
  if (process.platform === 'linux') {
    return arch === 'arm64' ? 'bun-linux-aarch64.zip' : 'bun-linux-x64.zip'
  }
  return null
}

/**
 * Download Bun from CDN (with GitHub fallback), extract to the tools dir
 * (portable mode: tools/<platformKey>/bun/ on the USB drive; otherwise tools/bun/).
 * Pure JS implementation using Bun built-in fetch + unzip.
 */
async function installBun(): Promise<InstallResult> {
  const zipName = getBunZipTarget()
  if (!zipName) {
    const msg = `Unsupported platform: ${process.platform} ${process.arch}`
    getLogger().error({ category: 'install' }, `[install-bun] ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }

  const cdnUrl = `${BUN_CDN_BASE}/${zipName}`
  const githubUrl = `${BUN_GITHUB_BASE}/${zipName}`

  // Download zip: try CDN first, fallback to GitHub
  let zipBuffer: Buffer | null = null
  let downloadSource = ''
  for (const url of [cdnUrl, githubUrl]) {
    try {
      getLogger().info({ category: 'install' }, `[install-bun] Downloading from ${url}...`)
      zipBuffer = await downloadToBuffer(url, 120_000)
      downloadSource = url
      getLogger().info({ category: 'install' }, `[install-bun] Downloaded ${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)}MB from ${url}`)
      break
    } catch (err: any) {
      getLogger().warn({ category: 'install' }, `[install-bun] Failed to download from ${url}: ${err.message}`)
    }
  }

  if (!zipBuffer) {
    const msg = 'Failed to download Bun from CDN and GitHub'
    getLogger().error({ category: 'install' }, `[install-bun] ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }

  const zipSha256 = sha256Hex(zipBuffer)

  // Install directory — portable mode: tools/<platformKey>/bun/; otherwise tools/bun/
  const ext = process.platform === 'win32' ? '.exe' : ''
  const bunDir = getPortableToolInstallDir('bun')
  const bunPath = resolve(bunDir, `bun${ext}`)

  try {
    mkdirSync(bunDir, { recursive: true })

    // Write zip to temp file and extract
    const ts = Date.now()
    const tmpExtractDir = resolve(tmpdir(), `bun-extract-${ts}`)
    const tmpZip = resolve(tmpdir(), `bun-install-${ts}.zip`)
    writeFileSync(tmpZip, Buffer.from(zipBuffer))
    getLogger().info({ category: 'install' }, `[install-bun] Zip written to ${tmpZip}, extracting...`)

    // Extract into a dedicated temp directory to avoid conflicts
    mkdirSync(tmpExtractDir, { recursive: true })
    const folderName = zipName.replace('.zip', '')
    if (process.platform === 'win32') {
      try {
        execSync(`tar -xf "${tmpZip}" -C "${tmpExtractDir}"`, {
          timeout: 60_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpZip}' -DestinationPath '${tmpExtractDir}'"`,
          { timeout: 120_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      }
    } else {
      execSync(`unzip -o "${tmpZip}" -d "${tmpExtractDir}"`, {
        timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
      })
    }

    // Copy binary into the tools dir
    const extractedBun = resolve(tmpExtractDir, folderName, `bun${ext}`)
    if (!existsSync(extractedBun)) {
      const msg = `Extracted binary not found at ${extractedBun}`
      getLogger().error({ category: 'install' }, `[install-bun] ${msg}`)
      return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
    }

    const { copyFileSync } = await import('node:fs')
    copyFileSync(extractedBun, bunPath)
    if (process.platform !== 'win32') {
      chmodSync(bunPath, 0o755)
    }
    getLogger().info({ category: 'install' }, `[install-bun] Binary installed to ${bunPath}`)

    // Clean up temp files
    try {
      const { rmSync } = await import('node:fs')
      rmSync(tmpZip, { force: true })
      rmSync(tmpExtractDir, { recursive: true, force: true })
    } catch { /* ignore cleanup errors */ }

    recordToolInManifest({ name: 'bun', version: BUN_VERSION, dir: bunDir, sha256: zipSha256 })
    resetShellEnvCache()
    ensurePortableToolsInPath()

    const msg = `Bun installed to ${bunPath} (from ${downloadSource})`
    getLogger().info({ category: 'install' }, `[install-bun] ${msg}`)
    return { ok: true, stdout: msg, stderr: '', exitCode: 0, installedTo: bunDir }
  } catch (err: any) {
    const msg = err.message ?? String(err)
    getLogger().error({ category: 'install' }, `[install-bun] Install failed: ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }
}


/**
 * Download Git Portable into the resolved runtime tools directory on Windows.
 * Uses PortableGit self-extracting archive instead of system installer.
 * This way Git lives on the USB drive and doesn't need reinstalling on new machines.
 */
async function installGitWindows(): Promise<InstallResult> {
  const logger = getLogger()
  // Portable mode: tools/<platformKey>/git/ (installer lays out cmd/ bin/ inside); otherwise tools/git/
  const gitDir = getPortableToolInstallDir('git')

  // Download the Git installer zip from CDN
  logger.info({ category: 'install' }, `[install-git] Downloading from ${GIT_CDN_URL}...`)
  let zipBuffer: Buffer | null = null
  try {
    zipBuffer = await downloadToBuffer(GIT_CDN_URL, 180_000)
    logger.info({ category: 'install' }, `[install-git] Downloaded ${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)}MB`)
  } catch (err: any) {
    const msg = `Download failed: ${err.message}`
    logger.error({ category: 'install' }, `[install-git] ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }

  const zipSha256 = sha256Hex(zipBuffer)

  try {
    // Write zip to temp
    const ts = Date.now()
    const tmpZip = resolve(tmpdir(), `git-install-${ts}.zip`)
    const tmpExtractDir = resolve(tmpdir(), `git-extract-${ts}`)
    writeFileSync(tmpZip, Buffer.from(zipBuffer))
    logger.info({ category: 'install' }, `[install-git] Zip saved to ${tmpZip}, extracting...`)

    // Extract
    mkdirSync(tmpExtractDir, { recursive: true })
    try {
      execSync(`tar -xf "${tmpZip}" -C "${tmpExtractDir}"`, {
        timeout: 60_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpZip}' -DestinationPath '${tmpExtractDir}'"`,
        { timeout: 120_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    }

    // Find the .exe inside extracted directory
    const { readdirSync, copyFileSync, rmSync } = await import('node:fs')
    const files = readdirSync(tmpExtractDir)
    const exeFile = files.find(f => f.endsWith('.exe'))

    if (!exeFile) {
      const msg = `No .exe found in extracted zip (files: ${files.join(', ')})`
      logger.error({ category: 'install' }, `[install-git] ${msg}`)
      return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
    }

    const exePath = resolve(tmpExtractDir, exeFile)

    // Try portable extraction: run the installer with /DIR= to install to our tools dir
    // Git for Windows installer supports /DIR="path" for custom install location
    // and /PORTABLE=1 for portable mode (no registry, no PATH modification)
    logger.info({ category: 'install' }, `[install-git] Installing to portable dir: ${gitDir}`)

    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      stdout = execSync(`"${exePath}" /VERYSILENT /NORESTART /SP- /DIR="${gitDir}" /NOICONS /COMPONENTS="ext,ext\\shellhere,assoc,assoc_sh"`, {
        encoding: 'utf-8',
        timeout: 300_000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err: any) {
      stdout = err.stdout ?? ''
      stderr = err.stderr ?? ''
      exitCode = err.status ?? 1
    }

    // Clean up temp files
    try {
      rmSync(tmpZip, { force: true })
      rmSync(tmpExtractDir, { recursive: true, force: true })
    } catch { /* ignore */ }

    if (exitCode === 0) {
      recordToolInManifest({ name: 'git', version: GIT_VERSION, dir: gitDir, sha256: zipSha256 })
      logger.info({ category: 'install' }, `[install-git] Git installed successfully`)
    } else {
      logger.error({ category: 'install', exitCode, stderr }, `[install-git] Install failed`)
    }

    resetShellEnvCache()
    ensurePortableToolsInPath()

    return { ok: exitCode === 0, stdout, stderr, exitCode, installedTo: exitCode === 0 ? gitDir : null }
  } catch (err: any) {
    const msg = err.message ?? String(err)
    logger.error({ category: 'install' }, `[install-git] ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }
}

/**
 * Get the uv archive filename for the current platform.
 */
function getUvArchiveTarget(): { name: string; format: 'tar.gz' | 'zip' } | null {
  const arch = process.arch
  if (process.platform === 'darwin') {
    return arch === 'arm64'
      ? { name: 'uv-aarch64-apple-darwin.tar.gz', format: 'tar.gz' }
      : { name: 'uv-x86_64-apple-darwin.tar.gz', format: 'tar.gz' }
  }
  if (process.platform === 'win32') {
    return { name: 'uv-x86_64-pc-windows-msvc.zip', format: 'zip' }
  }
  if (process.platform === 'linux') {
    return arch === 'arm64'
      ? { name: 'uv-aarch64-unknown-linux-gnu.tar.gz', format: 'tar.gz' }
      : { name: 'uv-x86_64-unknown-linux-gnu.tar.gz', format: 'tar.gz' }
  }
  return null
}

/**
 * Download uv from CDN (with GitHub fallback), extract to the tools dir
 * (portable mode: tools/<platformKey>/uv/ on the USB drive; otherwise tools/uv/).
 */
async function installUv(): Promise<InstallResult> {
  const logger = getLogger()
  const target = getUvArchiveTarget()
  if (!target) {
    const msg = `Unsupported platform: ${process.platform} ${process.arch}`
    logger.error({ category: 'install' }, `[install-uv] ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }

  const cdnUrl = `${UV_CDN_BASE}/${target.name}`
  const githubUrl = `${UV_GITHUB_BASE}/${target.name}`

  // Download: try CDN first, fallback to GitHub
  let archiveBuffer: Buffer | null = null
  let downloadSource = ''
  for (const url of [cdnUrl, githubUrl]) {
    try {
      logger.info({ category: 'install' }, `[install-uv] Downloading from ${url}...`)
      archiveBuffer = await downloadToBuffer(url, 120_000)
      downloadSource = url
      logger.info({ category: 'install' }, `[install-uv] Downloaded ${(archiveBuffer.byteLength / 1024 / 1024).toFixed(1)}MB from ${url}`)
      break
    } catch (err: any) {
      logger.warn({ category: 'install' }, `[install-uv] Failed to download from ${url}: ${err.message}`)
    }
  }

  if (!archiveBuffer) {
    const msg = 'Failed to download uv from CDN and GitHub'
    logger.error({ category: 'install' }, `[install-uv] ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }

  const archiveSha256 = sha256Hex(archiveBuffer)

  const ext = process.platform === 'win32' ? '.exe' : ''
  // Install directory — portable mode: tools/<platformKey>/uv/; otherwise tools/uv/
  const binDir = getPortableToolInstallDir('uv')
  const uvPath = resolve(binDir, `uv${ext}`)
  const uvxPath = resolve(binDir, `uvx${ext}`)

  try {
    mkdirSync(binDir, { recursive: true })

    const ts = Date.now()
    const tmpExtractDir = resolve(tmpdir(), `uv-extract-${ts}`)
    mkdirSync(tmpExtractDir, { recursive: true })

    if (target.format === 'zip') {
      // Windows: use Bun's built-in JSZip-compatible decompress via shell
      const tmpZip = resolve(tmpdir(), `uv-install-${ts}.zip`)
      writeFileSync(tmpZip, Buffer.from(archiveBuffer))
      logger.info({ category: 'install' }, `[install-uv] Extracting zip to ${tmpExtractDir}...`)
      try {
        // Use tar (available on Windows 10+) which is faster and more reliable than PowerShell
        execSync(`tar -xf "${tmpZip}" -C "${tmpExtractDir}"`, {
          timeout: 60_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        // Fallback to PowerShell if tar is not available
        logger.info({ category: 'install' }, `[install-uv] tar failed, trying PowerShell...`)
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmpZip}' -DestinationPath '${tmpExtractDir}'"`,
          { timeout: 120_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      }
      try { const { rmSync } = await import('node:fs'); rmSync(tmpZip, { force: true }) } catch {}
    } else {
      // macOS/Linux: tar.gz archive
      const tmpTar = resolve(tmpdir(), `uv-install-${ts}.tar.gz`)
      writeFileSync(tmpTar, Buffer.from(archiveBuffer))
      logger.info({ category: 'install' }, `[install-uv] Extracting tar.gz to ${tmpExtractDir}...`)
      execSync(`tar -xzf "${tmpTar}" -C "${tmpExtractDir}"`, {
        timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
      })
      try { const { rmSync } = await import('node:fs'); rmSync(tmpTar, { force: true }) } catch {}
    }

    // Find uv binary in extracted directory (may be in a subfolder)
    const folderName = target.name.replace('.tar.gz', '').replace('.zip', '')
    const candidates = [
      resolve(tmpExtractDir, folderName, `uv${ext}`),
      resolve(tmpExtractDir, `uv${ext}`),
    ]
    let extractedUv: string | null = null
    for (const c of candidates) {
      if (existsSync(c)) { extractedUv = c; break }
    }
    if (!extractedUv) {
      const msg = `uv binary not found in extracted archive`
      logger.error({ category: 'install' }, `[install-uv] ${msg}`)
      return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
    }

    // Copy uv binary
    const { copyFileSync } = await import('node:fs')
    copyFileSync(extractedUv, uvPath)
    if (process.platform !== 'win32') {
      chmodSync(uvPath, 0o755)
    }
    logger.info({ category: 'install' }, `[install-uv] uv installed to ${uvPath}`)

    // Also copy uvx if present
    const extractedUvx = resolve(extractedUv, '..', `uvx${ext}`)
    if (existsSync(extractedUvx)) {
      copyFileSync(extractedUvx, uvxPath)
      if (process.platform !== 'win32') {
        chmodSync(uvxPath, 0o755)
      }
      logger.info({ category: 'install' }, `[install-uv] uvx installed to ${uvxPath}`)
    }

    // Clean up
    try {
      const { rmSync } = await import('node:fs')
      rmSync(tmpExtractDir, { recursive: true, force: true })
    } catch {}

    recordToolInManifest({ name: 'uv', version: UV_VERSION, dir: binDir, sha256: archiveSha256 })
    resetShellEnvCache()
    ensurePortableToolsInPath()

    const msg = `uv installed to ${uvPath} (from ${downloadSource})`
    logger.info({ category: 'install' }, `[install-uv] ${msg}`)
    return { ok: true, stdout: msg, stderr: '', exitCode: 0, installedTo: binDir }
  } catch (err: any) {
    const msg = err.message ?? String(err)
    logger.error({ category: 'install' }, `[install-uv] Install failed: ${msg}`)
    return { ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null }
  }
}

health.post('/install-tool', async (c) => {
  const body = await c.req.json()
  const parsed = installToolSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid parameters' }, 400)
  }

  const { tool } = parsed.data
  const isWindows = process.platform === 'win32'
  const isMac = process.platform === 'darwin'

  // Bun: download from CDN and extract
  if (tool === 'bun') {
    const result = await installBun()
    return c.json(result)
  }

  // uv: download from CDN and extract
  if (tool === 'uv') {
    const result = await installUv()
    return c.json(result)
  }

  // Python: install via uv (uv must be installed first)
  if (tool === 'python') {
    const logger = getLogger()
    const uvPath = which('uv')
    if (!uvPath) {
      const msg = 'uv is not installed. Please install uv first, then install Python.'
      logger.warn({ category: 'install' }, `[install-python] ${msg}`)
      return c.json({ ok: false, stdout: '', stderr: msg, exitCode: 1, installedTo: null })
    }
    // Portable mode: direct uv-managed Python into tools/<platformKey>/python/ on the USB drive
    const portable = isPortableMode()
    const pythonDir = portable ? getPortableToolInstallDir('python') : null
    logger.info({ category: 'install' }, `[install-python] Installing Python via uv${pythonDir ? ` into ${pythonDir}` : ''}...`)
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    try {
      stdout = execSync(`"${uvPath}" python install`, {
        encoding: 'utf-8',
        timeout: 300_000,
        windowsHide: true,
        env: pythonDir ? { ...getShellEnv(), UV_PYTHON_INSTALL_DIR: pythonDir } : getShellEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      logger.info({ category: 'install' }, `[install-python] Python installed successfully via uv`)
      if (pythonDir) {
        // uv 输出形如 "Installed Python 3.13.1 ..." 或 "cpython-3.13.1-..."；解析失败记 unknown
        const version = /(?:cpython-|Python )(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? 'unknown'
        recordToolInManifest({ name: 'python', version, dir: pythonDir })
      }
    } catch (err: any) {
      stdout = err.stdout ?? ''
      stderr = err.stderr ?? ''
      exitCode = err.status ?? 1
      logger.error({ category: 'install', exitCode, stderr }, `[install-python] Failed`)
    }
    resetShellEnvCache()
    ensurePortableToolsInPath()
    return c.json({ ok: exitCode === 0, stdout, stderr, exitCode, installedTo: exitCode === 0 ? pythonDir : null })
  }

  // Git on Windows: download from CDN and run silent install
  if (tool === 'git' && isWindows) {
    const result = await installGitWindows()
    return c.json(result)
  }

  // Git on macOS / Node.js on Windows: use platform commands
  let command: string | null = null
  switch (tool) {
    case 'git':
      if (isMac) {
        command = 'xcode-select --install'
      }
      break
    case 'node':
      if (isWindows) {
        command = 'winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --disable-interactivity'
      }
      break
  }

  if (!command) {
    const msg = `No install method available for "${tool}" on ${process.platform}`
    getLogger().warn({ category: 'install' }, `[install-${tool}] ${msg}`)
    return c.json({ error: msg }, 400)
  }

  const logger = getLogger()
  logger.info({ category: 'install', tool, command }, `[install-${tool}] Starting installation...`)

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    stdout = execSync(command, {
      encoding: 'utf-8',
      timeout: 300_000,
      windowsHide: true,
      env: getShellEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    logger.info({ category: 'install', tool, exitCode: 0 }, `[install-${tool}] Command completed successfully`)
  } catch (err: any) {
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
    exitCode = err.status ?? 1
    // xcode-select --install returns non-zero if CLT is already installed or dialog is shown
    if (tool === 'git' && isMac) {
      exitCode = 0
      logger.info({ category: 'install', tool }, `[install-${tool}] xcode-select dialog triggered`)
    } else {
      logger.error({ category: 'install', tool, exitCode, stderr }, `[install-${tool}] Command failed`)
    }
  }

  resetShellEnvCache()

  logger.info({ category: 'install', tool, ok: exitCode === 0 }, `[install-${tool}] Done (exitCode=${exitCode})`)
  // winget/xcode-select 属系统级安装，无法指向便携目录，installedTo 为 null
  return c.json({ ok: exitCode === 0, stdout, stderr, exitCode, installedTo: null })
})

export { health }
