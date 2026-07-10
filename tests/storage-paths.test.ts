// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup.ts'
import {
  getLegacyProductionDataDir,
  getPaths,
  getProductionDataDir,
  resetPathsCache,
  resolveProductionDataDir,
} from '../src/config/index.ts'
import { getLegacyProductionDataDirs } from '../src/config/paths.ts'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  XiaoJuClaw_RUNTIME_DIR: process.env.XiaoJuClaw_RUNTIME_DIR,
  XiaoJuClaw_LEGACY_DATA_DIR: process.env.XiaoJuClaw_LEGACY_DATA_DIR,
  APPDATA: process.env.APPDATA,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
}

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function configurePathEnv(): { dataDir: string; homeDir: string } {
  const homeDir = makeTempDir('XiaoJuClaw-home-')
  const dataDir = resolve(makeTempDir('XiaoJuClaw-data-'), 'com.xiaojuclaw.app')
  process.env.HOME = homeDir
  delete process.env.USERPROFILE
  process.env.DATA_DIR = dataDir
  delete process.env.WORKSPACE_DIR
  delete process.env.XiaoJuClaw_RUNTIME_DIR
  delete process.env.XiaoJuClaw_LEGACY_DATA_DIR
  resetPathsCache()
  return { dataDir, homeDir }
}

describe('storage paths', () => {
  beforeEach(() => {
    resetPathsCache()
  })

  afterEach(() => {
    // 注意：process.env.X = undefined 会写成字符串 "undefined"（Node/Bun 语义），
    // 后续 getPaths() 会把它当相对路径在仓库根创建 undefined/ 目录——必须 delete。
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetPathsCache()

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stores workspace and user skills under the resolved data directory', () => {
    const { dataDir } = configurePathEnv()

    const paths = getPaths()

    expect(paths.data).toBe(dataDir)
    expect(paths.workspace).toBe(resolve(dataDir, 'workspace'))
    expect(paths.agents).toBe(resolve(dataDir, 'workspace', 'agents'))
    expect(paths.userSkills).toBe(resolve(dataDir, 'skills'))
    expect(paths.runtime).toBe(dataDir)
    expect(paths.tools).toBe(resolve(dataDir, 'tools'))
    expect(paths.legacyTools).toBeNull()
  })

  test('separates replaceable runtime tools from user data when injected by Tauri', () => {
    const { dataDir } = configurePathEnv()
    const runtimeDir = resolve(makeTempDir('XiaoJuClaw-runtime-'), 'XiaoJuClawRuntime')
    process.env.XiaoJuClaw_RUNTIME_DIR = runtimeDir
    resetPathsCache()

    const paths = getPaths()

    expect(paths.data).toBe(dataDir)
    expect(paths.runtime).toBe(runtimeDir)
    expect(paths.tools).toBe(resolve(runtimeDir, 'tools'))
    expect(paths.legacyTools).toBe(resolve(dataDir, 'tools'))
  })

  test('copies a legacy installed data tree into the explicit AppData target without deleting the source', () => {
    const homeDir = makeTempDir('XiaoJuClaw-home-')
    const targetDir = resolve(makeTempDir('XiaoJuClaw-target-'), 'com.xiaojuclaw.app')
    const legacyDir = resolve(makeTempDir('XiaoJuClaw-legacy-'), 'XiaoJuClawData')
    process.env.HOME = homeDir
    delete process.env.USERPROFILE
    process.env.DATA_DIR = targetDir
    process.env.XiaoJuClaw_LEGACY_DATA_DIR = legacyDir
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(resolve(legacyDir, 'workspace', 'agents', 'default'), { recursive: true })
    writeFileSync(resolve(targetDir, 'settings.json'), '{"owner":"target","shared":"target"}', 'utf-8')
    writeFileSync(resolve(legacyDir, 'settings.json'), '{"theme":"dark","shared":"legacy"}', 'utf-8')
    writeFileSync(resolve(legacyDir, 'XiaoJuClaw.db'), 'legacy-db', 'utf-8')
    writeFileSync(resolve(legacyDir, 'workspace', 'agents', 'default', 'MEMORY.md'), 'keep me', 'utf-8')
    resetPathsCache()

    const paths = getPaths()

    expect(paths.data).toBe(targetDir)
    const settings = JSON.parse(readFileSync(resolve(targetDir, 'settings.json'), 'utf-8')) as Record<string, string>
    expect(settings).toEqual({ theme: 'dark', shared: 'target', owner: 'target' })
    expect(readFileSync(resolve(targetDir, 'XiaoJuClaw.db'), 'utf-8')).toBe('legacy-db')
    expect(readFileSync(resolve(targetDir, 'workspace', 'agents', 'default', 'MEMORY.md'), 'utf-8')).toBe('keep me')
    expect(existsSync(resolve(targetDir, '.data-layout-v1-migrated.json'))).toBe(true)
    expect(existsSync(resolve(legacyDir, 'settings.json'))).toBe(true)
  })

  test('never replaces an initialized target with an injected legacy directory', () => {
    const targetDir = resolve(makeTempDir('XiaoJuClaw-target-'), 'data')
    const legacyDir = resolve(makeTempDir('XiaoJuClaw-legacy-'), 'data')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(resolve(targetDir, 'settings.json'), '{"owner":"target"}', 'utf-8')
    writeFileSync(resolve(legacyDir, 'settings.json'), '{"owner":"legacy"}', 'utf-8')
    process.env.DATA_DIR = targetDir
    process.env.XiaoJuClaw_LEGACY_DATA_DIR = legacyDir
    resetPathsCache()

    expect(getPaths().data).toBe(targetDir)
    expect(readFileSync(resolve(targetDir, 'settings.json'), 'utf-8')).toContain('target')
  })

  test('treats an existing target database as authoritative during legacy migration', () => {
    const targetDir = resolve(makeTempDir('XiaoJuClaw-target-'), 'data')
    const legacyDir = resolve(makeTempDir('XiaoJuClaw-legacy-'), 'data')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(resolve(targetDir, 'XiaoJuClaw.db'), 'target-db', 'utf-8')
    writeFileSync(resolve(legacyDir, 'XiaoJuClaw.db'), 'legacy-db', 'utf-8')
    process.env.DATA_DIR = targetDir
    process.env.XiaoJuClaw_LEGACY_DATA_DIR = legacyDir
    resetPathsCache()

    expect(getPaths().data).toBe(targetDir)
    expect(readFileSync(resolve(targetDir, 'XiaoJuClaw.db'), 'utf-8')).toBe('target-db')
    expect(existsSync(resolve(targetDir, '.data-layout-v1-migrated.json'))).toBe(false)
  })

  test('expands ~ in an explicit DATA_DIR', () => {
    const homeDir = makeTempDir('XiaoJuClaw-home-')
    process.env.HOME = homeDir
    delete process.env.USERPROFILE
    process.env.DATA_DIR = '~/.XiaoJuClaw-dev'
    resetPathsCache()

    const paths = getPaths()

    expect(paths.data).toBe(resolve(homeDir, '.XiaoJuClaw-dev'))
  })

  test('uses ~/.XiaoJuClaw as the production data directory', () => {
    const homeDir = makeTempDir('XiaoJuClaw-home-')
    process.env.HOME = homeDir
    delete process.env.USERPROFILE

    expect(getProductionDataDir()).toBe(resolve(homeDir, '.XiaoJuClaw'))
  })

  test('migrates the legacy production data directory into ~/.XiaoJuClaw', () => {
    const homeDir = makeTempDir('XiaoJuClaw-home-')
    process.env.HOME = homeDir
    delete process.env.USERPROFILE
    delete process.env.DATA_DIR
    process.env.APPDATA = resolve(homeDir, 'AppData', 'Roaming')
    process.env.XDG_DATA_HOME = resolve(homeDir, '.local', 'share')

    const legacyDir = getLegacyProductionDataDir()
    const targetDir = getProductionDataDir()
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(resolve(legacyDir, 'sample.txt'), 'migrated', 'utf-8')
    resetPathsCache()

    const resolvedDir = resolveProductionDataDir()

    expect(resolvedDir).toBe(targetDir)
    expect(readFileSync(resolve(targetDir, 'sample.txt'), 'utf-8')).toBe('migrated')
    // Migration copies (not moves) the legacy directory, so the source stays intact.
    expect(existsSync(legacyDir)).toBe(true)
  })

  test('offers the mixed-case legacy directory as a migration candidate on case-sensitive platforms', () => {
    const homeDir = makeTempDir('XiaoJuClaw-home-')
    process.env.HOME = homeDir
    delete process.env.USERPROFILE
    delete process.env.DATA_DIR
    process.env.XDG_DATA_HOME = resolve(homeDir, '.local', 'share')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const candidates = getLegacyProductionDataDirs()
      expect(candidates).toContain(resolve(homeDir, '.local', 'share', 'com.xiaojuclaw.app'))
      expect(candidates).toContain(resolve(homeDir, '.local', 'share', 'com.XiaoJuClaw.app'))
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  test('keeps the legacy candidate list free of mixed-case duplicates on Windows', () => {
    const homeDir = makeTempDir('XiaoJuClaw-home-')
    process.env.HOME = homeDir
    delete process.env.USERPROFILE
    process.env.APPDATA = resolve(homeDir, 'AppData', 'Roaming')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const candidates = getLegacyProductionDataDirs()
      expect(candidates).toEqual([resolve(homeDir, 'AppData', 'Roaming', 'com.xiaojuclaw.app')])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
