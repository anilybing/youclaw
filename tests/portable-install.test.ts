// [XJC-PATCH] new file — T-E3 便携模式安装落盘与 manifest 写入测试
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup-light.ts'
import { isPortableMode } from '../src/config/paths.ts'
import {
  getPlatformKey,
  getPortableToolInstallDir,
  isPathInPortableTools,
  readToolsManifest,
  upsertToolsManifestEntry,
  writeToolsManifest,
  type ToolsManifest,
} from '../src/config/portable-tools.ts'

const tempDirs: string[] = []
const originalForcePortable = process.env.XJC_FORCE_PORTABLE

function makeToolsDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'XiaoJuClaw-install-'))
  tempDirs.push(dir)
  return dir
}

function makeManifest(tools: ToolsManifest['tools']): ToolsManifest {
  return {
    schemaVersion: 1,
    platform: getPlatformKey(),
    tools,
    createdAt: new Date().toISOString(),
  }
}

afterEach(() => {
  if (originalForcePortable === undefined) delete process.env.XJC_FORCE_PORTABLE
  else process.env.XJC_FORCE_PORTABLE = originalForcePortable
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('isPortableMode', () => {
  test('XJC_FORCE_PORTABLE=1 强制便携（测试后门）', () => {
    process.env.XJC_FORCE_PORTABLE = '1'
    expect(isPortableMode()).toBe(true)
  })

  test('默认（测试 DATA_DIR 非 EXE 同级 XiaoJuClawData）为非便携', () => {
    delete process.env.XJC_FORCE_PORTABLE
    expect(isPortableMode()).toBe(false)
  })
})

describe('getPortableToolInstallDir', () => {
  test('非便携模式安装到旧扁平 tools/<tool>（维持现状）', () => {
    delete process.env.XJC_FORCE_PORTABLE
    const toolsDir = makeToolsDir()
    const dir = getPortableToolInstallDir('uv', toolsDir)
    expect(dir).toBe(resolve(toolsDir, 'uv'))
    expect(existsSync(dir)).toBe(true)
  })

  test('便携模式安装到平台子目录 tools/<platformKey>/<tool>', () => {
    process.env.XJC_FORCE_PORTABLE = '1'
    const toolsDir = makeToolsDir()
    for (const tool of ['bun', 'git', 'uv', 'python', 'node']) {
      const dir = getPortableToolInstallDir(tool, toolsDir)
      expect(dir).toBe(resolve(toolsDir, getPlatformKey(), tool))
      expect(existsSync(dir)).toBe(true)
    }
  })
})

describe('manifest 写入与合并', () => {
  test('writeToolsManifest / readToolsManifest 往返一致', () => {
    const toolsDir = makeToolsDir()
    const manifest = makeManifest([{ name: 'uv', version: '0.7.12', dir: 'win-x64/uv', sha256: 'abc' }])
    writeToolsManifest(manifest, toolsDir)

    const parsed = readToolsManifest(toolsDir)
    expect(parsed).toEqual(manifest)
  })

  test('upsertToolsManifestEntry 无 manifest 时新建骨架', () => {
    const toolsDir = makeToolsDir()
    expect(readToolsManifest(toolsDir)).toBeNull()

    const result = upsertToolsManifestEntry({ name: 'uv', version: '0.7.12', dir: 'uv', sha256: 'abc' }, toolsDir)
    expect(result.schemaVersion).toBe(1)
    expect(result.platform).toBe(getPlatformKey())
    expect(result.tools).toHaveLength(1)

    const parsed = readToolsManifest(toolsDir)
    expect(parsed?.tools[0]).toEqual({ name: 'uv', version: '0.7.12', dir: 'uv', sha256: 'abc' })
  })

  test('upsertToolsManifestEntry 追加新工具、按 name 覆盖旧条目', () => {
    const toolsDir = makeToolsDir()
    writeToolsManifest(makeManifest([{ name: 'bun', version: '1.2.15', dir: 'bun', sha256: 'old' }]), toolsDir)

    upsertToolsManifestEntry({ name: 'uv', version: '0.7.12', dir: 'uv' }, toolsDir)
    upsertToolsManifestEntry({ name: 'bun', version: '1.3.0', dir: 'bun', sha256: 'new' }, toolsDir)

    const parsed = readToolsManifest(toolsDir)
    expect(parsed?.tools).toHaveLength(2)
    const bun = parsed?.tools.find((tool) => tool.name === 'bun')
    expect(bun?.version).toBe('1.3.0')
    expect(bun?.sha256).toBe('new')
    expect(parsed?.tools.some((tool) => tool.name === 'uv')).toBe(true)
  })

  test('绝对安装路径归一化为相对 tools/ 的正斜杠路径（与 U 盘 payload 脚本一致）', () => {
    const toolsDir = makeToolsDir()
    const absDir = resolve(toolsDir, getPlatformKey(), 'uv')
    upsertToolsManifestEntry({ name: 'uv', version: '0.7.12', dir: absDir }, toolsDir)

    const parsed = readToolsManifest(toolsDir)
    expect(parsed?.tools[0]?.dir).toBe(`${getPlatformKey()}/uv`)
  })

  test('tools/ 之外的绝对路径原样保留（仅统一为正斜杠）', () => {
    const toolsDir = makeToolsDir()
    const outsideDir = resolve(tmpdir(), 'somewhere-else', 'uv')
    upsertToolsManifestEntry({ name: 'uv', version: '0.7.12', dir: outsideDir }, toolsDir)

    const parsed = readToolsManifest(toolsDir)
    expect(parsed?.tools[0]?.dir).toBe(outsideDir.replaceAll('\\', '/'))
  })
})

describe('isPathInPortableTools（env-check source 判定）', () => {
  test('便携 tools 目录内的可执行文件路径 → true', () => {
    const toolsDir = makeToolsDir()
    const exe = resolve(toolsDir, getPlatformKey(), 'uv', process.platform === 'win32' ? 'uv.exe' : 'uv')
    expect(isPathInPortableTools(exe, toolsDir)).toBe(true)
    expect(isPathInPortableTools(resolve(toolsDir, 'bun', 'bun'), toolsDir)).toBe(true)
  })

  test('tools 目录外、tools 目录本身、null → false', () => {
    const toolsDir = makeToolsDir()
    expect(isPathInPortableTools(resolve(tmpdir(), 'system', 'git'), toolsDir)).toBe(false)
    expect(isPathInPortableTools(toolsDir, toolsDir)).toBe(false)
    expect(isPathInPortableTools(null, toolsDir)).toBe(false)
  })
})
