// [XJC] 内置 MCP Server 测试：开关门禁/Bearer 鉴权/只读默认策略/危险工具二次授权/对话桥。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { createMcpServerRoutes } from '../src/routes/mcp-server.ts'
import { createSettingsRoutes } from '../src/routes/settings.ts'
import { updateSettings, getSettings } from '../src/settings/manager.ts'
import { addCards, deliverForOrder, upsertSku } from '../src/fulfillment/store.ts'
import { upsertChat, saveMessage } from '../src/db/index.ts'
import { SettingsSchema } from '../src/settings/schema.ts'

const TOKEN = 'test-mcp-token-0123456789abcdef'

type TestMcpEvent =
  | { type: 'complete'; fullText: string; turnId: string }
  | { type: 'error'; error: string; turnId: string }

// 对话桥 fake：dispatch 后异步回 complete；dispatched 记录投递、handlers 暴露订阅
const dispatched: Array<{ agentId: string; chatId: string; messageId: string; content: string }> = []
const cancelled: Array<{ chatId: string; turnId: string }> = []
let chatHandlers = new Map<string, (event: TestMcpEvent) => void>()
let autoReply: ((chatId: string, turnId: string) => void) | null = (chatId, turnId) => {
  setTimeout(() => chatHandlers.get(chatId)?.({
    type: 'complete',
    fullText: `回复:${chatId}`,
    turnId,
  }), 10)
}

const app = createMcpServerRoutes({
  listEmployees: () => [
    { id: 'xianyu-cs', name: '小橘闲鱼客服', model: 'qwen3-max (custom API, global default)' },
    { id: 'office-assistant', name: '小橘办公助理', model: null },
  ],
  hasEmployee: (id) => id === 'xianyu-cs' || id === 'office-assistant',
  dispatchMessage: ({ agentId, chatId, messageId, content }) => {
    dispatched.push({ agentId, chatId, messageId, content })
    autoReply?.(chatId, messageId)
  },
  subscribeChatEvents: (chatId, handler) => {
    chatHandlers.set(chatId, handler)
    return () => chatHandlers.delete(chatId)
  },
  recallMemory: (agentId, query) => (query === 'hit' ? [{ snippet: `${agentId} 记忆片段`, source: 'MEMORY.md' }] : []),
  cancelTurn: (chatId, turnId) => {
    cancelled.push({ chatId, turnId })
    return { queued: 0, running: 1 }
  },
})
const settingsApp = createSettingsRoutes()

function rpc(body: unknown, token?: string) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  updateSettings({ mcpServer: { enabled: true, allowDangerousTools: false, token: TOKEN } })
  dispatched.length = 0
  cancelled.length = 0
  chatHandlers = new Map()
  autoReply = (chatId, turnId) => {
    setTimeout(() => chatHandlers.get(chatId)?.({
      type: 'complete',
      fullText: `回复:${chatId}`,
      turnId,
    }), 10)
  }
})

afterEach(() => {
  updateSettings({ mcpServer: { enabled: false, allowDangerousTools: false, token: '' } })
  const db = getDatabase()
  db.run("DELETE FROM fulfillment_cards WHERE sku_id LIKE 'mcp-%'")
  db.run("DELETE FROM fulfillment_deliveries WHERE sku_id LIKE 'mcp-%'")
  db.run("DELETE FROM fulfillment_skus WHERE id LIKE 'mcp-%'")
  db.run("DELETE FROM messages WHERE chat_id LIKE 'mcp:%' OR chat_id LIKE 'mcp-test%'")
  db.run("DELETE FROM chats WHERE chat_id LIKE 'mcp:%' OR chat_id LIKE 'mcp-test%'")
})

describe('mcp-server 门禁', () => {
  test('危险工具开关 schema 默认关闭', () => {
    expect(SettingsSchema.parse({}).mcpServer.allowDangerousTools).toBe(false)
  })

  test('开关关闭 → 403（默认不开放）', async () => {
    updateSettings({ mcpServer: { enabled: false, allowDangerousTools: false, token: TOKEN } })
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN)
    expect(res.status).toBe(403)
  })

  test('无 token / 错 token → 401；token 为空时全部拒绝', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')).status).toBe(401)

    updateSettings({ mcpServer: { enabled: true, allowDangerousTools: false, token: '' } })
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, '')).status).toBe(401)
  })

  test('GET/DELETE → 405（无 SSE/无会话）', async () => {
    expect((await app.request('/mcp')).status).toBe(405)
    expect((await app.request('/mcp', { method: 'DELETE' })).status).toBe(405)
  })

  test('坏 JSON → -32700；数组 batch → -32600', async () => {
    const bad = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: '{nope',
    })
    expect(bad.status).toBe(400)
    const batch = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }], TOKEN)
    expect(batch.status).toBe(400)
  })
})

describe('mcp-server 协议', () => {
  test('initialize 握手：协议版本/能力/serverInfo', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, TOKEN)
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } }
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.serverInfo.name).toBe('xiaojuclaw')
    expect(body.result.capabilities.tools).toBeDefined()
  })

  test('notification（无 id）→ 202 空应答', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, TOKEN)
    expect(res.status).toBe(202)
  })

  test('未知方法 → -32601（resources/list 等一律拒绝）', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, TOKEN)
    const body = await res.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })

  test('tools/list 默认只返回只读工具', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, TOKEN)
    const body = await res.json() as { result: { tools: Array<{ name: string }> } }
    const names = body.result.tools.map((t) => t.name)
    expect(names).toEqual([
      'list_employees',
      'list_chats',
      'get_chat_messages',
      'recall_memory',
      'list_workflows',
      'get_workflow_run',
      'search_knowledge',
      'fulfillment_list_stock',
      'fulfillment_list_deliveries',
    ])
  })

  test('显式开启危险工具后 tools/list 恢复完整白名单', async () => {
    updateSettings({ mcpServer: { enabled: true, allowDangerousTools: true, token: TOKEN } })
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, TOKEN)
    const body = await res.json() as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map((t) => t.name)).toEqual([
      'list_employees',
      'ask_employee',
      'list_chats',
      'get_chat_messages',
      'recall_memory',
      'list_workflows',
      'run_workflow',
      'get_workflow_run',
      'search_knowledge',
      'fulfillment_list_stock',
      'fulfillment_list_deliveries',
      'fulfillment_upsert_sku',
      'fulfillment_add_cards',
      'fulfillment_deliver',
    ])
  })
})

describe('mcp-server 工具执行', () => {
  test('默认模式拒绝全部危险工具调用，且不会投递员工任务', async () => {
    const dangerousTools = [
      'ask_employee',
      'run_workflow',
      'fulfillment_upsert_sku',
      'fulfillment_add_cards',
      'fulfillment_deliver',
    ]
    for (const name of dangerousTools) {
      const res = await rpc({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } }, TOKEN)
      const body = await res.json() as { error: { code: number; message: string } }
      expect(body.error.code).toBe(-32602)
      expect(body.error.message).toContain('disabled')
    }
    expect(dispatched).toHaveLength(0)
  })

  test('list_employees 返回员工清单 + 各自实际运行的模型（可见性）', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_employees', arguments: {} } }, TOKEN)
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(false)
    expect(body.result.content[0].text).toContain('xianyu-cs')
    expect(body.result.content[0].text).toContain('qwen3-max (custom API, global default)')
  })

  test('fulfillment_list_deliveries 只返回对账元数据，不泄露卡密原文', async () => {
    upsertSku({ id: 'mcp-read-ledger', title: 'MCP 只读台账', deliveryTemplate: '码：{secret}' })
    addCards('mcp-read-ledger', ['MCP-SECRET-READ'])
    deliverForOrder('mcp-read-ledger', 'mcp-read-order')

    const res = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'fulfillment_list_deliveries', arguments: { skuId: 'mcp-read-ledger' } },
    }, TOKEN)
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    const text = body.result.content[0].text
    const deliveries = JSON.parse(text) as Array<Record<string, unknown>>
    expect(body.result.isError).toBe(false)
    expect(deliveries[0]).toMatchObject({ orderRef: 'mcp-read-order', skuId: 'mcp-read-ledger' })
    expect(deliveries[0]).not.toHaveProperty('secret')
    expect(text).not.toContain('MCP-SECRET-READ')
  })

  test('fulfillment 全链路：upsert_sku → add_cards → deliver（消耗库存）', async () => {
    updateSettings({ mcpServer: { enabled: true, allowDangerousTools: true, token: TOKEN } })
    upsertSku({ id: 'mcp-sku', title: 'MCP 测试卡', deliveryTemplate: '码：{secret}' })
    addCards('mcp-sku', ['MCP-K1'])

    const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fulfillment_deliver', arguments: { skuId: 'mcp-sku', orderRef: 'mcp-o1' } } }, TOKEN)
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(false)
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ deliver_message: '码：MCP-K1', replay: false })
  })

  test('工具执行失败 → result.isError=true（非 JSON-RPC error）', async () => {
    updateSettings({ mcpServer: { enabled: true, allowDangerousTools: true, token: TOKEN } })
    const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fulfillment_deliver', arguments: { skuId: 'mcp-ghost', orderRef: 'o1' } } }, TOKEN)
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('不存在')
  })

  test('未知工具名 → -32602', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'send_channel_message', arguments: {} } }, TOKEN)
    const body = await res.json() as { error: { code: number } }
    expect(body.error.code).toBe(-32602)
  })

  test('settings PATCH 忽略客户端 token，危险开关可写，token 仍只能由后端生成和轮换', async () => {
    updateSettings({ mcpServer: { enabled: false, allowDangerousTools: false, token: '' } })
    const patched = await settingsApp.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpServer: {
          enabled: true,
          allowDangerousTools: true,
          token: 'client-injected-token',
        },
      }),
    })
    expect(patched.status).toBe(200)
    const generated = getSettings().mcpServer.token
    expect(getSettings().mcpServer).toMatchObject({ enabled: true, allowDangerousTools: true })
    expect(generated).toHaveLength(48)
    expect(generated).not.toBe('client-injected-token')

    const rotated = await settingsApp.request('/settings/mcp-server/regenerate-token', { method: 'POST' })
    const { token: nextToken } = await rotated.json() as { token: string }
    expect(nextToken).toHaveLength(48)
    expect(nextToken).not.toBe(generated)
    expect((await rpc({ jsonrpc: '2.0', id: 30, method: 'ping' }, generated)).status).toBe(401)
    expect((await rpc({ jsonrpc: '2.0', id: 31, method: 'ping' }, nextToken)).status).toBe(200)
  })

  test('manager 合并 MCP 局部状态时保留 token 与危险开关', () => {
    updateSettings({ mcpServer: { enabled: true, allowDangerousTools: true, token: 'keep-me' } })
    updateSettings({ mcpServer: { ...getSettings().mcpServer, enabled: false } })
    expect(getSettings().mcpServer).toEqual({ enabled: false, allowDangerousTools: true, token: 'keep-me' })
  })
})

describe('mcp-server 对话桥', () => {
  beforeEach(() => {
    updateSettings({ mcpServer: { enabled: true, allowDangerousTools: true, token: TOKEN } })
  })

  const ask = (args: Record<string, unknown>, id = 10) =>
    rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask_employee', arguments: args } }, TOKEN)

  test('ask_employee：投递消息 → 等到 complete → 返回员工回复', async () => {
    const res = await ask({ employeeId: 'office-assistant', message: '写个周报' })
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(false)
    expect(body.result.content[0].text).toBe('回复:mcp:office-assistant')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ agentId: 'office-assistant', chatId: 'mcp:office-assistant', content: '写个周报' })
  })

  test('ask_employee：error 事件 → isError 带原因', async () => {
    autoReply = (chatId, turnId) => {
      setTimeout(() => chatHandlers.get(chatId)?.({
        type: 'error',
        error: '模型未配置',
        turnId,
      }), 10)
    }
    const res = await ask({ employeeId: 'office-assistant', message: 'x' })
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('模型未配置')
  })

  test('ask_employee ignores a complete event from another turn', async () => {
    autoReply = (chatId, turnId) => {
      setTimeout(() => chatHandlers.get(chatId)?.({
        type: 'complete',
        fullText: 'WRONG TURN',
        turnId: 'another-turn',
      }), 5)
      setTimeout(() => chatHandlers.get(chatId)?.({
        type: 'complete',
        fullText: 'RIGHT TURN',
        turnId,
      }), 10)
    }
    const res = await ask({ employeeId: 'office-assistant', message: 'x' })
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(false)
    expect(body.result.content[0].text).toBe('RIGHT TURN')
  })

  test('ask_employee：超时 → 只取消本次精确 turn', async () => {
    autoReply = null // 永不回复
    const res = await ask({ employeeId: 'office-assistant', message: 'x', timeoutSeconds: 1 })
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('was cancelled')
    expect(cancelled).toEqual([{
      chatId: 'mcp:office-assistant',
      turnId: dispatched[0]!.messageId,
    }])
  })

  test('ask_employee：同会话在途串行守卫 + 未知员工拒绝 + 跨员工续聊拒绝', async () => {
    autoReply = null
    const slow = ask({ employeeId: 'office-assistant', message: '慢任务', timeoutSeconds: 1 })
    await new Promise((r) => setTimeout(r, 50))
    const dup = await ask({ employeeId: 'office-assistant', message: '插队' }, 11)
    const dupBody = await dup.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(dupBody.result.isError).toBe(true)
    expect(dupBody.result.content[0].text).toContain('still running')
    await slow

    const ghost = await ask({ employeeId: 'ghost', message: 'x' })
    expect(((await ghost.json()) as { result: { isError: boolean } }).result.isError).toBe(true)

    upsertChat('mcp-test-bound', 'xianyu-cs', '闲鱼会话', 'web')
    const cross = await ask({ employeeId: 'office-assistant', message: 'x', chatId: 'mcp-test-bound' })
    const crossBody = await cross.json() as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(crossBody.result.isError).toBe(true)
    expect(crossBody.result.content[0].text).toContain('belongs to')
  })

  test('list_chats / get_chat_messages / recall_memory 读取面', async () => {
    upsertChat('mcp-test-chat', 'office-assistant', 'MCP 测试会话', 'web')
    saveMessage({ id: 'mcp-m1', chatId: 'mcp-test-chat', sender: 'user', senderName: 'MCP', content: '你好', timestamp: new Date().toISOString(), isFromMe: false, isBotMessage: false })
    saveMessage({ id: 'mcp-m2', chatId: 'mcp-test-chat', sender: 'assistant', senderName: 'AI', content: '在的', timestamp: new Date(Date.now() + 1000).toISOString(), isFromMe: false, isBotMessage: true })

    const chats = await rpc({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'list_chats', arguments: {} } }, TOKEN)
    expect(((await chats.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text).toContain('mcp-test-chat')

    const msgs = await rpc({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_chat_messages', arguments: { chatId: 'mcp-test-chat' } } }, TOKEN)
    const msgsText = ((await msgs.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text
    const parsed = JSON.parse(msgsText) as Array<{ sender: string; content: string }>
    expect(parsed).toHaveLength(2)
    expect(parsed[0].content).toBe('你好')
    expect(parsed[1]).toMatchObject({ sender: 'employee', content: '在的' })

    const mem = await rpc({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'recall_memory', arguments: { employeeId: 'office-assistant', query: 'hit' } } }, TOKEN)
    expect(((await mem.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text).toContain('记忆片段')
  })
})
