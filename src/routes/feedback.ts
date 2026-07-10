// [XJC] 用户反馈信号路由（学习能力 P0）：把"这条回答好不好"变成可学习的真实质量信号。
//   POST /api/feedback — 记录一条消息的 👍/👎，落库(可覆盖) + 喂进化引擎 recordOutcome
//
// 为什么重要：此前进化/学习只有"跑完即成功"这个噪声信号(success=finished≠correct)。
// 用户显式 👍/👎 是最强质量标签，作为 recordOutcome 的高置信来源(context.source=user_feedback)。

import { Hono } from 'hono'
import { getDatabase } from '../db/index.ts'
import { getEvolutionService } from '../evolution/service.ts'
import { getLogger } from '../logger/index.ts'

interface FeedbackBody {
  chatId?: string
  messageId?: string
  agentId?: string
  rating?: string
  comment?: string
}

export function createFeedbackRoutes() {
  const app = new Hono()

  app.post('/feedback', async (c) => {
    let body: FeedbackBody
    try {
      body = await c.req.json() as FeedbackBody
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const chatId = String(body.chatId ?? '').trim()
    const messageId = String(body.messageId ?? '').trim()
    const agentId = String(body.agentId ?? '').trim() || null
    const rating = String(body.rating ?? '').trim()
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : null

    if (!chatId || !messageId) return c.json({ error: 'chatId and messageId are required' }, 400)
    if (rating !== 'up' && rating !== 'down') return c.json({ error: 'rating must be "up" or "down"' }, 400)

    try {
      getDatabase().run(
        `INSERT INTO message_feedback (chat_id, message_id, agent_id, rating, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           rating = excluded.rating, comment = excluded.comment, agent_id = excluded.agent_id, created_at = excluded.created_at`,
        [chatId, messageId, agentId, rating, comment, new Date().toISOString()],
      )
    } catch (err) {
      getLogger().error({ error: err instanceof Error ? err.message : String(err), category: 'feedback' }, 'Failed to persist feedback')
      return c.json({ error: 'Failed to persist feedback' }, 500)
    }

    // 喂进化引擎：用户反馈是高置信质量信号（引擎开关关闭时内部会静默 no-op）
    if (agentId) {
      try {
        getEvolutionService().recordOutcome(agentId, rating === 'up' ? 'success' : 'failure', {
          source: 'user_feedback',
          ...(comment ? { note: comment.slice(0, 200) } : {}),
        })
      } catch { /* 学习环路绝不影响反馈本身 */ }
    }

    getLogger().info({ chatId, messageId, agentId, rating, category: 'feedback' }, 'User feedback recorded')
    return c.json({ ok: true, rating })
  })

  return app
}
