#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const webDir = resolve(root, 'web')
const isWindows = process.platform === 'win32'

const result = spawnSync('bun', ['run', 'build'], {
  cwd: webDir,
  shell: isWindows,
  stdio: 'inherit',
  env: process.env,
})

process.exit(result.status ?? 1)
