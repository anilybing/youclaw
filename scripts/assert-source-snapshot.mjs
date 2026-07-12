#!/usr/bin/env bun
// [XJC] Bind a release gate and all subsequent artifacts to one clean commit.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

// [XJC] Resolve git to an absolute path once. A bare "git" passed to Bun.spawnSync
// with a switched cwd (e.g. capturing the root repo from build-production.bat via a
// cmd for /f child) can fail to resolve on Windows (uv_spawn ENOENT); an absolute
// path is cwd-independent. build-usb.bat only captures the desktop repo itself so it never hit this.
const GIT_BIN = Bun.which('git') ?? 'git'

function git(args, root = repoRoot) {
  const result = Bun.spawnSync([GIT_BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(' ')} failed`)
  }
  return result.stdout.toString().trim()
}

export function captureCleanSourceSnapshot(root = repoRoot) {
  const status = Bun.spawnSync([GIT_BIN, 'status', '--porcelain'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (status.exitCode !== 0) throw new Error('Could not determine source working-tree state')
  if (status.stdout.toString().trim()) {
    throw new Error('Release source must be clean before the quality gate starts')
  }
  const commit = Bun.spawnSync([GIT_BIN, 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (commit.exitCode !== 0) throw new Error('Could not resolve release source commit')
  return commit.stdout.toString().trim()
}

export function assertSourceSnapshot(expectedCommit, root = repoRoot) {
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error('Expected source commit must be a full 40-character git SHA')
  }
  const actualCommit = git(['rev-parse', 'HEAD'], root)
  if (actualCommit !== expectedCommit) {
    throw new Error(`Source commit changed during build: expected ${expectedCommit}, got ${actualCommit}`)
  }
  const status = Bun.spawnSync([GIT_BIN, 'status', '--porcelain'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (status.exitCode !== 0 || status.stdout.toString().trim()) {
    throw new Error('Source working tree changed during build')
  }
  return actualCommit
}

if (import.meta.main) {
  const [command = 'capture', value, repoArg] = process.argv.slice(2)
  try {
    if (command === 'capture') {
      console.log(captureCleanSourceSnapshot(value ? resolve(value) : repoRoot))
    } else if (command === 'verify' && value) {
      console.log(assertSourceSnapshot(value, repoArg ? resolve(repoArg) : repoRoot))
    } else {
      throw new Error('Usage: bun scripts/assert-source-snapshot.mjs capture [repo] | verify <full-commit> [repo]')
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
