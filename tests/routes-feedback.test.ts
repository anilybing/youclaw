// [XJC] 用户反馈信号路由测试（学习 P0）：落库/覆盖/校验。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { createFeedbackRoutes } from '../src/routes/feedback.ts'

const app = createFeedbackRoutes()

function post(body: unknown) {
  return app.request('/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function readFeedback(chatId: string, messageId: string) {
  return getDatabase().query('SELECT rating, comment, agent_id FROM message_feedback WHERE chat_id = ? AND message_id = ?')
    .get(chatId, messageId) as { rating: string; comment: string | null; agent_id: string | null } | null
}

afterEach(() => {
  getDatabase().run("DELETE FROM message_feedback WHERE chat_id LIKE 'fb-test-%'")
})

describe('POST /feedback', () => {
  test('记录 👍 并落库', async () => {
    const res = await post({ chatId: 'fb-test-1', messageId: 'm1', agentId: 'office-assistant', rating: 'up' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, rating: 'up' })
    expect(readFeedback('fb-test-1', 'm1')).toMatchObject({ rating: 'up', agent_id: 'office-assistant' })
  })

  test('同一消息再次评价覆盖（up→down）', async () => {
    await post({ chatId: 'fb-test-2', messageId: 'm1', agentId: 'a', rating: 'up' })
    await post({ chatId: 'fb-test-2', messageId: 'm1', agentId: 'a', rating: 'down', comment: '答错了' })
    const row = readFeedback('fb-test-2', 'm1')
    expect(row?.rating).toBe('down')
    expect(row?.comment).toBe('答错了')
  })

  test('非法 rating 返回 400', async () => {
    const res = await post({ chatId: 'fb-test-3', messageId: 'm1', rating: 'meh' })
    expect(res.status).toBe(400)
  })

  test('缺 chatId/messageId 返回 400', async () => {
    const res = await post({ rating: 'up' })
    expect(res.status).toBe(400)
  })

  test('非法 JSON 返回 400', async () => {
    const res = await app.request('/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })
    expect(res.status).toBe(400)
  })
})
