#!/usr/bin/env bun

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const webDir = resolve(root, 'web')
const sidecarPath = resolve(root, 'src-tauri', 'bin', 'XiaoJuClaw-server-x86_64-pc-windows-msvc.exe')
const isWindows = process.platform === 'win32'

function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    shell: isWindows,
    stdio: 'inherit',
    env: process.env,
  })
  return child
}

function ensureSidecar() {
  if (!isWindows || existsSync(sidecarPath)) return

  const result = spawnSync('bun', ['scripts/build-sidecar.mjs'], {
    cwd: root,
    shell: isWindows,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

ensureSidecar()

const children = [
  run('bun', ['run', 'dev'], webDir),
  run('bun', ['run', 'src/index.ts'], root),
]

let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill(isWindows ? undefined : 'SIGTERM')
  }
  setTimeout(() => process.exit(code), 300)
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!shuttingDown && code && code !== 0) shutdown(code)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => {
  for (const child of children) {
    if (!child.killed) child.kill()
  }
})
