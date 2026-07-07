/**
 * T-G6 本地文档摄取一期测试
 *
 * 覆盖：
 * - 首次扫描：识别白名单目录第一层的新文档，摘要写入当日记忆「文档摄取」段
 * - 游标幂等：二次扫描无变更不重复写
 * - 变更识别：mtime/内容变化后按「更新文档」摄取
 * - 开关红线：ingestEnabled=false 时完全不扫描
 * - 只扫第一层：子目录与不支持的扩展名一律跳过
 * - 隐私红线：游标只存 path+mtime；目录移除后游标条目被清理
 * - agent 绑定：office-assistant 优先，缺席回退 default
 *
 * 隔离：经 tests/setup.ts 使用临时 DATA_DIR（含 kv_state 设置存储与 agents 工作区），
 * 监听目录用 mkdtempSync 临时目录（参考 tests/storage-paths.test.ts 做法）。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { cleanTables } from './setup.ts'
import { getPaths } from '../src/config/index.ts'
import { getIngestSettings, updateIngestSettings, normalizeIngestFolders } from '../src/ingest/settings.ts'
import {
  getDailyMemoryPath,
  getIngestStatePath,
  pruneIngestStateToFolders,
  runFolderIngest,
} from '../src/ingest/folder-ingest.ts'
import { ensureIngestTask, stopIngestTask } from '../src/ingest/ingest-scheduler.ts'

const tempDirs: string[] = []

function makeWatchDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'XiaoJuClaw-ingest-'))
  tempDirs.push(dir)
  return dir
}

function readDailyMemory(agentId = 'default'): string {
  const path = getDailyMemoryPath(agentId, new Date())
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function readStateFile(): { version: number; files: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(getIngestStatePath(), 'utf8'))
}

beforeEach(() => {
  cleanTables('kv_state')
  rmSync(getIngestStatePath(), { force: true })
  rmSync(getPaths().agents, { recursive: true, force: true })
})

afterEach(() => {
  stopIngestTask()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// ===== 设置存储 =====

describe('ingest settings', () => {
  test('默认隐私优先：enabled=false、目录为空', () => {
    const settings = getIngestSettings()
    expect(settings.ingestEnabled).toBe(false)
    expect(settings.ingestFolders).toEqual([])
  })

  test('部分更新与目录归一化（去空白/去重）', () => {
    const dir = makeWatchDir()
    const updated = updateIngestSettings({ ingestEnabled: true, ingestFolders: [` ${dir} `, dir, ''] })
    expect(updated.ingestEnabled).toBe(true)
    expect(updated.ingestFolders).toEqual([resolve(dir)])

    // 只改开关不动目录
    const toggled = updateIngestSettings({ ingestEnabled: false })
    expect(toggled.ingestFolders).toEqual([resolve(dir)])
    expect(getIngestSettings().ingestEnabled).toBe(false)
  })

  test('normalizeIngestFolders 过滤空串并解析为绝对路径', () => {
    expect(normalizeIngestFolders(['', '  '])).toEqual([])
  })
})

// ===== 扫描与游标 =====

describe('runFolderIngest', () => {
  test('首次扫描识别新文件并把摘要写入当日记忆', async () => {
    const dir = makeWatchDir()
    writeFileSync(resolve(dir, 'a.txt'), '项目周报：本周完成登录模块联调，下周排期支付对接。', 'utf8')
    writeFileSync(resolve(dir, 'b.md'), '# 会议纪要\n\n讨论了三季度发布计划与人员分工。', 'utf8')
    writeFileSync(resolve(dir, 'c.png'), 'not-a-document', 'utf8') // 不支持的扩展名
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dir] })

    const result = await runFolderIngest()

    expect(result.enabled).toBe(true)
    expect(result.agentId).toBe('default')
    expect(result.scannedFolders).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.ingested.map((f) => f.filename).sort()).toEqual(['a.txt', 'b.md'])
    expect(result.ingested.every((f) => f.kind === 'new')).toBe(true)

    const memory = readDailyMemory()
    expect(memory).toContain('## 文档摄取')
    expect(memory).toContain('新增文档《a.txt》')
    expect(memory).toContain('新增文档《b.md》')
    expect(memory).toContain('项目周报：本周完成登录模块联调')
    expect(memory).toContain('讨论了三季度发布计划')
    expect(memory).toContain('仅存摘要不复制原文')
    expect(memory).not.toContain('c.png')
  })

  test('二次扫描无变更：游标生效不重复写', async () => {
    const dir = makeWatchDir()
    writeFileSync(resolve(dir, 'a.txt'), '第一版内容', 'utf8')
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dir] })

    await runFolderIngest()
    const memoryAfterFirst = readDailyMemory()

    const second = await runFolderIngest()
    expect(second.ingested).toEqual([])
    expect(readDailyMemory()).toBe(memoryAfterFirst)
  })

  test('文件修改后识别为变更并写入更新条目', async () => {
    const dir = makeWatchDir()
    const filePath = resolve(dir, 'plan.md')
    writeFileSync(filePath, '初版排期', 'utf8')
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dir] })
    await runFolderIngest()

    writeFileSync(filePath, '修订版排期：发布顺延一周', 'utf8')
    const bumped = new Date(Date.now() + 5000)
    utimesSync(filePath, bumped, bumped) // 显式抬 mtime，规避文件系统时间精度问题

    const result = await runFolderIngest()
    expect(result.ingested).toEqual([{ path: filePath, filename: 'plan.md', kind: 'changed' }])

    const memory = readDailyMemory()
    expect(memory).toContain('更新文档《plan.md》')
    expect(memory).toContain('修订版排期：发布顺延一周')
  })

  test('ingestEnabled=false 时完全不扫描', async () => {
    const dir = makeWatchDir()
    writeFileSync(resolve(dir, 'secret.txt'), '不该被读到的内容', 'utf8')
    updateIngestSettings({ ingestEnabled: false, ingestFolders: [dir] })

    const result = await runFolderIngest()

    expect(result.enabled).toBe(false)
    expect(result.ingested).toEqual([])
    expect(readDailyMemory()).toBe('')
    expect(existsSync(getIngestStatePath())).toBe(false)
  })

  test('只扫第一层：子目录内文档不摄取', async () => {
    const dir = makeWatchDir()
    mkdirSync(resolve(dir, 'nested'))
    writeFileSync(resolve(dir, 'nested', 'deep.txt'), '子目录文档', 'utf8')
    writeFileSync(resolve(dir, 'top.txt'), '第一层文档', 'utf8')
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dir] })

    const result = await runFolderIngest()

    expect(result.ingested.map((f) => f.filename)).toEqual(['top.txt'])
    expect(readDailyMemory()).not.toContain('deep.txt')
  })

  test('office-assistant 存在时优先写其记忆', async () => {
    const dir = makeWatchDir()
    writeFileSync(resolve(dir, 'note.txt'), '给数字员工的备忘', 'utf8')
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dir] })

    const result = await runFolderIngest({ hasAgent: (id) => id === 'office-assistant' })

    expect(result.agentId).toBe('office-assistant')
    expect(readDailyMemory('office-assistant')).toContain('新增文档《note.txt》')
    expect(readDailyMemory('default')).toBe('')
  })
})

// ===== 隐私红线 =====

describe('privacy guarantees', () => {
  test('游标只含 path+mtime，不含文件内容', async () => {
    const dir = makeWatchDir()
    writeFileSync(resolve(dir, 'a.txt'), '游标里绝不能出现的正文', 'utf8')
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dir] })
    await runFolderIngest()

    const raw = readFileSync(getIngestStatePath(), 'utf8')
    expect(raw).not.toContain('游标里绝不能出现的正文')

    const state = readStateFile()
    const entries = Object.entries(state.files)
    expect(entries.length).toBe(1)
    expect(entries[0]![0]).toBe(resolve(dir, 'a.txt'))
    expect(Object.keys(entries[0]![1])).toEqual(['mtimeMs'])
  })

  test('目录从白名单移除后清理其游标条目', async () => {
    const dirA = makeWatchDir()
    const dirB = makeWatchDir()
    writeFileSync(resolve(dirA, 'a.txt'), '目录 A 文档', 'utf8')
    writeFileSync(resolve(dirB, 'b.txt'), '目录 B 文档', 'utf8')
    updateIngestSettings({ ingestEnabled: true, ingestFolders: [dirA, dirB] })
    await runFolderIngest()
    expect(Object.keys(readStateFile().files).length).toBe(2)

    // 模拟设置里移除目录 A（routes/ingest.ts 保存后同步调用 prune）
    const updated = updateIngestSettings({ ingestFolders: [dirB] })
    const pruned = pruneIngestStateToFolders(updated.ingestFolders)

    expect(pruned).toBe(1)
    const remaining = Object.keys(readStateFile().files)
    expect(remaining).toEqual([resolve(dirB, 'b.txt')])
  })
})

// ===== 调度开关 =====

describe('ensureIngestTask', () => {
  test('enabled=false 不起轮询；enabled=true 起且幂等；关闭后停掉', () => {
    updateIngestSettings({ ingestEnabled: false })
    expect(ensureIngestTask(undefined, { immediate: false })).toEqual({ enabled: false, active: false })

    updateIngestSettings({ ingestEnabled: true })
    expect(ensureIngestTask(undefined, { immediate: false })).toEqual({ enabled: true, active: true })
    expect(ensureIngestTask(undefined, { immediate: false })).toEqual({ enabled: true, active: true })

    updateIngestSettings({ ingestEnabled: false })
    expect(ensureIngestTask(undefined, { immediate: false })).toEqual({ enabled: false, active: false })
  })
})
