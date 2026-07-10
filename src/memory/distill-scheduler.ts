// [XJC-PATCH] T-G1 记忆自动蒸馏：系统任务幂等种子（2026-07-09 升级为每员工蒸馏）
//
// 复用现有 scheduler 持久任务机制（scheduled_tasks 表 + 30s tick + agentQueue），
// 启动时幂等种子 cron 任务；开关来自远程配置缓存 memory.auto_distill
// （缺文件/缺键默认 true）。
//
// 此前只给一个员工（office-assistant/default）种蒸馏任务——其他员工的日记忆永远
// 不会沉淀进各自的 MEMORY.md，"越用越聪明"只对一个员工成立。现改为**每员工种子**：
//   - 活跃门控：只有近 ACTIVITY_WINDOW_DAYS 天内有记忆活动（日笔记/日志文件）的员工
//     才保持任务活跃，闲置员工任务暂停——不为空记忆白烧 LLM 调用；
//   - 错峰：按 agentId 哈希把执行分钟错开（23:40-23:54 / 22:00-22:14），避免同刻并发；
//   - 旧任务收编：历史单任务（name 无 agent 后缀）原地改名为其绑定员工的新任务，
//     不丢运行历史、不重复种子。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import {
  createScheduledTask,
  pauseScheduledTaskById,
  resumeScheduledTaskById,
  updateScheduledTaskById,
} from '../task/index.ts'
import { listTasks } from '../task/repository.ts'
import type { ScheduledTask } from '../db/index.ts'
import { buildDailyDistillPrompt, buildWeeklyDistillPrompt } from './distill.ts'

export const DAILY_DISTILL_TASK_NAME = 'system:daily-distill'
export const WEEKLY_DISTILL_TASK_NAME = 'system:weekly-distill'
/** 蒸馏任务专用会话（chat_id 为任意字符串，参照 clone 的 `task:<id>` 约定取 system: 前缀） */
export const DISTILL_CHAT_ID = 'system:memory-distill'
export const AUTO_DISTILL_CONFIG_KEY = 'memory.auto_distill'

/** 员工近 N 天内有记忆活动才保持蒸馏任务活跃（防闲置员工每日白跑 LLM 任务） */
export const ACTIVITY_WINDOW_DAYS = 14
/** 全局代理不参与蒸馏（无对话活动，只有共享 MEMORY.md） */
const EXCLUDED_AGENT_IDS = new Set(['_global'])

export interface EnsureDistillTasksDeps {
  /** 当前已加载的全部 agent id（index.ts 传 agentManager.getAgents() 的 id 列表） */
  listAgentIds: () => string[]
}

export interface DistillTaskOutcome {
  agentId: string
  name: string
  action: 'created' | 'kept' | 'refreshed' | 'resumed' | 'paused' | 'skipped'
}

export interface EnsureDistillTasksResult {
  enabled: boolean
  outcomes: DistillTaskOutcome[]
}

/**
 * 读远程配置缓存的 memory.auto_distill 开关。
 * 缓存文件结构（见 routes/commercial.ts）：{ configs: {...}, version }。
 * 文件缺失/损坏/键缺失一律按 true（默认开启）；仅显式 false 关闭。
 */
export function readAutoDistillEnabled(): boolean {
  try {
    const cachePath = resolve(getPaths().data, 'remote-config-cache.json')
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      configs?: Record<string, unknown>
    }
    return parsed?.configs?.[AUTO_DISTILL_CONFIG_KEY] !== false
  } catch {
    return true
  }
}

/**
 * 员工近 withinDays 天是否有记忆活动。日笔记与日志文件名即日期
 * （memory/YYYY-MM-DD.md、memory/logs/YYYY-MM-DD.md），按文件名判断，零 IO 读取。
 */
export function hasRecentMemoryActivity(agentId: string, withinDays = ACTIVITY_WINDOW_DAYS): boolean {
  const memoryDir = resolve(getPaths().agents, agentId, 'memory')
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - withinDays)
  const cutoffStr = cutoff.toISOString().split('T')[0]!

  const hasRecentDateFile = (dir: string): boolean => {
    if (!existsSync(dir)) return false
    try {
      return readdirSync(dir).some((f) => {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)
        return m !== null && m[1]! >= cutoffStr
      })
    } catch {
      return false
    }
  }

  return hasRecentDateFile(memoryDir) || hasRecentDateFile(resolve(memoryDir, 'logs'))
}

/** 稳定哈希（错峰分钟用），与 agentId 一一对应 */
function staggerOffset(agentId: string, buckets: number): number {
  let h = 0
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0
  return h % buckets
}

interface DistillTaskSpec {
  name: string
  cron: string
  prompt: string
  description: string
}

/** 每员工任务名：system:daily-distill:<agentId>（历史单任务无后缀，见 adoptLegacyTask） */
function taskNameFor(base: string, agentId: string): string {
  return `${base}:${agentId}`
}

function buildTaskSpecs(agentId: string): DistillTaskSpec[] {
  const offset = staggerOffset(agentId, 15)
  return [
    {
      name: taskNameFor(DAILY_DISTILL_TASK_NAME, agentId),
      cron: `${40 + offset} 23 * * *`,
      prompt: buildDailyDistillPrompt(),
      description: `系统任务：每日蒸馏 ${agentId} 当日记忆为「当日纪要」（T-G1）`,
    },
    {
      name: taskNameFor(WEEKLY_DISTILL_TASK_NAME, agentId),
      cron: `${offset} 22 * * 0`,
      prompt: buildWeeklyDistillPrompt(),
      description: `系统任务：每周日把 ${agentId} 近 7 天纪要蒸馏进长期记忆 MEMORY.md（T-G1）`,
    },
  ]
}

/** 按固定 chat_id + name 跨 agent 判存（unique 约束按 agent+chat+name，防换绑后重复） */
function findDistillTask(name: string): ScheduledTask | null {
  return listTasks({ chatId: DISTILL_CHAT_ID, name })[0] ?? null
}

/**
 * 收编历史单任务：旧版任务名无 agent 后缀（system:daily-distill），绑定在
 * office-assistant/default 上。原地改名为其绑定员工的新任务名，保留运行历史；
 * 目标名已被占用（不应发生）则暂停旧任务兜底。
 */
function adoptLegacyTask(base: string): void {
  const legacy = findDistillTask(base)
  if (!legacy) return
  const newName = taskNameFor(base, legacy.agent_id)
  try {
    if (findDistillTask(newName)) {
      pauseScheduledTaskById(legacy.id)
      return
    }
    updateScheduledTaskById(legacy.id, { name: newName })
  } catch {
    try { pauseScheduledTaskById(legacy.id) } catch { /* 兜底尽力 */ }
  }
}

function ensureOneTask(
  spec: DistillTaskSpec,
  agentId: string,
  active: boolean,
): DistillTaskOutcome['action'] {
  const existing = findDistillTask(spec.name)

  if (!active) {
    // 全局关闭或员工闲置：存在且活跃则暂停（scheduler 的 listDueTasks 只取 status='active'），
    // 不删除——保留任务与运行历史，恢复活跃后原地 resume。
    if (existing && existing.status === 'active') {
      pauseScheduledTaskById(existing.id)
      return 'paused'
    }
    return 'skipped'
  }

  if (!existing) {
    createScheduledTask({
      agentId,
      chatId: DISTILL_CHAT_ID,
      prompt: spec.prompt,
      scheduleType: 'cron',
      scheduleValue: spec.cron,
      name: spec.name,
      description: spec.description,
    })
    return 'created'
  }

  // 版本升级可能更新 prompt/cron：与当前构建不一致时刷新（系统任务不接受用户编辑）
  const stale = existing.prompt !== spec.prompt || existing.schedule_value !== spec.cron
  if (stale) {
    updateScheduledTaskById(existing.id, {
      prompt: spec.prompt,
      scheduleType: 'cron',
      scheduleValue: spec.cron,
    })
  }

  if (existing.status !== 'active') {
    resumeScheduledTaskById(existing.id)
    return 'resumed'
  }

  return stale ? 'refreshed' : 'kept'
}

/**
 * 幂等种子记忆蒸馏系统任务（每员工两条）。启动序列中在 scheduler 启动后调用；
 * 重复调用不产生重复任务。
 */
export function ensureDistillTasks(deps: EnsureDistillTasksDeps): EnsureDistillTasksResult {
  const logger = getLogger()
  const enabled = readAutoDistillEnabled()

  // 先收编历史单任务（改名后由对应员工的 per-agent 流程接管）
  adoptLegacyTask(DAILY_DISTILL_TASK_NAME)
  adoptLegacyTask(WEEKLY_DISTILL_TASK_NAME)

  const agentIds = deps.listAgentIds().filter((id) => id && !EXCLUDED_AGENT_IDS.has(id))
  const outcomes: DistillTaskOutcome[] = []

  for (const agentId of agentIds) {
    const active = enabled && hasRecentMemoryActivity(agentId)
    for (const spec of buildTaskSpecs(agentId)) {
      try {
        const action = ensureOneTask(spec, agentId, active)
        outcomes.push({ agentId, name: spec.name, action })
      } catch (err) {
        logger.error(
          { taskName: spec.name, agentId, error: err instanceof Error ? err.message : String(err), category: 'memory-distill' },
          'Failed to seed distill task',
        )
        outcomes.push({ agentId, name: spec.name, action: 'skipped' })
      }
    }
  }

  const summary = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.action] = (acc[o.action] ?? 0) + 1
    return acc
  }, {})
  logger.info(
    { enabled, agents: agentIds.length, summary, category: 'memory-distill' },
    'Memory distill tasks seeded (per-agent)',
  )

  return { enabled, outcomes }
}
