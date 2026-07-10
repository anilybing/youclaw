// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { resolve, dirname } from 'node:path'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { getEnv } from './env.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// After bun build --compile, __dirname is under a virtual FS
// macOS/Linux: /$bunfs/root/  Windows: B:\~BUN\root
const isBunCompiled = __dirname.includes('/$bunfs/') || __dirname.includes('~BUN')

// Dev mode: project root directory
export const ROOT_DIR = isBunCompiled
  ? process.cwd()
  : resolve(__dirname, '../..')

let _resolvedDataDir: string | null = null
let _resolvedWorkspaceRoot: string | null = null
let _resolvedRuntimeDir: string | null = null

export const PORTABLE_LAYOUT_FILE = 'portable-layout.json'
export const INSTALLED_LAYOUT_FILE = 'installed-layout.json'
const DATA_LAYOUT_MIGRATION_RECEIPT = '.data-layout-v1-migrated.json'

function getHomeDir(): string | null {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim()
  return home || null
}

export function expandHomeDir(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed

  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const home = getHomeDir()
    if (home) {
      return resolve(home, trimmed.slice(2))
    }
  }

  return trimmed
}

export function resolvePathInput(input: string, baseDir = process.cwd()): string {
  return resolve(baseDir, expandHomeDir(input))
}

export function getProductionDataDir(): string {
  const home = getHomeDir()
  if (!home) return resolve(tmpdir(), 'XiaoJuClaw-data')
  return resolve(home, '.XiaoJuClaw')
}

export function getLegacyProductionDataDir(): string {
  const home = getHomeDir()
  if (!home) return resolve(tmpdir(), 'XiaoJuClaw-data')

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || resolve(home, 'AppData', 'Roaming')
    return resolve(appData, 'com.xiaojuclaw.app')
  }

  if (process.platform === 'darwin') {
    return resolve(home, 'Library', 'Application Support', 'com.xiaojuclaw.app')
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || resolve(home, '.local', 'share')
  return resolve(xdgDataHome, 'com.xiaojuclaw.app')
}

// [XJC-PATCH] Older builds used the mixed-case identifier below. On case-sensitive
// filesystems (macOS/Linux) that maps to a different directory than the lowercase
// identifier, so it must join the migration candidates. Windows filesystems are
// case-insensitive — both spellings resolve to the same directory there, and adding
// the mixed-case path would risk a self-copy, so it is only added off-Windows.
const LEGACY_MIXED_CASE_IDENTIFIER = 'com.XiaoJuClaw.app'

export function getLegacyProductionDataDirs(): string[] {
  const dirs = [getLegacyProductionDataDir()]

  if (process.platform === 'win32') return dirs

  const home = getHomeDir()
  if (!home) return dirs

  if (process.platform === 'darwin') {
    dirs.push(resolve(home, 'Library', 'Application Support', LEGACY_MIXED_CASE_IDENTIFIER))
  } else {
    const xdgDataHome = process.env.XDG_DATA_HOME || resolve(home, '.local', 'share')
    dirs.push(resolve(xdgDataHome, LEGACY_MIXED_CASE_IDENTIFIER))
  }

  return dirs
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function directoryHasContent(dir: string): boolean {
  const pending = [dir]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)

    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          pending.push(resolve(current, entry.name))
        } else {
          // Files and symlinks both represent user-owned content. Do not follow
          // symlinks here: this is only an initialization probe.
          return true
        }
      }
    } catch {
      return true
    }
  }

  return false
}

function hasInitializedDataDir(dir: string): boolean {
  if (!existsSync(dir)) return false

  try {
    const stats = statSync(dir)
    if (!stats.isDirectory()) return true
    // Runtime-only directories may be pre-bundled in old portable packages and
    // are not proof of user data. Every other root file or non-empty directory
    // is user-owned and must prevent a migration from replacing the target.
    const runtimeOnlyEntries = new Set([
      'tools',
      'updates',
      'logs',
      'tmp',
      'doc-cache',
      'tool-cache',
    ])
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (runtimeOnlyEntries.has(entry.name)) continue
      if (!entry.isDirectory()) return true
      if (directoryHasContent(resolve(dir, entry.name))) return true
    }
    return false
  } catch {
    return false
  }
}

function copyDir(sourceDir: string, targetDir: string): void {
  if (existsSync(targetDir) && !hasInitializedDataDir(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }

  mkdirSync(dirname(targetDir), { recursive: true })
  cpSync(sourceDir, targetDir, { recursive: true })
}

function copyMissingEntries(source: string, target: string): void {
  const stats = lstatSync(source)
  if (!stats.isDirectory()) {
    if (!existsSync(target)) cpSync(source, target)
    return
  }

  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source)) {
    copyMissingEntries(resolve(source, entry), resolve(target, entry))
  }
}

function mergeJsonObjectFile(source: string, target: string): void {
  if (!existsSync(source) || !existsSync(target)) return
  try {
    const sourceValue = JSON.parse(readFileSync(source, 'utf8')) as unknown
    const targetValue = JSON.parse(readFileSync(target, 'utf8')) as unknown
    if (
      typeof sourceValue !== 'object' || sourceValue === null || Array.isArray(sourceValue)
      || typeof targetValue !== 'object' || targetValue === null || Array.isArray(targetValue)
    ) {
      return
    }
    // Existing target values win, while missing legacy secrets/settings are retained.
    const merged = {
      ...(sourceValue as Record<string, unknown>),
      ...(targetValue as Record<string, unknown>),
    }
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  } catch {
    // Never replace either file when one side is malformed.
  }
}

export function resolveProductionDataDir(): string {
  const targetDir = getProductionDataDir()

  if (hasInitializedDataDir(targetDir)) {
    return targetDir
  }

  for (const legacyDir of getLegacyProductionDataDirs()) {
    if (legacyDir === targetDir || !existsSync(legacyDir)) continue

    try {
      mkdirSync(dirname(targetDir), { recursive: true })
      copyDir(legacyDir, targetDir)
      console.info(`[DATA_DIR] Migrated legacy data directory to ${targetDir}`)
      return targetDir
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[DATA_DIR] Failed to migrate legacy data directory to ${targetDir}: ${message}`)
      return legacyDir
    }
  }

  return targetDir
}

function resolveExplicitDataDir(targetDir: string): string {
  const injectedLegacyDir = process.env.XiaoJuClaw_LEGACY_DATA_DIR?.trim()
  if (injectedLegacyDir) {
    const sourceDir = resolvePathInput(injectedLegacyDir)
    // An existing target database is authoritative. Otherwise merge the
    // precise Tauri-detected legacy tree without replacing target-owned files;
    // AppData may already contain window-state/log plugin files.
    if (
      !samePath(sourceDir, targetDir)
      && !existsSync(resolve(targetDir, 'XiaoJuClaw.db'))
      && !existsSync(resolve(targetDir, DATA_LAYOUT_MIGRATION_RECEIPT))
      && hasInitializedDataDir(sourceDir)
    ) {
      try {
        copyMissingEntries(sourceDir, targetDir)
        mergeJsonObjectFile(resolve(sourceDir, 'settings.json'), resolve(targetDir, 'settings.json'))
        mergeJsonObjectFile(resolve(sourceDir, 'secrets.json'), resolve(targetDir, 'secrets.json'))
        writeFileSync(
          resolve(targetDir, DATA_LAYOUT_MIGRATION_RECEIPT),
          `${JSON.stringify({
            schemaVersion: 1,
            source: sourceDir,
            migratedAt: new Date().toISOString(),
          }, null, 2)}\n`,
          'utf8',
        )
        console.info(`[DATA_DIR] Migrated existing data directory to ${targetDir}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[DATA_DIR] Failed to migrate existing data directory to ${targetDir}: ${message}`)
      }
    }
    return targetDir
  }

  // An explicit DATA_DIR is often a test sandbox or a user-selected portable
  // location. Never import unrelated machine data into it implicitly.
  if (hasInitializedDataDir(targetDir)) {
    return targetDir
  }

  return targetDir
}

function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = resolve(dir, `.XiaoJuClaw-write-test-${process.pid}-${Date.now()}`)
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function resolveDataDir(envDataDir: string): string {
  if (_resolvedDataDir) return _resolvedDataDir

  const explicitDataDir = process.env.DATA_DIR?.trim()
  const candidates: string[] = []
  if (explicitDataDir) {
    candidates.push(resolveExplicitDataDir(resolvePathInput(explicitDataDir)))
  }
  if (isBunCompiled && !explicitDataDir) {
    candidates.push(resolveProductionDataDir())
  }
  candidates.push(resolvePathInput(envDataDir, ROOT_DIR))
  candidates.push(resolve(tmpdir(), 'XiaoJuClaw-data'))

  const visited = new Set<string>()
  for (const candidate of candidates) {
    if (visited.has(candidate)) continue
    visited.add(candidate)
    if (isWritableDir(candidate)) {
      _resolvedDataDir = candidate
      return candidate
    }
  }

  const fallback = resolve(tmpdir(), 'XiaoJuClaw-data')
  _resolvedDataDir = fallback
  return fallback
}

function resolveWorkspaceRoot(dataDir: string): string {
  if (_resolvedWorkspaceRoot) return _resolvedWorkspaceRoot

  const candidates: string[] = []
  if (process.env.WORKSPACE_DIR?.trim()) {
    candidates.push(resolvePathInput(process.env.WORKSPACE_DIR))
  }
  candidates.push(resolve(dataDir, 'workspace'))

  const visited = new Set<string>()
  for (const candidate of candidates) {
    if (visited.has(candidate)) continue
    visited.add(candidate)
    if (isWritableDir(candidate)) {
      _resolvedWorkspaceRoot = candidate
      return candidate
    }
  }

  const fallback = resolve(dataDir, 'workspace')
  _resolvedWorkspaceRoot = fallback
  return fallback
}

function resolveRuntimeRoot(dataDir: string): string {
  if (_resolvedRuntimeDir) return _resolvedRuntimeDir

  const explicitRuntimeDir = process.env.XiaoJuClaw_RUNTIME_DIR?.trim()
  _resolvedRuntimeDir = explicitRuntimeDir
    ? resolvePathInput(explicitRuntimeDir)
    : dataDir
  return _resolvedRuntimeDir
}

export function resetPathsCache(): void {
  _resolvedDataDir = null
  _resolvedWorkspaceRoot = null
  _resolvedRuntimeDir = null
}

export function getPaths() {
  const env = getEnv()

  // DATA_DIR: writable data directory (database, logs, browser profiles, etc.)
  const dataDir = resolveDataDir(env.DATA_DIR)
  const workspaceRoot = resolveWorkspaceRoot(dataDir)
  // RUNTIME_DIR: replaceable tools. Portable builds inject a sibling
  // XiaoJuClawRuntime directory; installed/dev builds keep the legacy data/tools
  // location until their tool installer is migrated independently.
  const runtimeRoot = resolveRuntimeRoot(dataDir)
  const toolsRoot = resolve(runtimeRoot, 'tools')
  const legacyToolsRoot = samePath(runtimeRoot, dataDir)
    ? null
    : resolve(dataDir, 'tools')

  // RESOURCES_DIR: read-only resource directory from Tauri bundle (skills/prompts and bundled tooling)
  // In dev mode, falls back to project root
  const resourcesDir = process.env.RESOURCES_DIR
    ? resolvePathInput(process.env.RESOURCES_DIR)
    : ROOT_DIR

  // Agent workspaces live under the user workspace root, independent from repo checkout.
  const agentsDir = resolve(workspaceRoot, 'agents')

  return {
    root: ROOT_DIR,
    data: dataDir,
    runtime: runtimeRoot,
    tools: toolsRoot,
    legacyTools: legacyToolsRoot,
    workspace: workspaceRoot,
    db: resolve(dataDir, 'XiaoJuClaw.db'),
    agents: agentsDir,
    skills: resolveResourceSubdir(resourcesDir, isBunCompiled, 'skills'),
    prompts: resolveResourceSubdir(resourcesDir, isBunCompiled, 'prompts'),
    browserProfiles: resolve(dataDir, 'browser-profiles'),
    logs: resolve(dataDir, 'logs'),
    userSkills: resolve(dataDir, 'skills'),
  }
}

// ---------------------------------------------------------------------------
// [XJC-PATCH] T-E3 便携模式判定（仅新增导出，不改动上方既有解析逻辑）
// ---------------------------------------------------------------------------

/**
 * 是否运行在便携（U 盘）模式。
 *
 * 新包由 portable-layout.json 显式标记，Tauri 还会注入
 * XiaoJuClaw_PORTABLE=1。旧 USB 包没有标记，继续以 EXE 同级 XiaoJuClawData
 * 作为一次性兼容信号；NSIS marker/uninstaller 优先。禁止再用“EXE 目录可写”推断：NSIS 用户级安装目录同样可写，
 * 会把安装版误判成便携版并把用户数据放进程序目录。
 *
 * XJC_FORCE_PORTABLE=1 为测试后门：dev/测试环境无法模拟"EXE 同级数据目录"，
 * 冒烟与单测用它强制走便携分支（生产构建不会设置该变量）。
 */
export function isPortableMode(): boolean {
  if (process.env.XJC_FORCE_PORTABLE === '1') return true
  if (process.env.XiaoJuClaw_PORTABLE === '1') return true
  if (process.env.XiaoJuClaw_PORTABLE === '0') return false
  try {
    const exeDir = dirname(process.execPath)
    if (
      existsSync(resolve(exeDir, INSTALLED_LAYOUT_FILE))
      || existsSync(resolve(exeDir, 'uninstall.exe'))
      || existsSync(resolve(exeDir, 'unins000.exe'))
    ) {
      return false
    }
    if (existsSync(resolve(exeDir, PORTABLE_LAYOUT_FILE))) return true
    return existsSync(resolve(exeDir, 'XiaoJuClawData'))
  } catch {
    // getPaths() 依赖 loadEnv()；启动极早期未初始化时按非便携处理
    return false
  }
}

/**
 * Resolve a resource subdirectory with fallback for Tauri bundled paths.
 * Tauri 2 converts ../ to _up_/ when bundling resources.
 */
function resolveResourceSubdir(resourcesDir: string, isBunCompiled: boolean, name: string): string {
  if (!isBunCompiled) return resolve(resourcesDir, name)

  // Tauri 2 converts ../ to _up_/ when bundling
  const primary = resolve(resourcesDir, '_up_', name)
  if (existsSync(primary)) return primary

  // Fallback: direct path (in case Tauri strips the ../ prefix)
  const fallback = resolve(resourcesDir, name)
  if (existsSync(fallback)) return fallback

  // Return primary path as default
  return primary
}
