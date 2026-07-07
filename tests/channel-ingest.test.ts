/**
 * G6.2 渠道消息日摘要测试
 *
 * 覆盖：
 * - 当日 IM 渠道消息按会话折叠成摘要写入当日记忆「渠道消息」段
 * - 只取 IM 渠道前缀（web:/task:/system: 一律排除）
 * - 水位幂等：二次运行只消化新增量，无新消息不写文件
 * - 跨日：昨天的消息不进今天的摘要
 * - 长会话折叠：首尾片段 + 中间省略；单条长消息截断
 * - 开关红线：channelDigestEnabled=false 时不读不写
 * - 隐私红线：游标只存 date+watermark，不含消息内容
 * - 定时器：ensureChannelDigestTask 幂等；msUntilNextDigest 对齐 23:40
 *
 * 隔离：经 tests/setup.ts 使用临时 DATA_DIR；messages/chats 表每用例清空。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { cleanTables, getDatabase } from './setup.ts'
import { getPaths } from '../src/config/index.ts'
import { saveMessage, upsertChat } from '../src/db/index.ts'
import { updateIngestSettings } from '../src/ingest/settings.ts'
import { getDailyMemoryPath } from '../src/ingest/folder-ingest.ts'
import {
  MESSAGE_SNIPPET_MAX_CHARS,
  SNIPPETS_PER_CHAT,
  runChannelDigest,
} from '../src/ingest/channel-ingest.ts'
import {
  CHANNEL_DIGEST_HOUR,
  CHANNEL_DIGEST_MINUTE,
  ensureChannelDigestTask,
  msUntilNextDigest,
  stopChannelDigestTask,
} from '../src/ingest/ingest-scheduler.ts'

/** 固定「当前时刻」：本地 2026-07-07 22:00（水位/日界都相对它） */
const NOW = new Date(2026, 6, 7, 22, 0, 0)

function isoAt(hour: number, minute: number, day = 7): string {
  return new Date(2026, 6, day, hour, minute, 0).toISOString()
}

let seq = 0
function seedMessage(chatId: string, content: string, timestamp: string, opts: { bot?: boolean; senderName?: string } = {}): void {
  seq += 1
  saveMessage({
    id: `msg-${seq}`,
    chatId,
    sender: opts.bot ? 'assistant' : 'user',
    senderName: opts.senderName ?? (opts.bot ? '小橘' : '张三'),
    content,
    timestamp,
    isFromMe: opts.bot ?? false,
    isBotMessage: opts.bot ?? false,
  })
}

function readDailyMemory(agentId = 'default'): string {
  const path = getDailyMemoryPath(agentId, NOW)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function readDigestState(): { date: string; watermark: string } | null {
  const db = getDatabase()
  const row = db.query("SELECT value FROM kv_state WHERE key = 'channel_digest_state'").get() as { value: string } | null
  return row ? JSON.parse(row.value) : null
}

beforeEach(() => {
  cleanTables('messages', 'chats', 'kv_state')
  rmSync(getPaths().agents, { recursive: true, force: true })
  updateIngestSettings({ channelDigestEnabled: true })
})

afterEach(() => {
  stopChannelDigestTask()
})

describe('runChannelDigest', () => {
  test('当日渠道消息按会话折叠写入「渠道消息」段', () => {
    upsertChat('dingtalk:user:staff1', 'agent-a', '张三', 'dingtalk')
    seedMessage('dingtalk:user:staff1', '下午的评审改到明天十点', isoAt(10, 0))
    seedMessage('dingtalk:user:staff1', '好的，我更新日历并通知大家', isoAt(10, 1), { bot: true })

    const result = runChannelDigest({ now: NOW })

    expect(result.enabled).toBe(true)
    expect(result.messages).toBe(2)
    expect(result.chats).toBe(1)

    const memory = readDailyMemory()
    expect(memory).toContain('## 渠道消息')
    expect(memory).toContain('会话「张三」新增 2 条')
    expect(memory).toContain('张三: 下午的评审改到明天十点')
    expect(memory).toContain('助手: 好的，我更新日历并通知大家')
  })

  test('web/task/system 会话不进渠道摘要', () => {
    seedMessage('web:abc-123', 'web 上聊的内容', isoAt(9, 0))
    seedMessage('task:xyz', '定时任务产物', isoAt(9, 5))
    seedMessage('system:memory-distill', '蒸馏任务回复', isoAt(9, 10))
    seedMessage('feishu:oc_1', '飞书里说的事', isoAt(9, 15))

    const result = runChannelDigest({ now: NOW })

    expect(result.messages).toBe(1)
    const memory = readDailyMemory()
    expect(memory).toContain('飞书里说的事')
    expect(memory).not.toContain('web 上聊的内容')
    expect(memory).not.toContain('定时任务产物')
    expect(memory).not.toContain('蒸馏任务回复')
  })

  test('水位幂等：二次运行只消化增量，无新消息不写', () => {
    seedMessage('wecom:user1', '上午的消息', isoAt(9, 0))
    expect(runChannelDigest({ now: NOW }).messages).toBe(1)
    const afterFirst = readDailyMemory()

    // 无新消息：不写文件、结果为 0
    expect(runChannelDigest({ now: NOW }).messages).toBe(0)
    expect(readDailyMemory()).toBe(afterFirst)

    // 新增一条晚于水位的消息：只消化这 1 条
    seedMessage('wecom:user1', '下午的新消息', isoAt(15, 0))
    const third = runChannelDigest({ now: NOW })
    expect(third.messages).toBe(1)
    const memory = readDailyMemory()
    expect(memory).toContain('上午的消息')
    expect(memory).toContain('下午的新消息')
    // 「上午的消息」只出现一次（没有因二次运行重复写入）
    expect(memory.indexOf('上午的消息')).toBe(memory.lastIndexOf('上午的消息'))
  })

  test('跨日：昨天的消息不进今天的摘要', () => {
    seedMessage('dingtalk:user:a', '昨天的旧消息', isoAt(23, 0, 6))
    seedMessage('dingtalk:user:a', '今天的新消息', isoAt(8, 0, 7))

    const result = runChannelDigest({ now: NOW })

    expect(result.messages).toBe(1)
    const memory = readDailyMemory()
    expect(memory).toContain('今天的新消息')
    expect(memory).not.toContain('昨天的旧消息')
  })

  test('长会话折叠首尾片段并标注省略；单条长消息截断', () => {
    const total = SNIPPETS_PER_CHAT * 2 + 4 // 10 条，中间省略 4 条
    for (let i = 1; i <= total; i++) {
      seedMessage('feishu:oc_long', `第${i}条消息`, isoAt(9, i))
    }
    const longText = 'A'.repeat(MESSAGE_SNIPPET_MAX_CHARS + 50)
    seedMessage('qq:c2c:u1', longText, isoAt(12, 0))

    runChannelDigest({ now: NOW })
    const memory = readDailyMemory()

    expect(memory).toContain(`新增 ${total} 条`)
    expect(memory).toContain('第1条消息')
    expect(memory).toContain(`第${total}条消息`)
    expect(memory).toContain('中间省略 4 条')
    expect(memory).not.toContain('第5条消息') // 中段被省略

    expect(memory).toContain('A'.repeat(MESSAGE_SNIPPET_MAX_CHARS) + '…')
    expect(memory).not.toContain(longText)
  })

  test('channelDigestEnabled=false 时不读不写', () => {
    updateIngestSettings({ channelDigestEnabled: false })
    seedMessage('dingtalk:user:x', '不该被摘要的内容', isoAt(9, 0))

    const result = runChannelDigest({ now: NOW })

    expect(result.enabled).toBe(false)
    expect(result.messages).toBe(0)
    expect(readDailyMemory()).toBe('')
    expect(readDigestState()).toBeNull()
  })

  test('隐私红线：游标只存 date+watermark，不含消息内容', () => {
    seedMessage('wxoa:123', '游标里绝不能出现的正文', isoAt(9, 0))
    runChannelDigest({ now: NOW })

    const state = readDigestState()
    expect(state).not.toBeNull()
    expect(Object.keys(state!).sort()).toEqual(['date', 'watermark'])
    expect(state!.date).toBe('2026-07-07')
    expect(state!.watermark).toBe(isoAt(9, 0))
    expect(JSON.stringify(state)).not.toContain('游标里绝不能出现的正文')
  })

  test('office-assistant 存在时优先写其记忆', () => {
    seedMessage('dingtalk:user:s', '给数字员工的渠道消息', isoAt(9, 0))

    const result = runChannelDigest({ now: NOW, hasAgent: (id) => id === 'office-assistant' })

    expect(result.agentId).toBe('office-assistant')
    expect(readDailyMemory('office-assistant')).toContain('给数字员工的渠道消息')
    expect(readDailyMemory('default')).toBe('')
  })
})

describe('channel digest scheduler', () => {
  test('msUntilNextDigest 对齐本地 23:40，已过则取明日', () => {
    const before = new Date(2026, 6, 7, 22, 0, 0)
    const target = new Date(2026, 6, 7, CHANNEL_DIGEST_HOUR, CHANNEL_DIGEST_MINUTE, 0, 0)
    expect(msUntilNextDigest(before)).toBe(target.getTime() - before.getTime())

    const after = new Date(2026, 6, 7, 23, 50, 0)
    const nextDay = new Date(2026, 6, 8, CHANNEL_DIGEST_HOUR, CHANNEL_DIGEST_MINUTE, 0, 0)
    expect(msUntilNextDigest(after)).toBe(nextDay.getTime() - after.getTime())
  })

  test('ensureChannelDigestTask 幂等拉起定时器', () => {
    expect(ensureChannelDigestTask()).toEqual({ active: true })
    expect(ensureChannelDigestTask()).toEqual({ active: true })
    stopChannelDigestTask()
  })
})
