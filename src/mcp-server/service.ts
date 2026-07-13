// [XJC] 内置 MCP Server（路线 A：让 Cursor 等 MCP 客户端操纵 XiaoJuClaw）
//
// 定位：模型在客户端侧（Cursor 的高级模型），XiaoJuClaw 提供工具与数据。
// 传输：streamable HTTP（POST /mcp 单端点，JSON 应答，无会话/无 SSE——tools-only 用不上）。
// 协议面刻意做小：initialize / notifications/* / ping / tools/list / tools/call，
// 其余一律 -32601。不声明 resources/prompts 能力（Cursor 对未声明能力不会探测）。
//
// 安全模型（用户明确要求"开关，不直接开放"）：
//   1. settings.mcpServer.enabled 默认 false，路由层每请求检查；
//   2. Bearer token 鉴权（开启时自动生成，settings 路由负责），防本机其他进程盗用；
//   3. 默认只暴露只读工具；ask/workflow/卡密库写操作需用户另开 allowDangerousTools；
//   4. tools/list 与 tools/call 共用同一动态过滤结果，关闭危险开关后既不可见也不可调用。
//
// 对话桥（ask_employee）机制：router.handleInbound 投递 → EventBus 按 chatId + turnId 订阅
// complete/error 事件 → promise 桥等待；超时精确取消本次排队或运行中的 turn。
// MCP 会话用 `mcp:` 前缀 chatId（无渠道认领 → 不会外发），在客户端聊天列表可见，用户可审计。

import { randomUUID } from 'node:crypto'
import { getSettings } from '../settings/manager.ts'
import { getKnowledgeService } from '../knowledge/service.ts'
import { getChats, getMessages, getDatabase } from '../db/index.ts'
import { abortRegistry } from '../agent/abort-registry.ts'
import {
  getRun as getWorkflowRun,
  getWorkflow,
  listWorkflows,
  type WorkflowBudgets,
} from '../workflow/store.ts'
import { startWorkflowRun, SKIP_MARKER } from '../workflow/runner.ts'
import {
  addCards,
  deliverForOrder,
  listDeliveries,
  listSkus,
  upsertSku,
  FulfillmentError,
} from '../fulfillment/store.ts'
import { getLogger } from '../logger/index.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

const ASK_TIMEOUT_DEFAULT_S = 180
const ASK_TIMEOUT_MAX_S = 300
const ASK_MESSAGE_MAX = 32_000

// ── JSON-RPC 基础类型 ─────────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

function rpcResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

// ── 工具白名单 ────────────────────────────────────────────────────────
export interface McpServerDeps {
  /**
   * 数字员工清单（注入 AgentManager 的只读视图，避免模块级单例依赖）。
   * model = 该员工实际会用的模型（员工专属覆盖 → 全局默认的解析结果），
   * 只含 modelId/来源标签，绝不含 apiKey/baseUrl 等敏感配置。
   */
  listEmployees: () => Array<{ id: string; name: string; model: string | null }>
  /** 员工是否存在（ask_employee 前置校验） */
  hasEmployee: (agentId: string) => boolean
  /** 投递一条入站消息（复用 web 路由同款 router.handleInbound 链路） */
  dispatchMessage: (params: { agentId: string; chatId: string; messageId: string; content: string }) => void
  /** 按 chatId 订阅一次 complete/error 事件，返回退订函数 */
  subscribeChatEvents: (
    chatId: string,
    handler: (event:
      | { type: 'complete'; fullText: string; turnId: string; cancelled?: boolean }
      | { type: 'error'; error: string; turnId: string }
    ) => void,
  ) => () => void
  /** 长期记忆检索（MemoryManager.recallMemory；索引未启用时返回空） */
  recallMemory: (agentId: string, query: string, limit: number) => Array<{ snippet: string; source: string }>
  /** Queue-level exact cancellation for ask timeouts. */
  cancelTurn?: (chatId: string, turnId: string) => { queued: number; running: number } | void
}

interface ExposedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  dangerous?: boolean
  execute: (args: Record<string, unknown>) => Promise<string>
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/** 每会话同一时刻只允许一个在途 ask（完成事件无消息级关联，串行最稳） */
const askInFlight = new Set<string>()

function buildTools(deps: McpServerDeps): ExposedTool[] {
  return [
    {
      name: 'list_employees',
      description:
        'List XiaoJuClaw digital employees (id, display name, and the LLM each one runs on). '
        + 'Call this first to discover who you can delegate to via ask_employee. '
        + 'Note: ask_employee runs consume tokens of the XiaoJuClaw-side model shown here (billed to the user\'s own API key), not this client\'s model; all other tools are local and model-free.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return JSON.stringify(deps.listEmployees(), null, 2)
      },
    },
    {
      name: 'ask_employee',
      dangerous: true,
      description:
        'Send a task/question to a XiaoJuClaw digital employee and wait for the full reply. '
        + 'The employee runs with its own skills, memory and tools (office docs, e-commerce, research, Xianyu CS...). '
        + 'Conversation context persists across calls in a dedicated chat (visible in the XiaoJuClaw app). '
        + 'A timeout cancels only this exact queued/running turn; sibling turns are not affected.',
      inputSchema: {
        type: 'object',
        properties: {
          employeeId: { type: 'string', description: 'Employee id from list_employees, e.g. "office-assistant".' },
          message: { type: 'string', description: 'The task or question, in natural language.' },
          chatId: { type: 'string', description: 'Optional: continue a specific existing conversation (from list_chats). Default: a stable per-employee MCP chat.' },
          timeoutSeconds: { type: 'number', description: `Optional wait cap, default ${ASK_TIMEOUT_DEFAULT_S}, max ${ASK_TIMEOUT_MAX_S}.` },
        },
        required: ['employeeId', 'message'],
      },
      async execute(args) {
        const employeeId = str(args, 'employeeId').trim()
        const message = str(args, 'message').trim()
        if (!employeeId || !message) throw new Error('employeeId and message are required')
        if (message.length > ASK_MESSAGE_MAX) throw new Error(`message too long (>${ASK_MESSAGE_MAX} chars)`)
        if (!deps.hasEmployee(employeeId)) throw new Error(`Unknown employee: ${employeeId}. Use list_employees first.`)

        const requestedChat = str(args, 'chatId').trim()
        const chatId = requestedChat || `mcp:${employeeId}`
        // 续聊指定会话时禁止跨员工（web 路由同款 409 语义）
        if (requestedChat) {
          const bound = getDatabase().query('SELECT agent_id FROM chats WHERE chat_id = ?').get(chatId) as { agent_id?: string } | null
          if (bound?.agent_id && bound.agent_id !== employeeId) {
            throw new Error(`Chat ${chatId} belongs to employee ${bound.agent_id}, not ${employeeId}`)
          }
        }
        if (askInFlight.has(chatId)) {
          throw new Error(`Previous ask in chat ${chatId} is still running. Wait for it, or pass a different chatId.`)
        }

        const timeoutS = Math.min(Math.max(1, Number(args.timeoutSeconds) || ASK_TIMEOUT_DEFAULT_S), ASK_TIMEOUT_MAX_S)
        const turnId = randomUUID()
        askInFlight.add(chatId)
        try {
          return await new Promise<string>((resolvePromise, rejectPromise) => {
            let settled = false
            let timer: ReturnType<typeof setTimeout> | null = null
            let unsubscribe = () => {}
            const cleanup = () => {
              if (timer) {
                clearTimeout(timer)
                timer = null
              }
              try { unsubscribe() } catch { /* best-effort event cleanup */ }
            }
            const registeredUnsubscribe = deps.subscribeChatEvents(chatId, (event) => {
              if (event.turnId !== turnId) return
              if (settled) return
              settled = true
              cleanup()
              if (event.type === 'complete' && !event.cancelled) resolvePromise(event.fullText)
              else rejectPromise(new Error(event.type === 'error'
                ? `Employee run failed: ${event.error}`
                : 'Employee run cancelled'))
            })
            unsubscribe = registeredUnsubscribe
            if (settled) {
              cleanup()
              return
            }
            timer = setTimeout(() => {
              if (settled) return
              settled = true
              cleanup()
              try { deps.cancelTurn?.(chatId, turnId) } catch { /* legacy embedder fallback below */ }
              try { abortRegistry.abort(chatId, turnId) } catch { /* cancellation is best-effort */ }
              rejectPromise(new Error(
                `Timed out after ${timeoutS}s waiting for ${employeeId}; exact turn ${turnId} was cancelled.`,
              ))
            }, timeoutS * 1000)
            try {
              deps.dispatchMessage({ agentId: employeeId, chatId, messageId: turnId, content: message })
            } catch (err) {
              if (settled) return
              settled = true
              cleanup()
              rejectPromise(err)
            }
          })
        } finally {
          askInFlight.delete(chatId)
        }
      },
    },
    {
      name: 'list_chats',
      description: 'List XiaoJuClaw conversations (chat id, name, bound employee, channel, last message time). Use to find a chatId for ask_employee/get_chat_messages.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const chats = getChats().slice(0, 100).map((chat) => ({
          chatId: chat.chat_id,
          name: chat.name,
          employeeId: chat.agent_id,
          channel: chat.channel,
          lastMessageTime: chat.last_message_time,
        }))
        return JSON.stringify(chats, null, 2)
      },
    },
    {
      name: 'get_chat_messages',
      description: 'Read recent messages of a XiaoJuClaw conversation (oldest first). Use after ask_employee timeouts, or to inspect what an employee has been doing.',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string' },
          limit: { type: 'number', description: 'Max messages, default 20, max 100.' },
        },
        required: ['chatId'],
      },
      async execute(args) {
        const chatId = str(args, 'chatId').trim()
        if (!chatId) throw new Error('chatId is required')
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
        const rows = getMessages(chatId, limit).reverse().map((m) => ({
          sender: m.is_bot_message ? 'employee' : m.sender,
          content: m.content,
          timestamp: m.timestamp,
        }))
        return JSON.stringify(rows, null, 2)
      },
    },
    {
      name: 'recall_memory',
      description: "Search a digital employee's long-term memory (facts/preferences it has learned). Read-only.",
      inputSchema: {
        type: 'object',
        properties: {
          employeeId: { type: 'string' },
          query: { type: 'string' },
          limit: { type: 'number', description: 'Max hits, default 5, max 10.' },
        },
        required: ['employeeId', 'query'],
      },
      async execute(args) {
        const employeeId = str(args, 'employeeId').trim()
        const query = str(args, 'query').trim()
        if (!employeeId || !query) throw new Error('employeeId and query are required')
        const limit = Math.min(Math.max(1, Number(args.limit) || 5), 10)
        return JSON.stringify(deps.recallMemory(employeeId, query, limit), null, 2)
      },
    },
    {
      name: 'list_workflows',
      description: 'List saved XiaoJuClaw workflows (reusable multi-step pipelines: research/content/listing/reporting...) with their input parameters.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const list = listWorkflows().map((w) => ({
          id: w.id, name: w.name, description: w.description, employeeId: w.agentId,
          steps: w.steps.map((s) => s.title), inputs: w.inputs, budgets: w.budgets,
        }))
        return JSON.stringify(list, null, 2)
      },
    },
    {
      name: 'run_workflow',
      dangerous: true,
      description:
        'Start a saved XiaoJuClaw workflow (steps run sequentially on the XiaoJuClaw-side model, outputs chained). '
        + 'Returns runId immediately — poll get_workflow_run for progress and the final output. Runs consume the user\'s own model tokens.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: { type: 'string' },
          inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for the workflow inputs, e.g. {"topic": "AI glasses"}.' },
          budgets: {
            type: 'object',
            description: 'Optional per-run execution limits. Token/cost limits can overshoot by one provider call; unknown prices have partial coverage unless denied.',
            properties: {
              maxSteps: { type: 'number', minimum: 0 },
              maxTotalTokens: { type: 'number', minimum: 0 },
              maxCostUsd: { type: 'number', minimum: 0 },
              maxActiveDurationMs: { type: 'number', minimum: 0 },
              maxToolCalls: { type: 'number', minimum: 0 },
              deniedToolEffects: {
                type: 'array',
                items: { type: 'string', enum: ['read', 'network', 'write', 'execute', 'message', 'inventory', 'unknown'] },
              },
              unknownCostPolicy: { type: 'string', enum: ['allow', 'deny'] },
            },
          },
        },
        required: ['workflowId'],
      },
      async execute(args) {
        const inputs = (args.inputs && typeof args.inputs === 'object' ? args.inputs : {}) as Record<string, string>
        const budgets = args.budgets && typeof args.budgets === 'object'
          ? args.budgets as WorkflowBudgets
          : undefined
        const { run } = startWorkflowRun(str(args, 'workflowId'), inputs, { budgets })
        return JSON.stringify({ runId: run.id, status: run.status, chatId: run.chatId, note: 'Poll get_workflow_run for progress/result.' }, null, 2)
      },
    },
    {
      name: 'get_workflow_run',
      description: 'Check a XiaoJuClaw workflow run: status, step progress, and final output when finished.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
      },
      async execute(args) {
        const run = getWorkflowRun(str(args, 'runId').trim())
        if (!run) throw new Error('run not found')
        const wf = getWorkflow(run.workflowId)
        return JSON.stringify({
          runId: run.id,
          workflow: wf?.name ?? run.workflowId,
          status: run.status,
          progress: `${Math.min(run.currentStep, wf?.steps.length ?? run.currentStep)}/${wf?.steps.length ?? '?'}`,
          error: run.error,
          errorCode: run.errorCode,
          stopReason: run.stopReason,
          budgets: run.budgets,
          usage: run.usage,
          traceId: run.traceId,
          final_output: run.status === 'success' ? run.outputs.filter((o) => o !== SKIP_MARKER).at(-1) : undefined,
        }, null, 2)
      },
    },
    {
      name: 'search_knowledge',
      description: "Full-text search the user's local XiaoJuClaw knowledge base. Returns hits with source doc titles and snippets.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords.' },
          topK: { type: 'number', description: 'Max hits, default 8, max 20.' },
        },
        required: ['query'],
      },
      async execute(args) {
        const query = str(args, 'query').trim()
        if (!query) throw new Error('query is required')
        const topK = Math.min(Math.max(1, Number(args.topK) || 8), 20)
        const hits = await getKnowledgeService().search(query, topK)
        return JSON.stringify(hits.map((h) => ({ docTitle: h.docTitle, snippet: h.snippet, score: h.score })), null, 2)
      },
    },
    {
      name: 'fulfillment_list_stock',
      description: 'List virtual-goods SKUs with available/delivered stock counts (Xianyu auto-delivery inventory).',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return JSON.stringify(listSkus().map((s) => ({ id: s.id, title: s.title, available: s.available, delivered: s.delivered })), null, 2)
      },
    },
    {
      name: 'fulfillment_list_deliveries',
      description: 'List recent virtual-goods delivery ledger entries for reconciliation. Card secrets are always omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          skuId: { type: 'string', description: 'Optional SKU filter.' },
          limit: { type: 'number', description: 'Max entries, default 20, max 100.' },
        },
      },
      async execute(args) {
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
        const skuId = str(args, 'skuId') || undefined
        const deliveries = listDeliveries({ skuId, limit }).map((delivery) => ({
          orderRef: delivery.orderRef,
          skuId: delivery.skuId,
          skuTitle: delivery.skuTitle,
          deliveredAt: delivery.deliveredAt,
        }))
        return JSON.stringify(deliveries, null, 2)
      },
    },
    {
      name: 'fulfillment_upsert_sku',
      dangerous: true,
      description: 'Create or update a virtual-goods SKU (title + optional delivery template with {secret} placeholder).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'SKU id (lowercase letters/digits/_/-).' },
          title: { type: 'string' },
          deliveryTemplate: { type: 'string', description: 'Optional. Use {secret} where the card code goes.' },
        },
        required: ['id', 'title'],
      },
      async execute(args) {
        const sku = upsertSku({ id: str(args, 'id'), title: str(args, 'title'), deliveryTemplate: str(args, 'deliveryTemplate') || undefined })
        return `SKU saved: ${sku.title} (id: ${sku.id})`
      },
    },
    {
      name: 'fulfillment_add_cards',
      dangerous: true,
      description: 'Import card codes into a SKU (one per unit of stock). Duplicates already in the SKU are skipped.',
      inputSchema: {
        type: 'object',
        properties: {
          skuId: { type: 'string' },
          secrets: { type: 'array', items: { type: 'string' }, description: 'Card codes / accounts, one per unit.' },
        },
        required: ['skuId', 'secrets'],
      },
      async execute(args) {
        const secrets = Array.isArray(args.secrets) ? args.secrets.filter((s): s is string => typeof s === 'string') : []
        const r = addCards(str(args, 'skuId'), secrets)
        return `Imported ${r.added} codes, skipped ${r.skipped} duplicates.`
      },
    },
    {
      name: 'fulfillment_deliver',
      dangerous: true,
      description:
        'Deliver one virtual good for a PAID order: atomically claims a card and returns the message to send to the buyer. '
        + 'Consumes stock. Idempotent per orderRef (same order never gets a second card). Out of stock raises an error — never invent a code.',
      inputSchema: {
        type: 'object',
        properties: {
          skuId: { type: 'string' },
          orderRef: { type: 'string', description: 'Unique order id (idempotency key).' },
        },
        required: ['skuId', 'orderRef'],
      },
      async execute(args) {
        const result = deliverForOrder(str(args, 'skuId'), str(args, 'orderRef'))
        return JSON.stringify({ deliver_message: result.message, replay: result.replay }, null, 2)
      },
    },
  ]
}

// ── 调度器 ────────────────────────────────────────────────────────────
export class McpServerService {
  private tools: ExposedTool[]

  constructor(deps: McpServerDeps) {
    this.tools = buildTools(deps)
  }

  isEnabled(): boolean {
    return getSettings().mcpServer.enabled
  }

  getToken(): string {
    return getSettings().mcpServer.token
  }

  private getAvailableTools(allowDangerousTools: boolean): ExposedTool[] {
    return allowDangerousTools ? this.tools : this.tools.filter((tool) => !tool.dangerous)
  }

  /**
   * 处理一条 JSON-RPC 消息。返回 null 表示无需应答（notification）。
   * 鉴权由路由层完成，进到这里的消息都已通过。
   */
  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message.id ?? null
    const method = message.method ?? ''
    const allowDangerousTools = getSettings().mcpServer.allowDangerousTools
    const availableTools = this.getAvailableTools(allowDangerousTools)

    // notification（无 id）：接受但不应答；未知 notification 也静默（spec 容忍）
    if (message.id === undefined || message.id === null) {
      return null
    }

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'xiaojuclaw', version: '1.0.0' },
          instructions: allowDangerousTools
            ? 'XiaoJuClaw local assistant bridge. Read local employees, chats, memory, workflows, knowledge and fulfillment status. Dangerous tools are enabled: ask_employee and run_workflow can consume the user\'s model tokens, while fulfillment write tools can change or consume real inventory. Only use them with explicit user intent.'
            : 'XiaoJuClaw local assistant bridge in read-only mode. Read local employees, chats, memory, workflows, knowledge and fulfillment status. Task execution, workflow runs and fulfillment writes are disabled until the user enables dangerous MCP tools in XiaoJuClaw Settings.',
        })

      case 'ping':
        return rpcResult(id, {})

      case 'tools/list':
        return rpcResult(id, {
          tools: availableTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        })

      case 'tools/call': {
        const params = message.params ?? {}
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = availableTools.find((t) => t.name === name)
        if (!tool) return rpcError(id, -32602, `Unknown or disabled tool: ${name}`)
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        try {
          const text = await tool.execute(args)
          getLogger().info({ tool: name, category: 'mcp-server' }, 'MCP tool call ok')
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false })
        } catch (err) {
          // 工具执行失败按 MCP 规范放 result.isError（协议层错误才用 JSON-RPC error）
          const msg = err instanceof FulfillmentError || err instanceof Error ? err.message : String(err)
          getLogger().warn({ tool: name, error: msg, category: 'mcp-server' }, 'MCP tool call failed')
          return rpcResult(id, { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true })
        }
      }

      default:
        return rpcError(id, -32601, 'Method not found')
    }
  }
}
