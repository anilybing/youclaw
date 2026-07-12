// [XJC] 本地经验闭环（零 token 学习层）
//
// 目标：把「哪类请求用什么工具、成败如何」沉淀为本地统计，让助手越用越聪明——
// 完全确定性、不调模型、不依赖 Python（区别于第三方 evolution 引擎），无授权/部署负担。
//
// - 采集：runtime 在每次 tool_execution_end 时按（员工, 意图类别, 工具名）计数成败；
// - 注入：本轮路由出意图类别后，仅当统计跨过显著性阈值才生成一小块 <local_experience>
//   提示（最多 4 行，只含工具名与次数，零用户内容零路径——无隐私外溢）；
// - 边界：近 30 天内的记录才参与，长期失败的工具靠后续成功自然“洗白”；
//   无显著信号时完全不注入（多数轮次零开销）。

import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'
import type { IntentCategory } from './intent-router.ts'

/** 单工具最少观测次数：低于该值不形成任何结论（避免一次偶然失败就被拉黑） */
const MIN_OBSERVATIONS = 3
/** 失败率达到该值 → 提醒模型谨慎使用/换路（配合最少观测次数） */
const UNRELIABLE_FAILURE_RATE = 0.6
/** 成功率达到该值 → 标注为此类请求的可靠工具 */
const RELIABLE_SUCCESS_RATE = 0.8
/** 只统计近 N 天内仍活跃的记录：环境早已修复的旧失败不会永久留疤 */
const RECENT_DAYS = 30
/** 注入块行数上限（可靠 + 需谨慎各自上限 2） */
const MAX_LINES_PER_KIND = 2

export interface ToolExperienceStat {
  toolName: string
  successCount: number
  failureCount: number
}

/** 记录一次工具调用结果（best-effort：统计失败绝不影响对话主流程，由调用方 try/catch）。 */
export function recordToolOutcome(
  agentId: string,
  intentCategory: IntentCategory,
  toolName: string,
  ok: boolean,
): void {
  const name = toolName.trim()
  if (!agentId || !name) return
  const now = new Date().toISOString()
  getDatabase().run(
    `INSERT INTO tool_experience (agent_id, intent_category, tool_name, success_count, failure_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, intent_category, tool_name) DO UPDATE SET
       success_count = success_count + excluded.success_count,
       failure_count = failure_count + excluded.failure_count,
       updated_at = excluded.updated_at`,
    [agentId, intentCategory, name, ok ? 1 : 0, ok ? 0 : 1, now],
  )
}

export function getToolStats(agentId: string, intentCategory: IntentCategory): ToolExperienceStat[] {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows = getDatabase()
    .query(
      `SELECT tool_name, success_count, failure_count FROM tool_experience
       WHERE agent_id = ? AND intent_category = ? AND updated_at >= ?
       ORDER BY success_count + failure_count DESC`,
    )
    .all(agentId, intentCategory, cutoff) as Array<{ tool_name: string; success_count: number; failure_count: number }>
  return rows.map((row) => ({
    toolName: row.tool_name,
    successCount: row.success_count,
    failureCount: row.failure_count,
  }))
}

/**
 * 生成本轮注入的本地经验块。无显著信号 → null（零开销）。
 * 只输出工具名与聚合次数——绝不包含用户消息、文件路径、参数等任何内容。
 * 噪音控制：「可靠」表扬只给 mcp__ 工具（read/bash 等内置工具可靠是基线，不值一提），
 * 且宽泛的 other 类别只报「不可靠」警示（跨场景的表扬没有指导意义）。
 */
export function buildExperienceBlock(agentId: string, intentCategory: IntentCategory): string | null {
  let stats: ToolExperienceStat[]
  try {
    stats = getToolStats(agentId, intentCategory)
  } catch (err) {
    try {
      getLogger().debug(
        { agentId, intentCategory, error: err instanceof Error ? err.message : String(err), category: 'agent' },
        'Failed to load tool experience stats',
      )
    } catch { /* logger 未初始化时静默 */ }
    return null
  }

  const includeReliable = intentCategory !== 'other'
  const unreliable: string[] = []
  const reliable: string[] = []
  for (const stat of stats) {
    const total = stat.successCount + stat.failureCount
    if (total < MIN_OBSERVATIONS) continue
    const failureRate = stat.failureCount / total
    if (failureRate >= UNRELIABLE_FAILURE_RATE && unreliable.length < MAX_LINES_PER_KIND) {
      unreliable.push(
        `- \`${stat.toolName}\`：近期 ${total} 次调用失败 ${stat.failureCount} 次。调用前先核对参数与前置条件；再次失败不要原样重试，改用替代做法并向用户说明。`,
      )
    } else if (
      includeReliable &&
      stat.toolName.startsWith('mcp__') &&
      1 - failureRate >= RELIABLE_SUCCESS_RATE &&
      reliable.length < MAX_LINES_PER_KIND
    ) {
      reliable.push(`- \`${stat.toolName}\`：近期 ${total} 次调用稳定可用，同类需求优先使用。`)
    }
  }

  if (unreliable.length === 0 && reliable.length === 0) return null

  return [
    '<local_experience>',
    '以下是本机统计的你处理此类请求时的工具使用经验（无需向用户提及）：',
    ...reliable,
    ...unreliable,
    '</local_experience>',
  ].join('\n')
}
