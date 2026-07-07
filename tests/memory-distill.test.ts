/**
 * T-G1 记忆自动蒸馏测试
 *
 * 覆盖：
 * - 蒸馏 prompt 构造：幂等标记指令、目标文件路径、红线条款
 * - ensureDistillTasks 幂等：重复调用不产生重复任务（真实 SQLite 测试库，
 *   经 tests/setup.ts 初始化临时 DATA_DIR——无需 mock 任务存储层）
 * - agent 绑定：office-assistant 优先，缺席回退 default
 * - 远程配置开关：auto_distill=false 时暂停任务，恢复 true 后 resume
 * - readAutoDistillEnabled 的缺省语义（缺文件/缺键 → true）
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanTables } from './setup.ts'
import { getPaths } from '../src/config/index.ts'
import { listScheduledTasks, updateScheduledTaskById } from '../src/task/index.ts'
import {
  buildDailyDistillPrompt,
  buildWeeklyDistillPrompt,
  DAILY_DISTILL_MARKER_PREFIX,
  WEEKLY_DISTILL_MARKER_PREFIX,
} from '../src/memory/distill.ts'
import {
  AUTO_DISTILL_CONFIG_KEY,
  DAILY_DISTILL_TASK_NAME,
  DISTILL_CHAT_ID,
  WEEKLY_DISTILL_TASK_NAME,
  ensureDistillTasks,
  readAutoDistillEnabled,
} from '../src/memory/distill-scheduler.ts'

const cachePath = () => resolve(getPaths().data, 'remote-config-cache.json')

function writeCache(configs: Record<string, unknown>): void {
  writeFileSync(cachePath(), JSON.stringify({ configs, version: 1 }), 'utf8')
}

function removeCache(): void {
  if (existsSync(cachePath())) unlinkSync(cachePath())
}

const withOfficeAssistant = { hasAgent: (id: string) => id === 'office-assistant' || id === 'default' }
const defaultOnly = { hasAgent: (id: string) => id === 'default' }

function findTask(name: string) {
  return listScheduledTasks().find((t) => t.name === name && t.chat_id === DISTILL_CHAT_ID)
}

beforeEach(() => {
  cleanTables('scheduled_tasks', 'task_run_logs')
  removeCache()
})

afterEach(() => {
  removeCache()
})

// ===== prompt 构造 =====

describe('buildDailyDistillPrompt', () => {
  test('包含幂等标记指令与目标文件路径', () => {
    const prompt = buildDailyDistillPrompt()
    expect(prompt).toContain(DAILY_DISTILL_MARKER_PREFIX)
    expect(prompt).toContain('memory/<日期>.md')
    expect(prompt).toContain('memory/logs/')
    expect(prompt).toContain('500 token')
    expect(prompt).toContain('禁止重复写入')
  })

  test('写明红线：不虚构、列表化、不写敏感凭据', () => {
    const prompt = buildDailyDistillPrompt()
    expect(prompt).toContain('禁止虚构')
    expect(prompt).toContain('列表')
    expect(prompt).toContain('敏感凭据')
  })
})

describe('buildWeeklyDistillPrompt', () => {
  test('包含周幂等标记指令与 MEMORY.md 分区', () => {
    const prompt = buildWeeklyDistillPrompt()
    expect(prompt).toContain(WEEKLY_DISTILL_MARKER_PREFIX)
    expect(prompt).toContain('MEMORY.md')
    for (const section of ['Profile', 'Schedule', 'Preferences', 'Relationships', 'Projects', 'Notes']) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toContain('追加')
    expect(prompt).toContain('去重')
    expect(prompt).toContain('折叠')
  })

  test('写明红线：不虚构、不写敏感凭据、只改 MEMORY.md', () => {
    const prompt = buildWeeklyDistillPrompt()
    expect(prompt).toContain('禁止虚构')
    expect(prompt).toContain('敏感凭据')
    expect(prompt).toContain('只修改 MEMORY.md')
  })
})

// ===== ensureDistillTasks 幂等种子 =====

describe('ensureDistillTasks', () => {
  test('首次调用创建两个 cron 系统任务，绑定 office-assistant', () => {
    const result = ensureDistillTasks(withOfficeAssistant)

    expect(result.enabled).toBe(true)
    expect(result.agentId).toBe('office-assistant')
    expect(result.outcomes.map((o) => o.action)).toEqual(['created', 'created'])

    const daily = findTask(DAILY_DISTILL_TASK_NAME)
    expect(daily).toBeDefined()
    expect(daily!.agent_id).toBe('office-assistant')
    expect(daily!.schedule_type).toBe('cron')
    expect(daily!.schedule_value).toBe('50 23 * * *')
    expect(daily!.status).toBe('active')
    expect(daily!.prompt).toBe(buildDailyDistillPrompt())

    const weekly = findTask(WEEKLY_DISTILL_TASK_NAME)
    expect(weekly).toBeDefined()
    expect(weekly!.schedule_value).toBe('0 22 * * 0')
    expect(weekly!.prompt).toBe(buildWeeklyDistillPrompt())
  })

  test('office-assistant 缺席时回退 default', () => {
    const result = ensureDistillTasks(defaultOnly)
    expect(result.agentId).toBe('default')
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.agent_id).toBe('default')
  })

  test('重复调用幂等：不产生重复任务', () => {
    ensureDistillTasks(withOfficeAssistant)
    const second = ensureDistillTasks(withOfficeAssistant)

    expect(second.outcomes.map((o) => o.action)).toEqual(['kept', 'kept'])
    const tasks = listScheduledTasks().filter((t) => t.chat_id === DISTILL_CHAT_ID)
    expect(tasks.length).toBe(2)
  })

  test('已有任务 prompt 过期时原地刷新（版本升级场景）', () => {
    ensureDistillTasks(withOfficeAssistant)
    const daily = findTask(DAILY_DISTILL_TASK_NAME)!
    updateScheduledTaskById(daily.id, { prompt: '旧版 prompt' })

    const result = ensureDistillTasks(withOfficeAssistant)
    expect(result.outcomes.find((o) => o.name === DAILY_DISTILL_TASK_NAME)!.action).toBe('refreshed')
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.prompt).toBe(buildDailyDistillPrompt())
    // 无新增任务
    expect(listScheduledTasks().filter((t) => t.chat_id === DISTILL_CHAT_ID).length).toBe(2)
  })
})

// ===== 远程配置开关 =====

describe('ensureDistillTasks — memory.auto_distill 开关', () => {
  test('auto_distill=false 时已有任务被暂停', () => {
    ensureDistillTasks(withOfficeAssistant)
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.status).toBe('active')

    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: false })
    const result = ensureDistillTasks(withOfficeAssistant)

    expect(result.enabled).toBe(false)
    expect(result.outcomes.map((o) => o.action)).toEqual(['paused', 'paused'])
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.status).toBe('paused')
    expect(findTask(WEEKLY_DISTILL_TASK_NAME)!.status).toBe('paused')
  })

  test('auto_distill=false 且任务不存在时不创建', () => {
    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: false })
    const result = ensureDistillTasks(withOfficeAssistant)

    expect(result.outcomes.map((o) => o.action)).toEqual(['skipped', 'skipped'])
    expect(listScheduledTasks().filter((t) => t.chat_id === DISTILL_CHAT_ID).length).toBe(0)
  })

  test('重新开启后暂停的任务被恢复', () => {
    ensureDistillTasks(withOfficeAssistant)
    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: false })
    ensureDistillTasks(withOfficeAssistant)
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.status).toBe('paused')

    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: true })
    const result = ensureDistillTasks(withOfficeAssistant)

    expect(result.outcomes.map((o) => o.action)).toEqual(['resumed', 'resumed'])
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.status).toBe('active')
    expect(findTask(DAILY_DISTILL_TASK_NAME)!.next_run).not.toBeNull()
  })
})

describe('readAutoDistillEnabled', () => {
  test('缓存文件缺失 → 默认 true', () => {
    removeCache()
    expect(readAutoDistillEnabled()).toBe(true)
  })

  test('缓存存在但键缺失 → 默认 true', () => {
    writeCache({ 'features.channels_enabled': false })
    expect(readAutoDistillEnabled()).toBe(true)
  })

  test('显式 false → false；显式 true → true', () => {
    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: false })
    expect(readAutoDistillEnabled()).toBe(false)
    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: true })
    expect(readAutoDistillEnabled()).toBe(true)
  })

  test('缓存损坏 → 默认 true', () => {
    writeFileSync(cachePath(), '{not-json', 'utf8')
    expect(readAutoDistillEnabled()).toBe(true)
  })
})
