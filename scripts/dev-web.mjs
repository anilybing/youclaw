#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const webDir = resolve(root, 'web')
const isWindows = process.platform === 'win32'

const child = spawn('bun', ['run', 'dev'], {
  cwd: webDir,
  shell: isWindows,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => process.exit(code ?? 0))
