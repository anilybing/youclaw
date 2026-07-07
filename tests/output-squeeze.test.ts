// [XJC-PATCH] T-G2 工具输出压缩层单测
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup.ts'
import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { getPaths, resetPathsCache } from '../src/config/index.ts'
import {
  DEFAULT_THRESHOLD_CHARS,
  shouldSqueeze,
  squeezeText,
  wrapToolsWithSqueeze,
} from '../src/agent/output-squeeze.ts'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
}

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 隔离 DATA_DIR/HOME，避免命中真实数据目录（做法同 storage-paths.test.ts） */
function configureIsolatedDataDir(): string {
  const homeDir = makeTempDir('XJC-squeeze-home-')
  const dataDir = resolve(makeTempDir('XJC-squeeze-data-'), 'data')
  process.env.HOME = homeDir
  delete process.env.USERPROFILE
  process.env.DATA_DIR = dataDir
  delete process.env.WORKSPACE_DIR
  resetPathsCache()
  return dataDir
}

function makeTool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: Type.Object({}),
    execute,
  }
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

const execArgs = ['call-1', {}, undefined, undefined, undefined as never] as const

describe('output-squeeze', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = configureIsolatedDataDir()
  })

  afterEach(() => {
    process.env.DATA_DIR = originalEnv.DATA_DIR
    process.env.HOME = originalEnv.HOME
    process.env.USERPROFILE = originalEnv.USERPROFILE
    process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
    resetPathsCache()

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('shouldSqueeze', () => {
    test('短输出不压缩', () => {
      expect(shouldSqueeze('some_tool', 'short output')).toBe(false)
      expect(shouldSqueeze('some_tool', 'x'.repeat(DEFAULT_THRESHOLD_CHARS))).toBe(false)
    })

    test('超阈值输出触发压缩', () => {
      expect(shouldSqueeze('some_tool', 'x'.repeat(DEFAULT_THRESHOLD_CHARS + 1))).toBe(true)
    })

    test('技能 CLI JSON 契约（{"ok":true / {"ok":false 开头）白名单跳过', () => {
      const okPayload = `{"ok":true,"data":"${'a'.repeat(20000)}"}`
      const failPayload = `{"ok":false,"error":"${'b'.repeat(20000)}"}`
      expect(shouldSqueeze('skill_cli', okPayload)).toBe(false)
      expect(shouldSqueeze('skill_cli', failPayload)).toBe(false)
    })

    test('opts.skipTools 命中（大小写不敏感）时跳过', () => {
      const long = 'x'.repeat(20000)
      expect(shouldSqueeze('browser_snapshot', long, { skipTools: ['Browser_Snapshot'] })).toBe(false)
      expect(shouldSqueeze('other_tool', long, { skipTools: ['browser_snapshot'] })).toBe(true)
    })

    test('opts.thresholdChars 可覆盖默认阈值', () => {
      expect(shouldSqueeze('some_tool', 'x'.repeat(600), { thresholdChars: 500 })).toBe(true)
      expect(shouldSqueeze('some_tool', 'x'.repeat(400), { thresholdChars: 500 })).toBe(false)
    })
  })

  describe('squeezeText', () => {
    test('20k 字符 JSON 压缩为结构骨架，原文完整落盘', () => {
      const payload = {
        items: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}`, note: 'n'.repeat(50) })),
        meta: { total: 300, source: 'unit-test' },
      }
      const original = JSON.stringify(payload)
      expect(original.length).toBeGreaterThan(20000)

      const result = squeezeText('mcp__test__fetch', original)

      expect(result.originalChars).toBe(original.length)
      expect(result.squeezedChars).toBe(result.text.length)
      // 压缩后体积 ≤ 阈值 + 尾注（尾注含落盘绝对路径）
      expect(result.text.length).toBeLessThanOrEqual(DEFAULT_THRESHOLD_CHARS + 300)
      expect(result.text).toContain('[JSON 结构骨架]')
      expect(result.text).toContain('items')
      expect(result.text).toContain('meta')
      expect(result.text).toContain(`[输出过长已压缩，完整内容存于 ${result.cachedPath}，需要完整内容时用读取文件工具查看]`)

      // 原文落盘：文件存在且内容与原文一致，位于 <数据目录>/tool-cache/
      expect(existsSync(result.cachedPath)).toBe(true)
      expect(result.cachedPath.startsWith(resolve(dataDir, 'tool-cache'))).toBe(true)
      expect(readFileSync(result.cachedPath, 'utf8')).toBe(original)
    })

    test('长代码/日志文本保留头 80 行 + 尾 30 行，省略行数正确', () => {
      const totalLines = 500
      const original = Array.from({ length: totalLines }, (_, i) => `line ${i + 1} ${'-'.repeat(30)}`).join('\n')
      expect(original.length).toBeGreaterThan(DEFAULT_THRESHOLD_CHARS)

      const result = squeezeText('bash', original)
      const lines = result.text.split('\n')

      // 结构：80 头行 + 1 省略标记 + 30 尾行 + 1 落盘尾注
      expect(lines.length).toBe(80 + 1 + 30 + 1)
      expect(lines[0]).toContain('line 1 ')
      expect(lines[79]).toContain('line 80 ')
      expect(lines[80]).toBe(`…中间省略 ${totalLines - 80 - 30} 行…`)
      expect(lines[81]).toContain(`line ${totalLines - 29} `)
      expect(lines[110]).toContain(`line ${totalLines} `)
      expect(lines[111]).toContain('[输出过长已压缩，完整内容存于 ')
      expect(readFileSync(result.cachedPath, 'utf8')).toBe(original)
    })

    test('普通长文本（行数少）保留头 3000 字 + 尾 1000 字', () => {
      const original = `HEAD${'a'.repeat(12000)}TAIL`
      const result = squeezeText('web_fetch', original)

      expect(result.text.startsWith(original.slice(0, 3000))).toBe(true)
      expect(result.text).toContain('…中间省略 ')
      expect(result.text).toContain(original.slice(-1000))
      expect(result.text.length).toBeLessThanOrEqual(DEFAULT_THRESHOLD_CHARS + 300)
    })

    test('tool-cache 文件数超 200 时删除最旧的 50 个', () => {
      const cacheDir = resolve(dataDir, 'tool-cache')
      mkdirSync(cacheDir, { recursive: true })
      for (let i = 0; i < 201; i += 1) {
        writeFileSync(resolve(cacheDir, `old-${String(i).padStart(3, '0')}.txt`), 'stale')
      }

      squeezeText('bash', 'y'.repeat(20000))

      // 201 - 50 旧文件 + 1 新写入 = 152
      expect(readdirSync(cacheDir).length).toBe(152)
    })
  })

  describe('wrapToolsWithSqueeze', () => {
    test('超阈值结果被压缩且原 execute 只调用一次', async () => {
      const original = 'z'.repeat(20000)
      let callCount = 0
      const tool = makeTool('mcp__test__big_output', async () => {
        callCount += 1
        return textResult(original)
      })

      const [wrapped] = wrapToolsWithSqueeze([tool])
      const result = await wrapped!.execute(...execArgs)

      expect(callCount).toBe(1)
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text.length).toBeLessThanOrEqual(DEFAULT_THRESHOLD_CHARS + 300)
      expect(text).toContain('[输出过长已压缩，完整内容存于 ')

      // 落盘文件内容 = 原文
      const cachedPath = text.match(/完整内容存于 (.+?)，需要完整内容时/)?.[1]
      expect(cachedPath).toBeTruthy()
      expect(readFileSync(cachedPath!, 'utf8')).toBe(original)
    })

    test('短输出与技能 CLI JSON 不被改动', async () => {
      const short = makeTool('short_tool', async () => textResult('hello'))
      const skillCli = makeTool('skill_cli', async () => textResult(`{"ok":true,"data":"${'a'.repeat(20000)}"}`))

      const [wrappedShort, wrappedSkill] = wrapToolsWithSqueeze([short, skillCli])

      const shortResult = await wrappedShort!.execute(...execArgs)
      expect((shortResult.content[0] as { text: string }).text).toBe('hello')

      const skillResult = await wrappedSkill!.execute(...execArgs)
      expect((skillResult.content[0] as { text: string }).text.startsWith('{"ok":true')).toBe(true)
      expect((skillResult.content[0] as { text: string }).text.length).toBeGreaterThan(20000)
    })

    test('工具抛异常时原样透传', async () => {
      const failing = makeTool('failing_tool', async () => {
        throw new Error('tool exploded')
      })

      const [wrapped] = wrapToolsWithSqueeze([failing])
      expect(wrapped!.execute(...execArgs)).rejects.toThrow('tool exploded')
    })

    test('保持工具数组顺序与名称/描述等属性不变', () => {
      const tools = [
        makeTool('alpha', async () => textResult('a')),
        makeTool('beta', async () => textResult('b')),
        makeTool('gamma', async () => textResult('c')),
      ]

      const wrapped = wrapToolsWithSqueeze(tools)

      expect(wrapped.map((tool) => tool.name)).toEqual(['alpha', 'beta', 'gamma'])
      expect(wrapped[1]!.label).toBe('beta')
      expect(wrapped[2]!.description).toBe('test tool gamma')
    })

    test('远程配置 ai.output_squeeze=false 时不压缩（每次执行时重读，即时生效）', async () => {
      const original = 'w'.repeat(20000)
      const tool = makeTool('mcp__test__flagged', async () => textResult(original))
      const [wrapped] = wrapToolsWithSqueeze([tool])

      // 无缓存文件（默认 true）→ 压缩
      const squeezed = await wrapped!.execute(...execArgs)
      expect((squeezed.content[0] as { text: string }).text.length).toBeLessThan(original.length)

      // 写入 flag=false → 同一 wrapped 实例下一次执行即不压缩
      writeFileSync(
        resolve(dataDir, 'remote-config-cache.json'),
        JSON.stringify({ configs: { 'ai.output_squeeze': false }, version: 1 }),
        'utf8',
      )
      const untouched = await wrapped!.execute(...execArgs)
      expect((untouched.content[0] as { text: string }).text).toBe(original)

      // 改回 true → 恢复压缩
      writeFileSync(
        resolve(dataDir, 'remote-config-cache.json'),
        JSON.stringify({ configs: { 'ai.output_squeeze': true }, version: 1 }),
        'utf8',
      )
      const resqueezed = await wrapped!.execute(...execArgs)
      expect((resqueezed.content[0] as { text: string }).text.length).toBeLessThan(original.length)
    })

    test('DATA_DIR 隔离生效：落盘路径位于测试临时数据目录', () => {
      expect(getPaths().data).toBe(dataDir)
      const result = squeezeText('bash', 'q'.repeat(20000))
      expect(result.cachedPath.startsWith(resolve(dataDir, 'tool-cache'))).toBe(true)
    })
  })
})
