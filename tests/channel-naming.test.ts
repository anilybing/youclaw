/**
 * 渠道命名与会话标题测试
 *
 * 覆盖：
 * - deriveChannelChatTitle 优先级：好友昵称 → 实例自定义 label → 类型中文名
 * - 占位 senderName（unknown/User）与「senderName 即原始 ID」不当作昵称
 * - 群聊回落「label·群」；任何情况下不落原始 type 串
 * - generateDefaultChannelLabel：「类型中文名 + 序号」按同类型实例数递增并避让占用
 * - MessageRouter.handleInbound：渠道会话入库标题走新优先级；web 会话仍用首条消息
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { cleanTables } from './setup.ts'
import { getChats, createChannelRecord } from '../src/db/index.ts'
import { EventBus } from '../src/events/bus.ts'
import { MessageRouter } from '../src/channel/router.ts'
import {
  channelTypeLabel,
  deriveChannelChatTitle,
  generateDefaultChannelLabel,
} from '../src/channel/naming.ts'
import type { InboundMessage, Channel } from '../src/channel/types.ts'

describe('channelTypeLabel', () => {
  test('七个注册类型都有中文/通用名，未知类型回退 type', () => {
    expect(channelTypeLabel('telegram')).toBe('Telegram')
    expect(channelTypeLabel('feishu')).toBe('飞书')
    expect(channelTypeLabel('qq')).toBe('QQ')
    expect(channelTypeLabel('wecom')).toBe('企业微信')
    expect(channelTypeLabel('dingtalk')).toBe('钉钉')
    expect(channelTypeLabel('wechat-oa')).toBe('微信公众号')
    expect(channelTypeLabel('wechat-personal')).toBe('微信个人号')
    expect(channelTypeLabel('nope')).toBe('nope')
  })
})

describe('deriveChannelChatTitle', () => {
  test('有真实昵称时优先用昵称', () => {
    expect(deriveChannelChatTitle({
      channelType: 'telegram',
      sender: '10001',
      senderName: 'Alice',
      instanceLabel: '客服大号',
    })).toBe('Alice')
  })

  test('senderName 等于原始 sender ID 时视为无昵称，落实例自定义名', () => {
    expect(deriveChannelChatTitle({
      channelType: 'wechat-personal',
      sender: 'wxid_abc123',
      senderName: 'wxid_abc123',
      instanceLabel: '客服大号',
    })).toBe('客服大号')
  })

  test('占位 senderName（unknown/User/空白）不当作昵称', () => {
    for (const bad of ['unknown', 'User', 'WeChat User', '  ', undefined]) {
      expect(deriveChannelChatTitle({
        channelType: 'wechat-personal',
        senderName: bad,
        instanceLabel: '运营小号',
      })).toBe('运营小号')
    }
  })

  test('无昵称且无实例名时落类型中文名，绝不落原始 type 串', () => {
    const title = deriveChannelChatTitle({
      channelType: 'wechat-personal',
      sender: 'wxid_x',
      senderName: 'wxid_x',
    })
    expect(title).toBe('微信个人号')
    expect(title).not.toContain('wechat-personal')
  })

  test('群聊用「label·群」', () => {
    expect(deriveChannelChatTitle({
      channelType: 'telegram',
      senderName: 'Alice',
      isGroup: true,
      instanceLabel: '客服大号',
    })).toBe('客服大号·群')
    expect(deriveChannelChatTitle({
      channelType: 'qq',
      senderName: 'member-openid',
      sender: 'member-openid',
      isGroup: true,
    })).toBe('QQ·群')
  })

  test('超长昵称截断到 50 字符', () => {
    const longName = '很长的昵称'.repeat(20)
    const title = deriveChannelChatTitle({
      channelType: 'feishu',
      sender: 'ou_1',
      senderName: longName,
    })
    expect(title).toBe(longName.slice(0, 50))
  })

  test('群聊有真实群名时优先用群名，而非「label·群」', () => {
    expect(deriveChannelChatTitle({
      channelType: 'dingtalk',
      isGroup: true,
      groupName: '产品研发群',
      instanceLabel: '钉钉大号',
    })).toBe('产品研发群')
  })

  test('群聊 groupName 为空白时回退「label·群」', () => {
    expect(deriveChannelChatTitle({
      channelType: 'telegram',
      isGroup: true,
      groupName: '   ',
      instanceLabel: '客服大号',
    })).toBe('客服大号·群')
  })

  test('群名超长截断到 50 字符', () => {
    const longGroup = '超长群名'.repeat(20)
    expect(deriveChannelChatTitle({
      channelType: 'telegram',
      isGroup: true,
      groupName: longGroup,
    })).toBe(longGroup.slice(0, 50))
  })
})

describe('generateDefaultChannelLabel', () => {
  test('首个实例序号为 1', () => {
    expect(generateDefaultChannelLabel('wechat-personal', [])).toBe('微信个人号 1')
  })

  test('同类型第 N 个实例递增，不受其他类型影响', () => {
    const existing = [
      { type: 'wechat-personal', label: '微信个人号 1' },
      { type: 'telegram', label: 'Telegram 1' },
    ]
    expect(generateDefaultChannelLabel('wechat-personal', existing)).toBe('微信个人号 2')
    expect(generateDefaultChannelLabel('dingtalk', existing)).toBe('钉钉 1')
  })

  test('候选名被自定义名占用时继续递增避让', () => {
    const existing = [
      { type: 'wechat-personal', label: '客服大号' },
      { type: 'wechat-personal', label: '微信个人号 3' },
    ]
    // 同类型已有 2 个 → 候选「微信个人号 3」被占 → 「微信个人号 4」
    expect(generateDefaultChannelLabel('wechat-personal', existing)).toBe('微信个人号 4')
  })
})

// ---------------------------------------------------------------------------
// MessageRouter.handleInbound 集成：入库标题
// ---------------------------------------------------------------------------

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'web:chat-1',
    sender: 'user',
    senderName: 'Alice',
    content: 'hello world',
    timestamp: '2026-07-08T10:00:00.000Z',
    isGroup: false,
    ...overrides,
  }
}

function createManagedAgent() {
  return {
    config: {
      id: 'agent-1',
      name: 'Agent One',
      model: 'claude-sonnet-4-6',
      workspaceDir: '/tmp/agent-1',
    },
    workspaceDir: '/tmp/agent-1',
    runtime: {},
    state: {},
  }
}

function createRouter() {
  const enqueue = mock(() => Promise.resolve('ok'))
  const router = new MessageRouter(
    { resolveAgent: () => createManagedAgent() } as any,
    { enqueue } as any,
    new EventBus(),
  )
  return { router, enqueue }
}

function createChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'mock',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsChatId: () => false,
    disconnect: async () => {},
    ...overrides,
  }
}

describe('MessageRouter.handleInbound 会话标题', () => {
  beforeEach(() => cleanTables('messages', 'chats', 'channels'))

  test('微信个人号无昵称：标题用实例自定义名而不是 wechat-personal', async () => {
    createChannelRecord({
      id: 'wechat-personal-mpjdqs',
      type: 'wechat-personal',
      label: '客服大号',
      config: JSON.stringify({}),
      enabled: true,
    })
    const { router } = createRouter()
    router.addChannel(createChannel({
      name: 'wechat-personal-mpjdqs',
      ownsChatId: (chatId) => chatId.startsWith('wxp:'),
    }))

    await router.handleInbound(createMessage({
      chatId: 'wxp:acc1:wxid_friend',
      sender: 'wxid_friend',
      senderName: 'wxid_friend',
      content: '1',
      channel: 'wechat-personal',
    }))

    const chats = getChats()
    expect(chats.length).toBe(1)
    expect(chats[0]?.name).toBe('客服大号')
    expect(chats[0]?.channel).toBe('wechat-personal')
  })

  test('渠道实例不在线/无记录：标题回落类型中文名', async () => {
    const { router } = createRouter()

    await router.handleInbound(createMessage({
      chatId: 'wxp:acc1:wxid_friend',
      sender: 'wxid_friend',
      senderName: 'wxid_friend',
      content: '你好',
      channel: 'wechat-personal',
    }))

    expect(getChats()[0]?.name).toBe('微信个人号')
  })

  test('有真实昵称（Telegram）：标题用昵称', async () => {
    const { router } = createRouter()

    await router.handleInbound(createMessage({
      chatId: 'tg:123456',
      sender: '123456',
      senderName: 'Alice',
      content: 'hi there',
    }))

    expect(getChats()[0]?.name).toBe('Alice')
  })

  test('群聊带 groupName：入库标题用真实群名', async () => {
    const { router } = createRouter()
    router.addChannel(createChannel({
      name: 'telegram-1',
      ownsChatId: (chatId) => chatId.startsWith('tg:'),
    }))

    await router.handleInbound(createMessage({
      chatId: 'tg:-100200300',
      sender: '123456',
      senderName: 'Alice',
      isGroup: true,
      groupName: '产品研发群',
      channel: 'telegram',
    }))

    expect(getChats()[0]?.name).toBe('产品研发群')
  })

  test('web 会话标题仍用首条消息内容', async () => {
    const { router } = createRouter()

    await router.handleInbound(createMessage({
      chatId: 'web:chat-1',
      content: '帮我总结这份报告',
    }))

    expect(getChats()[0]?.name).toBe('帮我总结这份报告')
  })
})
