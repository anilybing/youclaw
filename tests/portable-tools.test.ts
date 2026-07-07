import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup-light.ts'
import {
  checkManifestVersions,
  ensurePortableToolsInPath,
  getExpectedToolVersions,
  getPlatformKey,
  readToolsManifest,
  resolvePortableToolDir,
  type ToolsManifest,
} from '../src/config/portable-tools.ts'

const sep = process.platform === 'win32' ? ';' : ':'
const tempDirs: string[] = []

function makeToolsDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'XiaoJuClaw-tools-'))
  tempDirs.push(dir)
  return dir
}

function writeManifest(toolsDir: string, manifest: unknown): void {
  writeFileSync(resolve(toolsDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('getPlatformKey', () => {
  test('返回当前平台合法值', () => {
    const key = getPlatformKey()
    const { platform, arch } = process
    const expected =
      platform === 'win32' && arch === 'x64' ? 'win-x64'
      : platform === 'darwin' && arch === 'arm64' ? 'darwin-arm64'
      : platform === 'darwin' && arch === 'x64' ? 'darwin-x64'
      : platform === 'linux' && arch === 'x64' ? 'linux-x64'
      : `${platform}-${arch}`
    expect(key).toBe(expected)
    expect(key).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
  })
})

describe('目录解析与 PATH 注入', () => {
  test('平台子目录优先于扁平目录（两者都建时注入顺序正确）', () => {
    const toolsDir = makeToolsDir()
    const platformKey = getPlatformKey()

    // 平台子目录：bun、git/cmd；扁平目录：bun、git/bin
    const platformBun = resolve(toolsDir, platformKey, 'bun')
    const platformGitCmd = resolve(toolsDir, platformKey, 'git', 'cmd')
    const flatBun = resolve(toolsDir, 'bun')
    const flatGitBin = resolve(toolsDir, 'git', 'bin')
    for (const dir of [platformBun, platformGitCmd, flatBun, flatGitBin]) {
      mkdirSync(dir, { recursive: true })
    }

    const basePath = resolve(toolsDir, 'fake-system-bin')
    const env: Record<string, string | undefined> = { PATH: basePath }
    const injected = ensurePortableToolsInPath({ toolsDirOverride: toolsDir, env })

    // 注入顺序 = 平台子目录在前、扁平次之
    expect(injected).toEqual([platformBun, platformGitCmd, flatBun, flatGitBin])
    // 原 PATH 保持在最后
    expect(env.PATH).toBe([platformBun, platformGitCmd, flatBun, flatGitBin, basePath].join(sep))
    // 真实 process.env.PATH 未被污染
    expect(process.env.PATH ?? '').not.toContain(toolsDir)
  })

  test('仅扁平目录时兼容注入（存量 U 盘）', () => {
    const toolsDir = makeToolsDir()
    const flatBun = resolve(toolsDir, 'bun')
    const flatGitCmd = resolve(toolsDir, 'git', 'cmd')
    const flatUv = resolve(toolsDir, 'uv')
    for (const dir of [flatBun, flatGitCmd, flatUv]) {
      mkdirSync(dir, { recursive: true })
    }

    const env: Record<string, string | undefined> = { PATH: '' }
    const injected = ensurePortableToolsInPath({ toolsDirOverride: toolsDir, env })

    expect(injected).toEqual([flatBun, flatGitCmd, flatUv])
    expect(env.PATH).toBe([flatBun, flatGitCmd, flatUv].join(sep))
  })

  test('PATH 不重复注入（连续调用两次）', () => {
    const toolsDir = makeToolsDir()
    mkdirSync(resolve(toolsDir, 'bun'), { recursive: true })
    mkdirSync(resolve(toolsDir, getPlatformKey(), 'uv'), { recursive: true })

    const env: Record<string, string | undefined> = { PATH: '' }
    const first = ensurePortableToolsInPath({ toolsDirOverride: toolsDir, env })
    expect(first.length).toBe(2)
    const pathAfterFirst = env.PATH

    const second = ensurePortableToolsInPath({ toolsDirOverride: toolsDir, env })
    expect(second).toEqual([])
    expect(env.PATH).toBe(pathAfterFirst)
  })

  test('resolvePortableToolDir 优先平台子目录，回退扁平，均无返回 null', () => {
    const toolsDir = makeToolsDir()
    const platformKey = getPlatformKey()

    expect(resolvePortableToolDir('bun', toolsDir)).toBeNull()

    const flatBun = resolve(toolsDir, 'bun')
    mkdirSync(flatBun, { recursive: true })
    expect(resolvePortableToolDir('bun', toolsDir)).toBe(flatBun)

    const platformBun = resolve(toolsDir, platformKey, 'bun')
    mkdirSync(platformBun, { recursive: true })
    expect(resolvePortableToolDir('bun', toolsDir)).toBe(platformBun)
  })
})

describe('manifest 读取与版本校验', () => {
  test('manifest 缺失返回 null', () => {
    const toolsDir = makeToolsDir()
    expect(readToolsManifest(toolsDir)).toBeNull()
  })

  test('manifest 损坏（非法 JSON / 结构不符）返回 null 不抛错', () => {
    const toolsDir = makeToolsDir()
    writeFileSync(resolve(toolsDir, 'manifest.json'), '{ not json', 'utf-8')
    expect(readToolsManifest(toolsDir)).toBeNull()

    writeManifest(toolsDir, { schemaVersion: 2, tools: 'oops' })
    expect(readToolsManifest(toolsDir)).toBeNull()
  })

  test('合法 manifest 正常解析', () => {
    const toolsDir = makeToolsDir()
    const manifest = makeManifest([
      { name: 'bun', version: '1.2.15', dir: 'bun', sha256: 'abc123' },
      { name: 'git', version: '2.53.0.2', dir: 'git' },
    ])
    writeManifest(toolsDir, manifest)

    const parsed = readToolsManifest(toolsDir)
    expect(parsed).not.toBeNull()
    expect(parsed?.schemaVersion).toBe(1)
    expect(parsed?.platform).toBe(getPlatformKey())
    expect(parsed?.tools).toHaveLength(2)
    expect(parsed?.tools[0]?.name).toBe('bun')
    expect(parsed?.tools[0]?.sha256).toBe('abc123')
    expect(parsed?.tools[1]?.version).toBe('2.53.0.2')
  })

  test('低版本产生告警条目，达标版本不告警', () => {
    const manifest = makeManifest([
      { name: 'bun', version: '1.0.0', dir: 'bun' },
      { name: 'git', version: '2.53.0.2', dir: 'git' },
      { name: 'uv', version: '0.7.11', dir: 'uv' },
      { name: 'unknown-tool', version: '0.0.1', dir: 'x' },
    ])
    const expected = { bun: '1.2.15', git: '2.53.0.2', uv: '0.7.12' }

    const warnings = checkManifestVersions(manifest, expected)
    expect(warnings.map(w => w.name).sort()).toEqual(['bun', 'uv'])

    const bunWarning = warnings.find(w => w.name === 'bun')
    expect(bunWarning?.current).toBe('1.0.0')
    expect(bunWarning?.expected).toBe('1.2.15')
    expect(bunWarning?.message).toContain('bun')
  })

  test('manifest 为 null 时校验返回空列表；默认期望版本来自 app.config.ts', () => {
    expect(checkManifestVersions(null)).toEqual([])

    const expected = getExpectedToolVersions()
    expect(typeof expected.bun).toBe('string')
    expect(typeof expected.git).toBe('string')
    expect(typeof expected.uv).toBe('string')

    // 与期望完全一致 → 无告警
    const okManifest = makeManifest(
      Object.entries(expected).map(([name, version]) => ({ name, version, dir: name })),
    )
    expect(checkManifestVersions(okManifest)).toEqual([])
  })

  test('ensurePortableToolsInPath 执行时读 manifest 并对低版本告警（不抛错）', () => {
    const toolsDir = makeToolsDir()
    mkdirSync(resolve(toolsDir, 'bun'), { recursive: true })
    writeManifest(toolsDir, makeManifest([{ name: 'bun', version: '0.0.1', dir: 'bun' }]))

    const env: Record<string, string | undefined> = { PATH: '' }
    const injected = ensurePortableToolsInPath({ toolsDirOverride: toolsDir, env })
    expect(injected).toEqual([resolve(toolsDir, 'bun')])
  })
})
