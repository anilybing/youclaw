#!/usr/bin/env bun
// Run the deterministic browser smoke with an isolated desktop data directory.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const E2E_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(E2E_DIR, '..')
const PLAYWRIGHT_CLI = resolve(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
const dataDir = mkdtempSync(resolve(tmpdir(), 'xjc-e2e-release-'))

try {
  const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [
    PLAYWRIGHT_CLI,
    'test',
    '--config',
    resolve(E2E_DIR, 'playwright.config.ts'),
    '--project=release-smoke',
  ], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      CI: '1',
      XJC_E2E_RELEASE_SMOKE: '1',
      XJC_E2E_DATA_DIR: dataDir,
    },
  })

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code === null ? 1 : code))
  })
  process.exitCode = exitCode
} finally {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
