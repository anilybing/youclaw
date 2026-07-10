// [XJC] 用户反馈教训测试（确定性学习闭环）：查询过滤/窗口/截断/块组装。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { buildLessonsBlock, getRecentLessons } from '../src/feedback/lessons.ts'

const AGENT = 'lessons-test-agent'

function insertFeedback(row: {
  chatId: string
  messageId: string
  agentId?: string | null
  rating: string
  comment?: string | null
  createdAt?: string
}) {
  getDatabase().run(
    `INSERT OR REPLACE INTO message_feedback (chat_id, message_id, agent_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.chatId, row.messageId, row.agentId ?? AGENT, row.rating, row.comment ?? null, row.createdAt ?? new Date().toISOString()],
  )
}

afterEach(() => {
  getDatabase().run("DELETE FROM message_feedback WHERE chat_id LIKE 'lessons-%'")
})

describe('getRecentLessons', () => {
  test('只取本 agent、rating=down、带非空 comment 的记录，新在前', () => {
    insertFeedback({ chatId: 'lessons-1', messageId: 'm1', rating: 'down', comment: '答非所问', createdAt: '2026-07-08T10:00:00.000Z' })
    insertFeedback({ chatId: 'lessons-1', messageId: 'm2', rating: 'down', comment: '太啰嗦', createdAt: '2026-07-09T10:00:00.000Z' })
    insertFeedback({ chatId: 'lessons-1', messageId: 'm3', rating: 'up', comment: '好评不算教训' })
    insertFeedback({ chatId: 'lessons-1', messageId: 'm4', rating: 'down', comment: '   ' }) // 空白 comment 不算
    insertFeedback({ chatId: 'lessons-1', messageId: 'm5', rating: 'down', comment: null })
    insertFeedback({ chatId: 'lessons-1', messageId: 'm6', agentId: 'other-agent', rating: 'down', comment: '别人的教训' })

    const lessons = getRecentLessons(AGENT)
    expect(lessons.map((l) => l.comment)).toEqual(['太啰嗦', '答非所问'])
  })

  test('超过 14 天窗口的教训不注入', () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
    insertFeedback({ chatId: 'lessons-2', messageId: 'm1', rating: 'down', comment: '过期教训', createdAt: old })
    expect(getRecentLessons(AGENT)).toEqual([])
  })

  test('limit 生效且超长 comment 截断', () => {
    for (let i = 0; i < 5; i++) {
      insertFeedback({
        chatId: 'lessons-3',
        messageId: `m${i}`,
        rating: 'down',
        comment: i === 0 ? 'x'.repeat(300) : `教训${i}`,
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      })
    }
    const lessons = getRecentLessons(AGENT)
    expect(lessons).toHaveLength(3)
    expect(lessons[0]!.comment.length).toBeLessThanOrEqual(201) // 200 + 省略号
    expect(lessons[0]!.comment.endsWith('…')).toBe(true)
  })

  test('空 agentId 返回空', () => {
    expect(getRecentLessons('')).toEqual([])
  })
})

describe('buildLessonsBlock', () => {
  test('无教训返回 null', () => {
    expect(buildLessonsBlock(AGENT)).toBeNull()
  })

  test('有教训时组装 <user_feedback_lessons> 块（换行折叠为空格）', () => {
    insertFeedback({ chatId: 'lessons-4', messageId: 'm1', rating: 'down', comment: '数据\n没有\n来源' })
    const block = buildLessonsBlock(AGENT)!
    expect(block).toContain('<user_feedback_lessons>')
    expect(block).toContain('- 数据 没有 来源')
    expect(block).toContain('</user_feedback_lessons>')
  })
})
