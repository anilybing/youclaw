// [XJC-PATCH] T-G1 记忆自动蒸馏：系统任务幂等种子
//
// 复用现有 scheduler 持久任务机制（scheduled_tasks 表 + 30s tick + agentQueue），
// 启动时幂等种子两个 cron 任务；开关来自远程配置缓存 memory.auto_distill
// （缺文件/缺键默认 true）。任务判存用固定 name + 固定 chat_id（跨 agent 查询，
// 防止绑定 agent 变化后重复种子）。

import { readFileSync } from 'node:fs'
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

/** 优先绑定预置数字员工，缺席时回退默认 agent */
const PREFERRED_AGENT_ID = 'office-assistant'
const FALLBACK_AGENT_ID = 'default'

export interface EnsureDistillTasksDeps {
  /** agent 判存（index.ts 传 agentManager.getAgent 的布尔包装） */
  hasAgent: (agentId: string) => boolean
}

export interface DistillTaskOutcome {
  name: string
  action: 'created' | 'kept' | 'refreshed' | 'resumed' | 'paused' | 'skipped'
}

export interface EnsureDistillTasksResult {
  enabled: boolean
  agentId: string
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

interface DistillTaskSpec {
  name: string
  cron: string
  prompt: string
  description: string
}

function buildTaskSpecs(): DistillTaskSpec[] {
  return [
    {
      name: DAILY_DISTILL_TASK_NAME,
      cron: '50 23 * * *',
      prompt: buildDailyDistillPrompt(),
      description: '系统任务：每日 23:50 蒸馏当日记忆为「当日纪要」（T-G1）',
    },
    {
      name: WEEKLY_DISTILL_TASK_NAME,
      cron: '0 22 * * 0',
      prompt: buildWeeklyDistillPrompt(),
      description: '系统任务：每周日 22:00 把近 7 天纪要蒸馏进长期记忆 MEMORY.md（T-G1）',
    },
  ]
}

/** 按固定 chat_id + name 跨 agent 判存（unique 约束按 agent+chat+name，防换绑后重复） */
function findDistillTask(name: string): ScheduledTask | null {
  return listTasks({ chatId: DISTILL_CHAT_ID, name })[0] ?? null
}

function ensureOneTask(
  spec: DistillTaskSpec,
  agentId: string,
  enabled: boolean,
): DistillTaskOutcome['action'] {
  const existing = findDistillTask(spec.name)

  if (!enabled) {
    // 关闭：存在且活跃则暂停（scheduler 的 listDueTasks 只取 status='active'），
    // 不删除——保留任务与运行历史，重新开启时原地恢复。
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
 * 幂等种子记忆蒸馏系统任务。启动序列中在 scheduler 启动后调用；
 * 重复调用不产生重复任务。
 */
export function ensureDistillTasks(deps: EnsureDistillTasksDeps): EnsureDistillTasksResult {
  const logger = getLogger()
  const agentId = deps.hasAgent(PREFERRED_AGENT_ID) ? PREFERRED_AGENT_ID : FALLBACK_AGENT_ID
  const enabled = readAutoDistillEnabled()

  const outcomes: DistillTaskOutcome[] = []
  for (const spec of buildTaskSpecs()) {
    try {
      const action = ensureOneTask(spec, agentId, enabled)
      outcomes.push({ name: spec.name, action })
    } catch (err) {
      logger.error(
        { taskName: spec.name, error: err instanceof Error ? err.message : String(err), category: 'memory-distill' },
        'Failed to seed distill task',
      )
      outcomes.push({ name: spec.name, action: 'skipped' })
    }
  }

  logger.info(
    {
      enabled,
      agentId,
      outcomes: outcomes.map((o) => `${o.name}=${o.action}`).join(', '),
      category: 'memory-distill',
    },
    'Memory distill tasks seeded',
  )

  return { enabled, agentId, outcomes }
}
