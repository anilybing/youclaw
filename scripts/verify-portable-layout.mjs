#!/usr/bin/env bun
// [XJC-PATCH] Release gate for immutable program/runtime vs user data separation.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const EXPECTED_LAYOUT = {
  schemaVersion: 1,
  dataDir: '../XiaoJuClawData',
  runtimeDir: '../XiaoJuClawRuntime',
}

const GUIDE_SCREENSHOTS = [
  '01-login.png',
  '02-today.png',
  '03-models.png',
  '04-workbench.png',
  '05-chat.png',
  '06-agents.png',
  '07-knowledge.png',
  '08-workflows.png',
  '09-tasks-create.png',
  '10-channels.png',
  '11-media.png',
  '12-skills.png',
  '13-memory.png',
  '14-fulfillment.png',
  '15-logs.png',
  '16-activation.png',
]
const REQUIRED_PORTABLE_TOOLS = [
  { name: 'bun', dir: 'win-x64/bun', file: 'win-x64/bun/bun.exe' },
  { name: 'git', dir: 'win-x64/git', file: 'win-x64/git/cmd/git.exe' },
  { name: 'uv', dir: 'win-x64/uv', file: 'win-x64/uv/uv.exe' },
  { name: 'python', dir: 'win-x64/python', file: 'win-x64/python/python.exe' },
]

export function verifyPortableLayout(rootArg) {
  const root = resolve(rootArg)
  const appDir = resolve(root, 'XiaoJuClaw')
  const runtimeDir = resolve(root, 'XiaoJuClawRuntime')
  const dataDir = resolve(root, 'XiaoJuClawData')
  const guideDir = resolve(root, 'XiaoJuClaw-User-Guide')
  const errors = []

  const requiredFiles = [
    resolve(appDir, 'XiaoJuClaw.exe'),
    resolve(appDir, 'XiaoJuClaw-server.exe'),
    resolve(appDir, 'package.json'),
    resolve(appDir, 'portable-layout.json'),
    resolve(runtimeDir, 'tools', 'manifest.json'),
    ...REQUIRED_PORTABLE_TOOLS.map((tool) => resolve(runtimeDir, 'tools', tool.file)),
    resolve(root, 'Start-XiaoJuClaw.bat'),
    resolve(root, 'Migrate-Legacy-Layout.bat'),
    resolve(guideDir, 'index.html'),
    ...GUIDE_SCREENSHOTS.map((name) => resolve(guideDir, 'assets', 'ui', name)),
  ]
  for (const file of requiredFiles) {
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size <= 0) {
      errors.push(`missing required file: ${file}`)
    }
  }
  for (const tool of REQUIRED_PORTABLE_TOOLS) {
    const path = resolve(runtimeDir, 'tools', tool.file)
    if (!existsSync(path)) continue
    try {
      const info = statSync(path)
      const header = readFileSync(path).subarray(0, 2).toString('ascii')
      if (info.size < 4096 || header !== 'MZ') {
        errors.push(`invalid portable tool executable: ${path}`)
      }
    } catch (error) {
      errors.push(`unreadable portable tool executable: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const name of GUIDE_SCREENSHOTS) {
    const path = resolve(guideDir, 'assets', 'ui', name)
    if (!existsSync(path)) continue
    try {
      const png = readFileSync(path)
      const validSignature = png.length >= 24 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      const width = validSignature ? png.readUInt32BE(16) : 0
      const height = validSignature ? png.readUInt32BE(20) : 0
      if (!validSignature || width < 1200 || height < 800) {
        errors.push(`invalid guide screenshot PNG: ${path}`)
      }
    } catch (error) {
      errors.push(`unreadable guide screenshot: ${path}: ${error instanceof Error ? error.message : String(error)}`)
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

  const toolsManifestPath = resolve(runtimeDir, 'tools', 'manifest.json')
  if (existsSync(toolsManifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(toolsManifestPath, 'utf8').replace(/^\uFEFF/, ''))
      if (manifest.schemaVersion !== 1 || manifest.platform !== 'win-x64' || !Array.isArray(manifest.tools)) {
        errors.push(`invalid portable tools manifest: ${toolsManifestPath}`)
      } else {
        for (const required of REQUIRED_PORTABLE_TOOLS) {
          const entry = manifest.tools.find((tool) => tool?.name === required.name)
          if (!entry || entry.dir !== required.dir || typeof entry.version !== 'string' || !entry.version.trim()) {
            errors.push(`portable tools manifest is missing valid ${required.name} metadata: ${toolsManifestPath}`)
          }
        }
      }
    } catch (error) {
      errors.push(`unreadable portable tools manifest: ${error instanceof Error ? error.message : String(error)}`)
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
