// [XJC-PATCH] Release artifact must never contain mutable user data.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const roots: string[] = []

function makeLayout(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'xiaojuclaw-layout-'))
  roots.push(root)
  const app = resolve(root, 'XiaoJuClaw')
  const tools = resolve(root, 'XiaoJuClawRuntime', 'tools')
  mkdirSync(app, { recursive: true })
  mkdirSync(tools, { recursive: true })
  for (const file of ['XiaoJuClaw.exe', 'XiaoJuClaw-server.exe', 'package.json']) {
    writeFileSync(resolve(app, file), file)
  }
  writeFileSync(resolve(app, 'portable-layout.json'), JSON.stringify({
    schemaVersion: 1,
    dataDir: '../XiaoJuClawData',
    runtimeDir: '../XiaoJuClawRuntime',
  }, null, 2))
  writeFileSync(resolve(tools, 'manifest.json'), '{}')
  writeFileSync(resolve(root, 'Start-XiaoJuClaw.bat'), '@echo off')
  writeFileSync(resolve(root, 'Migrate-Legacy-Layout.bat'), '@echo off')
  return root
}

function verify(root: string) {
  return Bun.spawnSync([
    process.execPath,
    resolve(import.meta.dir, '..', 'scripts', 'verify-portable-layout.mjs'),
    root,
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('portable release layout gate', () => {
  test('accepts separated program and runtime roots with no user data', () => {
    const result = verify(makeLayout())
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('[OK]')
  })

  test('rejects any packaged XiaoJuClawData directory', () => {
    const root = makeLayout()
    mkdirSync(resolve(root, 'XiaoJuClawData'), { recursive: true })
    writeFileSync(resolve(root, 'XiaoJuClawData', 'secrets.json'), '{"key":"must-not-ship"}')

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('must not contain user data directory')
  })

  test('rejects the legacy flat program layout', () => {
    const root = makeLayout()
    writeFileSync(resolve(root, 'XiaoJuClaw.exe'), 'legacy')

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('outside its owned root')
  })

  test('rejects any migration script that can delete user data', () => {
    const root = makeLayout()
    writeFileSync(
      resolve(root, 'Migrate-Legacy-Layout.bat'),
      'rmdir /s /q "%~dp0XiaoJuClawData"',
    )

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('destructive user-data command')
  })
})
