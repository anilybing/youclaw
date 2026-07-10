import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { cleanTables } from './setup.ts'
import { getChats, getMessages, updateChatFields } from '../src/db/index.ts'
import { EventBus } from '../src/events/bus.ts'
import { MessageRouter } from '../src/channel/router.ts'
import type { InboundMessage, Channel } from '../src/channel/types.ts'
import { QueueCancellationError } from '../src/agent/queue.ts'
import { ErrorCode } from '../src/events/types.ts'

function expectTimestampedPrompt(value: unknown, expectedMessage: string) {
  expect(value).toEqual(expect.stringMatching(
    new RegExp(`^\\[[A-Z][a-z]{2} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} .+\\] ${expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  ))
}

function createMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    chatId: 'web:chat-1',
    sender: 'user',
    senderName: 'Alice',
    content: 'hello',
    timestamp: '2026-03-10T10:00:00.000Z',
    isGroup: false,
    ...overrides,
  }
}

function createManagedAgent(configOverrides: Record<string, unknown> = {}) {
  return {
    config: {
      id: 'agent-1',
      name: 'Agent One',
      model: 'claude-sonnet-4-6',
      workspaceDir: '/tmp/agent-1',
      ...configOverrides,
    },
    workspaceDir: '/tmp/agent-1',
    runtime: {},
    state: {},
  }
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

describe('MessageRouter.handleInbound', () => {
  beforeEach(() => cleanTables('messages', 'chats'))

  test('ignores message when no matching agent', async () => {
    const resolveAgent = mock(() => undefined)
    const enqueue = mock(() => Promise.resolve('unused'))
    const router = new MessageRouter(
      { resolveAgent } as any,
      { enqueue } as any,
      new EventBus(),
    )

    await router.handleInbound(createMessage())

    expect(resolveAgent).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledTimes(0)
    expect(getMessages('web:chat-1', 10)).toEqual([])
    expect(getChats()).toEqual([])
  })

  test('does not enqueue or persist when group message misses trigger', async () => {
    const enqueue = mock(() => Promise.resolve('unused'))
    const router = new MessageRouter(
      {
        resolveAgent: () => createManagedAgent({ trigger: '^@bot', requiresTrigger: true }),
      } as any,
      { enqueue } as any,
      new EventBus(),
    )

    await router.handleInbound(createMessage({
      chatId: 'tg:group-1',
      isGroup: true,
      content: 'ordinary group message',
    }))

    expect(enqueue).toHaveBeenCalledTimes(0)
    expect(getMessages('tg:group-1', 10)).toEqual([])
    expect(getChats()).toEqual([])
  })

  test('auto-parses skill invocations, saves message, and records daily log', async () => {
    const eventBus = new EventBus()
    const enqueue = mock(async () => {
      eventBus.emit({
        type: 'complete',
        agentId: 'agent-1',
        chatId: 'web:chat-1',
        fullText: 'router reply',
        sessionId: 'session-1',
        turnId: 'msg-1',
      })
      return 'router reply'
    })
    const appendDailyLog = mock(() => {})
    const rememberTurn = mock(() => Promise.resolve([]))
    const getUsableSkillNamesForAgent = mock(() => new Set(['pdf', 'agent-browser']))
    const router = new MessageRouter(
      {
        resolveAgent: () => createManagedAgent(),
      } as any,
      { enqueue } as any,
      eventBus,
      { appendDailyLog, rememberTurn } as any,
      { getUsableSkillNamesForAgent } as any,
    )

    await router.handleInbound(createMessage({
      content: '/pdf /agent-browser summarize report',
    }))

    expect(getUsableSkillNamesForAgent).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]?.[0]).toBe('agent-1')
    expect(enqueue.mock.calls[0]?.[1]).toBe('web:chat-1')
    expectTimestampedPrompt(enqueue.mock.calls[0]?.[2], 'summarize report')
    expect(enqueue.mock.calls[0]?.[3]).toMatchObject({
      requestedSkills: ['pdf', 'agent-browser'],
    })
    const afterResult = enqueue.mock.calls[0]?.[3]?.afterResult as ((result: string) => Promise<void>) | undefined
    expect(typeof afterResult).toBe('function')
    await afterResult?.('router reply')
    expect(appendDailyLog).toHaveBeenCalledWith(
      'agent-1',
      'web:chat-1',
      '/pdf /agent-browser summarize report',
      'router reply',
      undefined,
    )
    expect(rememberTurn).toHaveBeenCalledWith(
      'agent-1',
      'web:chat-1',
      '/pdf /agent-browser summarize report',
      'router reply',
    )

    const chats = getChats()
    const messages = getMessages('web:chat-1', 10)
    expect(chats.length).toBe(1)
    expect(chats[0]?.name).toBe('/pdf /agent-browser summarize report')
    expect(chats[0]?.channel).toBe('web')
    expect(messages.length).toBe(2)
    expect(messages.some((message) => message.content === '/pdf /agent-browser summarize report')).toBe(true)
    expect(messages.some((message) => message.content === 'router reply')).toBe(true)
  })

  test('internal workflow turns never enter durable memory extraction', async () => {
    const enqueue = mock(() => Promise.resolve('internal result'))
    const appendDailyLog = mock(() => {})
    const rememberTurn = mock(() => Promise.resolve([]))
    const router = new MessageRouter(
      { resolveAgent: () => createManagedAgent() } as any,
      { enqueue } as any,
      new EventBus(),
      { appendDailyLog, rememberTurn } as any,
    )

    await router.handleInbound(createMessage({
      chatId: 'workflow:trace-test:run-1',
      agentOps: {
        traceId: 'trace-1',
        spanId: 'span-1',
        workflowId: 'trace-test',
        workflowRunId: 'run-1',
        internal: true,
      },
    }))
    const afterResult = enqueue.mock.calls[0]?.[3]?.afterResult as (result: string) => Promise<void>
    await afterResult('internal result')
    expect(appendDailyLog).not.toHaveBeenCalled()
    expect(rememberTurn).not.toHaveBeenCalled()
  })

  test('emits one terminal cancellation event for queued and running turns', async () => {
    const queuedBus = new EventBus()
    const queuedTerminalEvents: string[] = []
    queuedBus.subscribe({ types: ['complete', 'error'] }, (event) => {
      queuedTerminalEvents.push(event.type)
    })
    const queuedRouter = new MessageRouter(
      { resolveAgent: () => createManagedAgent() } as any,
      {
        enqueue: () => Promise.reject(
          new QueueCancellationError('web:queued-cancel', 'queued-turn', 'queued'),
        ),
      } as any,
      queuedBus,
    )
    await queuedRouter.handleInbound(createMessage({
      id: 'queued-turn',
      chatId: 'web:queued-cancel',
    }))
    expect(queuedTerminalEvents).toEqual(['error'])
    expect(getMessages('web:queued-cancel', 10).filter((message) => message.is_bot_message === 1))
      .toEqual([expect.objectContaining({
        turn_id: 'queued-turn',
        error_code: ErrorCode.CANCELLED,
      })])

    const runningBus = new EventBus()
    const runningTerminalEvents: string[] = []
    runningBus.subscribe({ types: ['complete', 'error'] }, (event) => {
      runningTerminalEvents.push(event.type)
    })
    const runningRouter = new MessageRouter(
      { resolveAgent: () => createManagedAgent() } as any,
      {
        enqueue: async () => {
          runningBus.emit({
            type: 'complete',
            agentId: 'agent-1',
            chatId: 'web:running-cancel',
            fullText: '',
            sessionId: '',
            turnId: 'running-turn',
            cancelled: true,
          })
          throw new QueueCancellationError('web:running-cancel', 'running-turn', 'running')
        },
      } as any,
      runningBus,
    )
    await runningRouter.handleInbound(createMessage({
      id: 'running-turn',
      chatId: 'web:running-cancel',
    }))
    expect(runningTerminalEvents).toEqual(['complete'])
    expect(getMessages('web:running-cancel', 10).filter((message) => message.is_bot_message === 1))
      .toEqual([expect.objectContaining({
        turn_id: 'running-turn',
        error_code: ErrorCode.CANCELLED,
      })])
  })

  test('does not overwrite a customized title on later inbound messages', async () => {
    const router = new MessageRouter(
      { resolveAgent: () => createManagedAgent() } as any,
      { enqueue: mock(() => Promise.resolve('ok')) } as any,
      new EventBus(),
    )

    await router.handleInbound(createMessage({ id: 'title-1', content: 'Initial title' }))
    updateChatFields('web:chat-1', { name: 'My custom title' })
    await router.handleInbound(createMessage({ id: 'title-2', content: 'Later message' }))

    expect(getChats().find((chat) => chat.chat_id === 'web:chat-1')?.name).toBe('My custom title')
  })

  test('persists tool use onto the final assistant message during complete events', async () => {
    const eventBus = new EventBus()
    const enqueue = mock(async () => {
      const messagesAfterComplete = (() => {
        eventBus.emit({
          type: 'complete',
          agentId: 'agent-1',
          chatId: 'web:chat-1',
          fullText: 'done',
          sessionId: 'session-1',
          turnId: 'msg-1',
          toolUse: [
            { id: 'tool:msg-1:1', name: 'Read', input: '{"file_path":"report.md"}', status: 'done' },
          ],
        })
        return getMessages('web:chat-1', 10)
      })()
      expect(messagesAfterComplete.some((message) => message.content === 'done')).toBe(true)
      return 'done'
    })
    const router = new MessageRouter(
      {
        resolveAgent: () => createManagedAgent(),
      } as any,
      { enqueue } as any,
      eventBus,
    )

    await router.handleInbound(createMessage())

    const messages = getMessages('web:chat-1', 10)
    const assistant = messages.find((message) => message.is_bot_message === 1)
    expect(assistant?.turn_id).toBe('msg-1')
    expect(assistant?.session_id).toBe('session-1')
    expect(assistant?.tool_use_json).toContain('"name":"Read"')
  })

  test('deduplicates repeated complete events for the same turn', async () => {
    const eventBus = new EventBus()
    const enqueue = mock(async () => {
      eventBus.emit({
        type: 'complete',
        agentId: 'agent-1',
        chatId: 'web:chat-1',
        fullText: 'done',
        sessionId: 'session-1',
        turnId: 'msg-1',
      })
      eventBus.emit({
        type: 'complete',
        agentId: 'agent-1',
        chatId: 'web:chat-1',
        fullText: 'done again',
        sessionId: 'session-2',
        turnId: 'msg-1',
      })
      return 'done'
    })
    const router = new MessageRouter(
      {
        resolveAgent: () => createManagedAgent(),
      } as any,
      { enqueue } as any,
      eventBus,
    )

    await router.handleInbound(createMessage())

    const assistantMessages = getMessages('web:chat-1', 10).filter((message) => message.is_bot_message === 1)
    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0]?.turn_id).toBe('msg-1')
    expect(assistantMessages[0]?.content).toBe('done')
  })

  test('explicit requestedSkills take priority, prefix is not re-parsed', async () => {
    const enqueue = mock(() => Promise.resolve('ok'))
    const getUsableSkillNamesForAgent = mock(() => new Set(['pdf']))
    const router = new MessageRouter(
      {
        resolveAgent: () => createManagedAgent(),
      } as any,
      { enqueue } as any,
      new EventBus(),
      undefined,
      { getUsableSkillNamesForAgent } as any,
    )

    await router.handleInbound(createMessage({
      content: '/pdf keep raw content',
      requestedSkills: ['explicit-skill'],
    }))

    expect(getUsableSkillNamesForAgent).toHaveBeenCalledTimes(0)
    expectTimestampedPrompt(enqueue.mock.calls[0]?.[2], '/pdf keep raw content')
    expect(enqueue.mock.calls[0]?.[3]).toMatchObject({
      requestedSkills: ['explicit-skill'],
    })
  })

  test('injects a timestamp envelope for the agent prompt while storing raw message content', async () => {
    const enqueue = mock(() => Promise.resolve('ok'))
    const router = new MessageRouter(
      {
        resolveAgent: () => createManagedAgent(),
      } as any,
      { enqueue } as any,
      new EventBus(),
    )

    await router.handleInbound(createMessage({
      content: '现在几点了',
      timestamp: '2026-03-24T12:01:00.000Z',
    }))

    expectTimestampedPrompt(enqueue.mock.calls[0]?.[2], '现在几点了')

    const messages = getMessages('web:chat-1', 10)
    expect(messages.some((message) => message.content === '现在几点了')).toBe(true)
    expect(messages.some((message) => message.content.includes('[Tue 2026-03-24'))).toBe(false)
  })
})

describe('MessageRouter complete event outbound', () => {
  test('sends completion message only to the channel that owns the chatId', async () => {
    const eventBus = new EventBus()
    const firstSend = mock(() => Promise.resolve())
    const secondSend = mock(() => Promise.resolve())
    const router = new MessageRouter(
      { resolveAgent: () => createManagedAgent() } as any,
      { enqueue: mock(() => Promise.resolve('unused')) } as any,
      eventBus,
    )

    router.addChannel(createChannel({
      name: 'first',
      ownsChatId: () => false,
      sendMessage: firstSend,
    }))
    router.addChannel(createChannel({
      name: 'second',
      ownsChatId: (chatId) => chatId === 'tg:1',
      sendMessage: secondSend,
    }))

    eventBus.emit({ type: 'complete', agentId: 'agent-1', chatId: 'tg:1', fullText: 'done', sessionId: 'session-1' })
    await Promise.resolve()

    expect(firstSend).toHaveBeenCalledTimes(0)
    expect(secondSend).toHaveBeenCalledTimes(1)
    expect(secondSend).toHaveBeenCalledWith('tg:1', 'done')
  })
})
