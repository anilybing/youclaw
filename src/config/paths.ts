import { resolve, dirname } from 'node:path'
import {
  cpSync,
  existsSync,
  mkdirSync,
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
    return resolve(appData, 'com.XiaoJuClaw.app')
  }

  if (process.platform === 'darwin') {
    return resolve(home, 'Library', 'Application Support', 'com.XiaoJuClaw.app')
  }

  const xdgDataHome = process.env.XDG_DATA_HOME || resolve(home, '.local', 'share')
  return resolve(xdgDataHome, 'com.XiaoJuClaw.app')
}

function hasInitializedDataDir(dir: string): boolean {
  if (!existsSync(dir)) return false

  try {
    const stats = statSync(dir)
    if (!stats.isDirectory()) return true
    // Check for the database file as proof of actual data initialization.
    // A directory with only leftover subdirectories (workspace/, skills/) from
    // older versions should NOT be considered initialized — otherwise the
    // migration from the legacy data dir would be incorrectly skipped.
    return existsSync(resolve(dir, 'XiaoJuClaw.db'))
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

export function resolveProductionDataDir(): string {
  const targetDir = getProductionDataDir()
  const legacyDir = getLegacyProductionDataDir()

  if (legacyDir === targetDir || !existsSync(legacyDir)) {
    return targetDir
  }

  if (hasInitializedDataDir(targetDir)) {
    return targetDir
  }

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

function resolveExplicitDataDir(targetDir: string): string {
  if (hasInitializedDataDir(targetDir)) {
    return targetDir
  }

  const sources = [
    resolveProductionDataDir(),
    getLegacyProductionDataDir(),
  ]
  const visited = new Set<string>()

  for (const sourceDir of sources) {
    if (sourceDir === targetDir || visited.has(sourceDir)) continue
    visited.add(sourceDir)
    if (!hasInitializedDataDir(sourceDir)) continue

    try {
      copyDir(sourceDir, targetDir)
      console.info(`[DATA_DIR] Migrated existing data directory to ${targetDir}`)
      return targetDir
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[DATA_DIR] Failed to migrate existing data directory to ${targetDir}: ${message}`)
    }
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

export function resetPathsCache(): void {
  _resolvedDataDir = null
  _resolvedWorkspaceRoot = null
}

export function getPaths() {
  const env = getEnv()

  // DATA_DIR: writable data directory (database, logs, browser profiles, etc.)
  const dataDir = resolveDataDir(env.DATA_DIR)
  const workspaceRoot = resolveWorkspaceRoot(dataDir)

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
