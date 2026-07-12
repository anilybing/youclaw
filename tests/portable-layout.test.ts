// [XJC-PATCH] Release artifact must never contain mutable user data.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

const roots: string[] = []
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
const REQUIRED_TOOLS = [
  { name: 'bun', dir: 'win-x64/bun', file: 'win-x64/bun/bun.exe' },
  { name: 'git', dir: 'win-x64/git', file: 'win-x64/git/cmd/git.exe' },
  { name: 'uv', dir: 'win-x64/uv', file: 'win-x64/uv/uv.exe' },
  { name: 'python', dir: 'win-x64/python', file: 'win-x64/python/python.exe' },
]

function fakePngHeader(width = 1440, height = 960): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function fakePeExecutable(): Buffer {
  const bytes = Buffer.alloc(4096)
  bytes.write('MZ', 0, 'ascii')
  return bytes
}

function makeLayout(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'xiaojuclaw-layout-'))
  roots.push(root)
  const app = resolve(root, 'XiaoJuClaw')
  const tools = resolve(root, 'XiaoJuClawRuntime', 'tools')
  const guideAssets = resolve(root, 'XiaoJuClaw-User-Guide', 'assets', 'ui')
  mkdirSync(app, { recursive: true })
  mkdirSync(tools, { recursive: true })
  mkdirSync(guideAssets, { recursive: true })
  for (const file of ['XiaoJuClaw.exe', 'XiaoJuClaw-server.exe', 'package.json']) {
    writeFileSync(resolve(app, file), file)
  }
  writeFileSync(resolve(app, 'portable-layout.json'), JSON.stringify({
    schemaVersion: 1,
    dataDir: '../XiaoJuClawData',
    runtimeDir: '../XiaoJuClawRuntime',
  }, null, 2))
  writeFileSync(resolve(tools, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'win-x64',
    tools: REQUIRED_TOOLS.map((tool) => ({ name: tool.name, version: '1.0.0', dir: tool.dir })),
  }))
  for (const tool of REQUIRED_TOOLS) {
    const path = resolve(tools, tool.file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, fakePeExecutable())
  }
  writeFileSync(resolve(root, 'Start-XiaoJuClaw.bat'), '@echo off')
  writeFileSync(resolve(root, 'Migrate-Legacy-Layout.bat'), '@echo off')
  writeFileSync(resolve(root, 'XiaoJuClaw-User-Guide', 'index.html'), '<h1>guide</h1>')
  for (const screenshot of GUIDE_SCREENSHOTS) {
    writeFileSync(resolve(guideAssets, screenshot), fakePngHeader())
  }
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

  test('rejects a portable package without the illustrated customer guide', () => {
    const root = makeLayout()
    rmSync(resolve(root, 'XiaoJuClaw-User-Guide', 'index.html'))

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('XiaoJuClaw-User-Guide')
  })

  test('rejects an illustrated guide with a missing UI screenshot', () => {
    const root = makeLayout()
    rmSync(resolve(root, 'XiaoJuClaw-User-Guide', 'assets', 'ui', '08-workflows.png'))

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('08-workflows.png')
  })

  test('rejects a guide screenshot that is not a valid minimum-size PNG', () => {
    const root = makeLayout()
    writeFileSync(
      resolve(root, 'XiaoJuClaw-User-Guide', 'assets', 'ui', '08-workflows.png'),
      fakePngHeader(640, 480),
    )

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('invalid guide screenshot PNG')
  })

  test('rejects a package missing a required portable runtime executable', () => {
    const root = makeLayout()
    rmSync(resolve(root, 'XiaoJuClawRuntime', 'tools', 'win-x64', 'python', 'python.exe'))

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('python.exe')
  })

  test('rejects a tools manifest without required metadata', () => {
    const root = makeLayout()
    writeFileSync(resolve(root, 'XiaoJuClawRuntime', 'tools', 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      platform: 'win-x64',
      tools: [],
    }))

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('valid bun metadata')
  })

  test('rejects a corrupt portable tool executable', () => {
    const root = makeLayout()
    writeFileSync(
      resolve(root, 'XiaoJuClawRuntime', 'tools', 'win-x64', 'uv', 'uv.exe'),
      'not a PE executable',
    )

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('invalid portable tool executable')
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

  // [XJC] pytools（语义记忆 + 本地 OCR）可选载荷门禁
  function addPytools(root: string, options?: { skipModel?: boolean; skipManifestEntry?: boolean; skipSite?: boolean }) {
    const pytools = resolve(root, 'XiaoJuClawRuntime', 'tools', 'win-x64', 'pytools')
    mkdirSync(resolve(pytools, 'site-packages'), { recursive: true })
    if (!options?.skipSite) {
      writeFileSync(resolve(pytools, 'site-packages', 'marker.py'), '# dep')
    }
    writeFileSync(resolve(pytools, 'pytools.json'), JSON.stringify({ schemaVersion: 1, ocr: true, embedding: true }))
    if (!options?.skipModel) {
      const modelDir = resolve(pytools, 'models', 'bge-small-zh-v1.5')
      mkdirSync(modelDir, { recursive: true })
      writeFileSync(resolve(modelDir, 'model.onnx'), Buffer.alloc(2 * 1024 * 1024))
      writeFileSync(resolve(modelDir, 'tokenizer.json'), Buffer.alloc(20 * 1024))
    }
    if (!options?.skipManifestEntry) {
      const manifestPath = resolve(root, 'XiaoJuClawRuntime', 'tools', 'manifest.json')
      writeFileSync(manifestPath, JSON.stringify({
        schemaVersion: 1,
        platform: 'win-x64',
        tools: [
          ...REQUIRED_TOOLS.map((tool) => ({ name: tool.name, version: '1.0.0', dir: tool.dir })),
          { name: 'pytools', version: '2026-07-13', dir: 'win-x64/pytools' },
        ],
      }))
    }
    return pytools
  }

  test('accepts a package without the optional pytools payload', () => {
    const result = verify(makeLayout())
    expect(result.exitCode).toBe(0)
  })

  test('accepts a complete pytools payload registered in the manifest', () => {
    const root = makeLayout()
    addPytools(root)

    const result = verify(root)

    expect(result.exitCode).toBe(0)
  })

  test('rejects a pytools payload with a truncated embedding model', () => {
    const root = makeLayout()
    const pytools = addPytools(root)
    writeFileSync(resolve(pytools, 'models', 'bge-small-zh-v1.5', 'model.onnx'), Buffer.alloc(1024))

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('embedding model missing or truncated')
  })

  test('rejects a shipped pytools payload that is not registered in the tools manifest', () => {
    const root = makeLayout()
    addPytools(root, { skipManifestEntry: true })

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('not registered in tools manifest')
  })

  test('rejects a manifest that registers pytools without the payload directory', () => {
    const root = makeLayout()
    const manifestPath = resolve(root, 'XiaoJuClawRuntime', 'tools', 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      platform: 'win-x64',
      tools: [
        ...REQUIRED_TOOLS.map((tool) => ({ name: tool.name, version: '1.0.0', dir: tool.dir })),
        { name: 'pytools', version: '2026-07-13', dir: 'win-x64/pytools' },
      ],
    }))

    const result = verify(root)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('payload directory is missing')
  })
})
