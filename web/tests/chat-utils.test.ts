import { describe, expect, test } from 'bun:test'
import {
  isTaskChat,
  resolveChatDisplayName,
  resolveChatBadge,
  chatMatchesQuery,
  matchChannelType,
  type ChatItem,
} from '../src/lib/chat-utils'

// 与 t.channels.typeLabels 对齐的最小映射
const TYPE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  feishu: '飞书',
  wecom: '企业微信',
  'wechat-personal': '微信个人号',
}
const TASK_LABEL = '定时任务'

function chat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    chat_id: 'web:1',
    name: 'hello',
    agent_id: 'a1',
    channel: 'web',
    last_message_time: '2026-07-09T00:00:00.000Z',
    last_message: null,
    avatar: null,
    ...overrides,
  }
}

describe('matchChannelType', () => {
  test('精确 type 与实例 id 前缀都能归一，web/task 返回 null', () => {
    const known = Object.keys(TYPE_LABELS)
    expect(matchChannelType('wechat-personal', known)).toBe('wechat-personal')
    expect(matchChannelType('telegram-abc123', known)).toBe('telegram')
    expect(matchChannelType('task', known)).toBeNull()
    expect(matchChannelType('web', known)).toBeNull()
  })
})

describe('isTaskChat', () => {
  test('channel==="task" 或 chatId 以 task: 前缀视为定时任务会话', () => {
    expect(isTaskChat({ channel: 'task', chat_id: 'task:x' })).toBe(true)
    expect(isTaskChat({ channel: 'web', chat_id: 'task:y' })).toBe(true)
    expect(isTaskChat({ channel: 'telegram', chat_id: 'tg:1' })).toBe(false)
  })
})

describe('resolveChatDisplayName', () => {
  test('去掉定时任务 "Task: " 前缀只显示任务名', () => {
    expect(resolveChatDisplayName('Task: 每日简报', TYPE_LABELS)).toBe('每日简报')
  })
  test('存量英文 type 名映射成本地化类型名', () => {
    expect(resolveChatDisplayName('wechat-personal', TYPE_LABELS)).toBe('微信个人号')
  })
  test('普通名称原样返回', () => {
    expect(resolveChatDisplayName('Alice', TYPE_LABELS)).toBe('Alice')
  })
})

describe('resolveChatBadge', () => {
  test('定时任务会话徽标为任务标签', () => {
    expect(resolveChatBadge({ channel: 'task', chat_id: 'task:1' }, TYPE_LABELS, TASK_LABEL)).toBe('定时任务')
  })
  test('web/无来源不显示徽标', () => {
    expect(resolveChatBadge({ channel: 'web', chat_id: 'web:1' }, TYPE_LABELS, TASK_LABEL)).toBeNull()
    expect(resolveChatBadge({ channel: '', chat_id: 'x' }, TYPE_LABELS, TASK_LABEL)).toBeNull()
  })
  test('渠道会话（含实例 id）显示本地化类型名', () => {
    expect(resolveChatBadge({ channel: 'wechat-personal', chat_id: 'wxp:1' }, TYPE_LABELS, TASK_LABEL)).toBe('微信个人号')
    expect(resolveChatBadge({ channel: 'telegram-abc', chat_id: 'tg:1' }, TYPE_LABELS, TASK_LABEL)).toBe('Telegram')
  })
})

describe('chatMatchesQuery', () => {
  test('空查询命中全部', () => {
    expect(chatMatchesQuery(chat(), '', TYPE_LABELS, TASK_LABEL)).toBe(true)
  })
  test('搜中文类型名命中存量英文名会话', () => {
    const c = chat({ name: 'wechat-personal', channel: 'wechat-personal', chat_id: 'wxp:1' })
    expect(chatMatchesQuery(c, '微信', TYPE_LABELS, TASK_LABEL)).toBe(true)
  })
  test('搜「定时任务」命中 task 会话', () => {
    const c = chat({ name: 'Task: 每日简报', channel: 'task', chat_id: 'task:1' })
    expect(chatMatchesQuery(c, '定时任务', TYPE_LABELS, TASK_LABEL)).toBe(true)
    expect(chatMatchesQuery(c, '每日', TYPE_LABELS, TASK_LABEL)).toBe(true)
  })
  test('不相关查询不命中', () => {
    expect(chatMatchesQuery(chat({ name: 'Alice' }), 'zzz', TYPE_LABELS, TASK_LABEL)).toBe(false)
  })
})
