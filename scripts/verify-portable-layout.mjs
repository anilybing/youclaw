#!/usr/bin/env bun
// [XJC-PATCH] Release gate for immutable program/runtime vs user data separation.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const EXPECTED_LAYOUT = {
  schemaVersion: 1,
  dataDir: '../XiaoJuClawData',
  runtimeDir: '../XiaoJuClawRuntime',
}

export function verifyPortableLayout(rootArg) {
  const root = resolve(rootArg)
  const appDir = resolve(root, 'XiaoJuClaw')
  const runtimeDir = resolve(root, 'XiaoJuClawRuntime')
  const dataDir = resolve(root, 'XiaoJuClawData')
  const errors = []

  const requiredFiles = [
    resolve(appDir, 'XiaoJuClaw.exe'),
    resolve(appDir, 'XiaoJuClaw-server.exe'),
    resolve(appDir, 'package.json'),
    resolve(appDir, 'portable-layout.json'),
    resolve(runtimeDir, 'tools', 'manifest.json'),
    resolve(root, 'Start-XiaoJuClaw.bat'),
    resolve(root, 'Migrate-Legacy-Layout.bat'),
  ]
  for (const file of requiredFiles) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      errors.push(`missing required file: ${file}`)
    }
  }

  // User data is created only at runtime. Its presence in a release artifact
  // proves that staging was run/polluted and must fail the build.
  if (existsSync(dataDir)) {
    errors.push(`release artifact must not contain user data directory: ${dataDir}`)
  }

  for (const legacyProgramFile of [
    resolve(root, 'XiaoJuClaw.exe'),
    resolve(root, 'XiaoJuClaw-server.exe'),
    resolve(root, 'settings.json'),
    resolve(root, 'secrets.json'),
    resolve(root, 'XiaoJuClaw.db'),
    resolve(appDir, 'settings.json'),
    resolve(appDir, 'secrets.json'),
    resolve(appDir, 'XiaoJuClaw.db'),
    resolve(appDir, 'installed-layout.json'),
  ]) {
    if (existsSync(legacyProgramFile)) {
      errors.push(`mutable or legacy file is outside its owned root: ${legacyProgramFile}`)
    }
  }

  const markerPath = resolve(appDir, 'portable-layout.json')
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''))
      if (JSON.stringify(marker) !== JSON.stringify(EXPECTED_LAYOUT)) {
        errors.push(`invalid portable layout marker: ${markerPath}`)
      }
    } catch (error) {
      errors.push(`unreadable portable layout marker: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const migratorPath = resolve(root, 'Migrate-Legacy-Layout.bat')
  if (existsSync(migratorPath)) {
    const migrator = readFileSync(migratorPath, 'utf8')
    if (/\b(?:del|erase|move|rd|rmdir)\b[^\r\n]*XiaoJuClawData/i.test(migrator)) {
      errors.push(`legacy migrator contains a destructive user-data command: ${migratorPath}`)
    }
  }

  return { root, errors }
}

if (import.meta.main) {
  const rootArg = process.argv[2]
  if (!rootArg) {
    console.error('Usage: bun scripts/verify-portable-layout.mjs <portable-root>')
    process.exit(2)
  }

  const result = verifyPortableLayout(rootArg)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[FAIL] ${error}`)
    process.exit(1)
  }
  console.log(`[OK] Portable layout keeps program, runtime, and user data separate: ${result.root}`)
}
