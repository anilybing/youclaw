/**
 * T-G1 记忆自动蒸馏测试（2026-07-09 升级为每员工蒸馏）
 *
 * 覆盖：
 * - 蒸馏 prompt 构造：幂等标记指令、目标文件路径、红线条款
 * - ensureDistillTasks 每员工种子：活跃门控（近 14 天有记忆文件才 active）、
 *   错峰 cron、幂等、闲置暂停/恢复活跃 resume
 * - 历史单任务收编：旧 name 原地改名保留历史
 * - 远程配置开关：auto_distill=false 全体暂停
 * - readAutoDistillEnabled 的缺省语义（缺文件/缺键 → true）
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanTables } from './setup.ts'
import { getPaths } from '../src/config/index.ts'
import { listScheduledTasks, createScheduledTask, updateScheduledTaskById } from '../src/task/index.ts'
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
  hasRecentMemoryActivity,
  readAutoDistillEnabled,
} from '../src/memory/distill-scheduler.ts'

const cachePath = () => resolve(getPaths().data, 'remote-config-cache.json')

function writeCache(configs: Record<string, unknown>): void {
  writeFileSync(cachePath(), JSON.stringify({ configs, version: 1 }), 'utf8')
}

function removeCache(): void {
  if (existsSync(cachePath())) unlinkSync(cachePath())
}

const AGENT_A = 'distill-agent-a'
const AGENT_B = 'distill-agent-b'
const testAgents = [AGENT_A, AGENT_B]

/** 给员工造一条"今天有记忆活动"的日笔记 */
function touchMemory(agentId: string, daysAgo = 0): void {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const date = d.toISOString().split('T')[0]!
  const dir = resolve(getPaths().agents, agentId, 'memory')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${date}.md`), `# ${date}\n- 活动`)
}

function findTask(name: string) {
  return listScheduledTasks().find((t) => t.name === name && t.chat_id === DISTILL_CHAT_ID)
}

function dailyNameOf(agentId: string) {
  return `${DAILY_DISTILL_TASK_NAME}:${agentId}`
}

beforeEach(() => {
  cleanTables('scheduled_tasks', 'task_run_logs')
  removeCache()
  for (const id of testAgents) {
    rmSync(resolve(getPaths().agents, id), { recursive: true, force: true })
  }
})

afterEach(() => {
  removeCache()
  for (const id of testAgents) {
    rmSync(resolve(getPaths().agents, id), { recursive: true, force: true })
  }
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
  })
})

// ===== 活跃判定 =====

describe('hasRecentMemoryActivity', () => {
  test('无记忆目录 → false；近期日笔记 → true；过期笔记 → false', () => {
    expect(hasRecentMemoryActivity(AGENT_A)).toBe(false)
    touchMemory(AGENT_A, 3)
    expect(hasRecentMemoryActivity(AGENT_A)).toBe(true)
    rmSync(resolve(getPaths().agents, AGENT_A), { recursive: true, force: true })
    touchMemory(AGENT_A, 30)
    expect(hasRecentMemoryActivity(AGENT_A)).toBe(false)
  })
})

// ===== 每员工种子 =====

describe('ensureDistillTasks（每员工）', () => {
  const deps = { listAgentIds: () => testAgents }

  test('活跃员工建任务、闲置员工不建；每员工两条、cron 错峰', () => {
    touchMemory(AGENT_A)
    const result = ensureDistillTasks(deps)

    expect(result.enabled).toBe(true)
    const aDaily = findTask(dailyNameOf(AGENT_A))
    expect(aDaily).toBeDefined()
    expect(aDaily!.agent_id).toBe(AGENT_A)
    expect(aDaily!.schedule_type).toBe('cron')
    // 错峰：分钟落在 40-54
    const minute = Number(aDaily!.schedule_value.split(' ')[0])
    expect(minute).toBeGreaterThanOrEqual(40)
    expect(minute).toBeLessThanOrEqual(54)

    expect(findTask(`${WEEKLY_DISTILL_TASK_NAME}:${AGENT_A}`)).toBeDefined()
    // 闲置员工 B 不建
    expect(findTask(dailyNameOf(AGENT_B))).toBeUndefined()
  })

  test('重复调用幂等；员工转活跃后补建、转闲置后暂停', () => {
    touchMemory(AGENT_A)
    ensureDistillTasks(deps)
    const second = ensureDistillTasks(deps)
    expect(second.outcomes.filter((o) => o.agentId === AGENT_A).map((o) => o.action)).toEqual(['kept', 'kept'])

    // B 转活跃 → 补建
    touchMemory(AGENT_B)
    ensureDistillTasks(deps)
    expect(findTask(dailyNameOf(AGENT_B))).toBeDefined()

    // A 转闲置（删记忆目录）→ 暂停
    rmSync(resolve(getPaths().agents, AGENT_A), { recursive: true, force: true })
    const third = ensureDistillTasks(deps)
    expect(third.outcomes.filter((o) => o.agentId === AGENT_A).map((o) => o.action)).toEqual(['paused', 'paused'])
    expect(findTask(dailyNameOf(AGENT_A))!.status).toBe('paused')

    // A 再转活跃 → resume
    touchMemory(AGENT_A)
    const fourth = ensureDistillTasks(deps)
    expect(fourth.outcomes.filter((o) => o.agentId === AGENT_A).map((o) => o.action)).toEqual(['resumed', 'resumed'])
    expect(findTask(dailyNameOf(AGENT_A))!.status).toBe('active')
  })

  test('历史单任务收编：旧 name 原地改名到绑定员工，不重复建', () => {
    // 模拟旧版任务（无 agent 后缀，绑定 AGENT_A）
    createScheduledTask({
      agentId: AGENT_A,
      chatId: DISTILL_CHAT_ID,
      prompt: '旧版 prompt',
      scheduleType: 'cron',
      scheduleValue: '50 23 * * *',
      name: DAILY_DISTILL_TASK_NAME,
      description: '旧版单任务',
    })
    touchMemory(AGENT_A)

    ensureDistillTasks(deps)

    expect(findTask(DAILY_DISTILL_TASK_NAME)).toBeUndefined() // 旧名不复存在
    const adopted = findTask(dailyNameOf(AGENT_A))
    expect(adopted).toBeDefined()
    expect(adopted!.prompt).toBe(buildDailyDistillPrompt()) // 收编后被刷新为当前版本
    // 只有一条 A 的 daily（收编而非新建+旧任务并存）
    const aDailies = listScheduledTasks().filter((t) => t.chat_id === DISTILL_CHAT_ID && t.agent_id === AGENT_A && t.name?.startsWith(DAILY_DISTILL_TASK_NAME))
    expect(aDailies.length).toBe(1)
  })

  test('prompt 过期原地刷新', () => {
    touchMemory(AGENT_A)
    ensureDistillTasks(deps)
    const daily = findTask(dailyNameOf(AGENT_A))!
    updateScheduledTaskById(daily.id, { prompt: '旧版 prompt' })

    const result = ensureDistillTasks(deps)
    expect(result.outcomes.find((o) => o.name === dailyNameOf(AGENT_A))!.action).toBe('refreshed')
    expect(findTask(dailyNameOf(AGENT_A))!.prompt).toBe(buildDailyDistillPrompt())
  })
})

// ===== 远程配置开关 =====

describe('ensureDistillTasks — memory.auto_distill 开关', () => {
  const deps = { listAgentIds: () => [AGENT_A] }

  test('auto_distill=false 时已有任务被暂停、不存在的不创建', () => {
    touchMemory(AGENT_A)
    ensureDistillTasks(deps)
    expect(findTask(dailyNameOf(AGENT_A))!.status).toBe('active')

    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: false })
    const result = ensureDistillTasks(deps)
    expect(result.enabled).toBe(false)
    expect(findTask(dailyNameOf(AGENT_A))!.status).toBe('paused')

    // 重新开启 → resume
    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: true })
    ensureDistillTasks(deps)
    expect(findTask(dailyNameOf(AGENT_A))!.status).toBe('active')
  })
})

describe('readAutoDistillEnabled', () => {
  test('缺文件/缺键/损坏 → true；显式 false → false', () => {
    removeCache()
    expect(readAutoDistillEnabled()).toBe(true)
    writeCache({ 'features.channels_enabled': false })
    expect(readAutoDistillEnabled()).toBe(true)
    writeFileSync(cachePath(), '{not-json', 'utf8')
    expect(readAutoDistillEnabled()).toBe(true)
    writeCache({ [AUTO_DISTILL_CONFIG_KEY]: false })
    expect(readAutoDistillEnabled()).toBe(false)
  })
})
