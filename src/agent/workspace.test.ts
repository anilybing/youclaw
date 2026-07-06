import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureAgentWorkspace, WORKSPACE_STATE_PATH_SEGMENTS } from './workspace.ts'

const tempDirs: string[] = []

function makeTempWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function readWorkspaceState(dir: string): {
  version: number
  bootstrapSeededAt?: string
  setupCompletedAt?: string
} {
  return JSON.parse(readFileSync(resolve(dir, ...WORKSPACE_STATE_PATH_SEGMENTS), 'utf-8')) as {
    version: number
    bootstrapSeededAt?: string
    setupCompletedAt?: string
  }
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

describe('ensureAgentWorkspace', () => {
  test('creates BOOTSTRAP.md for a brand new workspace and records seeded state', () => {
    const dir = makeTempWorkspace('XiaoJuClaw-workspace-')

    const result = ensureAgentWorkspace(dir, { ensureBootstrap: true })

    expect(result.bootstrapPending).toBe(true)
    expect(existsSync(resolve(dir, 'BOOTSTRAP.md'))).toBe(true)
    const state = readWorkspaceState(dir)
    expect(typeof state.bootstrapSeededAt).toBe('string')
    expect(state.setupCompletedAt).toBeUndefined()
  })

  test('marks setup completed after BOOTSTRAP.md is removed and does not recreate it', () => {
    const dir = makeTempWorkspace('XiaoJuClaw-workspace-')
    ensureAgentWorkspace(dir, { ensureBootstrap: true })
    unlinkSync(resolve(dir, 'BOOTSTRAP.md'))

    const result = ensureAgentWorkspace(dir, { ensureBootstrap: true })

    expect(result.bootstrapPending).toBe(false)
    expect(existsSync(resolve(dir, 'BOOTSTRAP.md'))).toBe(false)
    const state = readWorkspaceState(dir)
    expect(typeof state.bootstrapSeededAt).toBe('string')
    expect(typeof state.setupCompletedAt).toBe('string')
  })
})
