import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup.ts'
import { resetPathsCache } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { SkillsLoader, SkillsWatcher, resetSkillsSnapshotVersion } from '../src/skills/index.ts'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  RESOURCES_DIR: process.env.RESOURCES_DIR,
}

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('SkillsWatcher', () => {
  beforeEach(() => {
    resetPathsCache()
    resetSkillsSnapshotVersion()
    initLogger()
  })

  afterEach(() => {
    // 注意：process.env.X = undefined 会写成字符串 "undefined"（Node/Bun 语义），
    // 后续 getPaths() 会把它当相对路径在仓库根创建 undefined/ 目录——必须 delete。
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetPathsCache()
    resetSkillsSnapshotVersion()

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('creates writable roots before watching so later-added skills are observable', () => {
    const root = makeTempDir('XiaoJuClaw-skills-watcher-')
    process.env.DATA_DIR = resolve(root, 'data')
    process.env.WORKSPACE_DIR = resolve(root, 'workspace')
    process.env.RESOURCES_DIR = resolve(root, 'resources')
    resetPathsCache()

    const watcher = new SkillsWatcher(new SkillsLoader())

    expect(existsSync(resolve(root, 'data', 'skills'))).toBe(false)
    expect(existsSync(resolve(root, 'workspace', 'agents'))).toBe(false)

    watcher.start()

    expect(existsSync(resolve(root, 'data', 'skills'))).toBe(true)
    expect(existsSync(resolve(root, 'workspace', 'agents'))).toBe(true)

    watcher.stop()
  })
})
