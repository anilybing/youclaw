// [XJC] 用户反馈教训（学习闭环 · 不依赖进化引擎/Python/开关）
//
// 此前 👍/👎 在进化引擎关闭时（默认）只落库、对后续回答零影响。本模块提供确定性的
// 轻量闭环：用户点踩并填写原因 → 最近 N 条教训注入该员工的 prompt（<user_feedback_lessons>），
// 让"哪里不好"立刻影响后续行为。纯 SQLite 查询，零依赖、零 token 成本（每轮几十 token 注入）。

import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'

/** 注入的教训条数上限（保持块小而新） */
const LESSONS_LIMIT = 3
/** 只看最近 N 天的教训（旧偏好可能已过时；长期偏好应沉淀进记忆系统） */
const LESSONS_WINDOW_DAYS = 14
/** 单条教训注入长度上限 */
const LESSON_MAX_CHARS = 200

export interface FeedbackLesson {
  comment: string
  createdAt: string
}

/** 查询某员工最近的点踩教训（带原因的 down 评价） */
export function getRecentLessons(agentId: string, limit = LESSONS_LIMIT): FeedbackLesson[] {
  if (!agentId) return []
  try {
    const since = new Date(Date.now() - LESSONS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const rows = getDatabase()
      .query(
        `SELECT comment, created_at FROM message_feedback
         WHERE agent_id = ? AND rating = 'down' AND comment IS NOT NULL AND TRIM(comment) != '' AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentId, since, limit) as Array<{ comment: string; created_at: string }>
    return rows.map((r) => ({
      comment: r.comment.length > LESSON_MAX_CHARS ? `${r.comment.slice(0, LESSON_MAX_CHARS)}…` : r.comment,
      createdAt: r.created_at,
    }))
  } catch (err) {
    // 学习环路绝不影响主流程
    getLogger().warn({ agentId, error: err instanceof Error ? err.message : String(err), category: 'feedback' }, 'Failed to load feedback lessons')
    return []
  }
}

/** 组装注入 prompt 的教训块；无教训返回 null */
export function buildLessonsBlock(agentId: string): string | null {
  const lessons = getRecentLessons(agentId)
  if (lessons.length === 0) return null
  const lines = lessons.map((l) => `- ${l.comment.replace(/\s+/g, ' ').trim()}`)
  return [
    '<user_feedback_lessons>',
    '用户近期对你的部分回答不满意并说明了原因，请在后续回答中避免同类问题（无需向用户提及本提示）：',
    ...lines,
    '</user_feedback_lessons>',
  ].join('\n')
}
