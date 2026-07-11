import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// build-lock.ps1 guards release builds against concurrent runs. These tests pin
// the crash-recovery contract: an interrupted build (owner process gone) must be
// reclaimable on the next attempt, while a lock held by a live process stays put.
// PowerShell + Win32_Process are Windows-only, so the suite skips elsewhere.
const winTest = process.platform === 'win32' ? test : test.skip

const SCRIPT = resolve(process.cwd(), 'scripts', 'build-lock.ps1')

function runLock(action: 'acquire' | 'release', token: string, lockRoot: string) {
  return Bun.spawnSync(
    [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Action',
      action,
      '-Token',
      token,
      '-LockRoot',
      lockRoot,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
}

function lockPaths(lockRoot: string) {
  const dir = join(lockRoot, '.xjc-build-lock')
  return {
    dir,
    token: join(dir, 'token.txt'),
    createdAt: join(dir, 'created-at.txt'),
    ownerPid: join(dir, 'owner-pid.txt'),
    ownerStart: join(dir, 'owner-start.txt'),
  }
}

function readToken(lockRoot: string) {
  return readFileSync(lockPaths(lockRoot).token, 'utf8').trim()
}

describe('build lock', () => {
  winTest('fresh acquire records an owner pid and reuses on the same token', () => {
    const root = mkdtempSync(join(tmpdir(), 'xjc-lock-'))
    const p = lockPaths(root)
    try {
      const first = runLock('acquire', 'token-1', root)
      expect(first.exitCode).toBe(0)
      expect(existsSync(p.dir)).toBe(true)
      expect(readToken(root)).toBe('token-1')
      const pid = Number.parseInt(readFileSync(p.ownerPid, 'utf8').trim(), 10)
      expect(pid).toBeGreaterThan(0)

      // A nested build script reuses the caller's token instead of deadlocking.
      const reuse = runLock('acquire', 'token-1', root)
      expect(reuse.exitCode).toBe(0)
      expect(readToken(root)).toBe('token-1')

      const release = runLock('release', 'token-1', root)
      expect(release.exitCode).toBe(0)
      expect(existsSync(p.dir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  winTest('reclaims a lock whose owner process is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'xjc-lock-'))
    const p = lockPaths(root)
    try {
      mkdirSync(p.dir, { recursive: true })
      writeFileSync(p.token, 'dead-owner-token')
      writeFileSync(p.createdAt, new Date().toISOString())
      writeFileSync(p.ownerPid, '999999') // no such process
      writeFileSync(p.ownerStart, new Date().toISOString())

      const result = runLock('acquire', 'new-token', root)
      expect(result.exitCode).toBe(0)
      expect(readToken(root)).toBe('new-token')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  winTest('refuses a lock whose owner process is still alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'xjc-lock-'))
    const p = lockPaths(root)
    try {
      mkdirSync(p.dir, { recursive: true })
      writeFileSync(p.token, 'live-owner-token')
      writeFileSync(p.createdAt, new Date().toISOString())
      // This test runner is alive; without a recorded start time the script only
      // verifies the PID is running, which it is.
      writeFileSync(p.ownerPid, String(process.pid))

      const result = runLock('acquire', 'intruder-token', root)
      expect(result.exitCode).toBe(1)
      expect(readToken(root)).toBe('live-owner-token')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  winTest('refuses to release a lock owned by a different token', () => {
    const root = mkdtempSync(join(tmpdir(), 'xjc-lock-'))
    const p = lockPaths(root)
    try {
      const acquire = runLock('acquire', 'owner-token', root)
      expect(acquire.exitCode).toBe(0)

      const wrong = runLock('release', 'other-token', root)
      expect(wrong.exitCode).toBe(1)
      expect(existsSync(p.dir)).toBe(true)

      const right = runLock('release', 'owner-token', root)
      expect(right.exitCode).toBe(0)
      expect(existsSync(p.dir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
