// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { health } from './health.ts'
import { createAgentsRoutes } from './agents.ts'
import { createMessagesRoutes } from './messages.ts'
import { createSkillsRoutes } from './skills.ts'
import { createMemoryRoutes } from './memory.ts'
import { createTasksRoutes } from './tasks.ts'
import { createSystemRoutes } from './system.ts'
import { createBrowserProfilesRoutes } from './browser-profiles.ts'
import { createLogsRoutes } from './logs.ts'
import { createChannelsRoutes } from './channels.ts'
import { createRegistryRoutes } from './registry.ts'
import { createWebhooksRoutes } from './webhooks.ts'
import { createSettingsRoutes } from './settings.ts'
import { createIngestRoutes } from './ingest.ts'
import { createAuthRoutes } from './auth.ts'
import { createCreditRoutes } from './credit.ts'
import { createProxyRoutes } from './proxy.ts'
import { createRealtimeRoutes } from './realtime.ts'
import { createCommercialRoutes } from './commercial.ts'
import { createCommercialAuthRoutes } from './commercial-auth.ts'
import { createDiagnosticRoutes } from './diagnostic.ts'
import { createVoiceRoutes } from './voice.ts'
import { createKnowledgeRoutes } from './knowledge.ts'
import { createEvolutionRoutes } from './evolution.ts'
import { createMediaRoutes } from './media.ts'
import { createFeedbackRoutes } from './feedback.ts'
import { createFulfillmentRoutes } from './fulfillment.ts'
import { createMcpServerRoutes } from './mcp-server.ts'
import { createWorkflowsRoutes } from './workflows.ts'
import { createAgentOpsRoutes } from './agentops.ts'
import { resolveRuntimeModelConfig } from '../agent/runtime-model.ts'
import type { AgentManager, AgentQueue } from '../agent/index.ts'
import type { EventBus } from '../events/index.ts'
import type { MessageRouter, ChannelManager } from '../channel/index.ts'
import type { SkillsLoader } from '../skills/index.ts'
import type { RegistryManager } from '../skills/index.ts'
import type { MemoryManager } from '../memory/index.ts'
import type { MemoryIndexer } from '../memory/index.ts'
import type { Scheduler } from '../scheduler/index.ts'
import type { BrowserManager } from '../browser/index.ts'
import type { RealtimeHub } from '../realtime/hub.ts'
import { getEnv } from '../config/env.ts'
import {
  createLocalApiAuth,
  isStandaloneLocalApiDevelopmentRuntime,
  LOCAL_API_TICKET_ENDPOINT,
  LOCAL_API_TOKEN_HEADER,
} from '../middleware/local-auth.ts'

interface AppDeps {
  agentManager: AgentManager
  agentQueue: AgentQueue
  eventBus: EventBus
  router: MessageRouter
  channelManager: ChannelManager
  skillsLoader: SkillsLoader
  registryManager: RegistryManager
  memoryManager: MemoryManager
  memoryIndexer: MemoryIndexer | null
  scheduler: Scheduler
  browserManager: BrowserManager
  realtimeHub: RealtimeHub
}

export function createApp(deps: AppDeps) {
  const { agentManager, agentQueue, eventBus, router, channelManager, skillsLoader, registryManager, memoryManager, memoryIndexer, scheduler, browserManager, realtimeHub } = deps
  const app = new Hono()
  const localApiAuth = createLocalApiAuth(getEnv().XiaoJuClaw_LOCAL_API_TOKEN, {
    // Source runs use Bun directly; compiled sidecars fail closed if Tauri did
    // not inject a token, so the no-token path cannot silently reach release.
    allowUnauthenticatedWhenTokenMissing: isStandaloneLocalApiDevelopmentRuntime(),
  })

  // CORS — allow Vite dev server + Tauri WebView
  app.use('/*', cors({
    origin: [
      'http://localhost:5173',
      `http://localhost:${getEnv().PORT}`,
      'tauri://localhost',        // macOS Tauri WebView
      'http://tauri.localhost',   // Windows Tauri WebView
      'https://tauri.localhost',  // Linux Tauri WebView
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowHeaders: ['Content-Type', LOCAL_API_TOKEN_HEADER],
  }))

  // Release sidecar requests are authenticated by a per-app token from Tauri.
  // This middleware is deliberately scoped to /api: root /mcp retains its
  // independent Bearer gate and dangerous-tools policy.
  app.use('/api/*', localApiAuth.middleware)
  app.post(LOCAL_API_TICKET_ENDPOINT, localApiAuth.issueRealtimeTicket)

  // Mount routes
  app.route('/api', health)
  app.route('/api', createRealtimeRoutes(realtimeHub))
  app.route('/api', createAgentsRoutes(agentManager, skillsLoader))
  app.route('/api', createMessagesRoutes(agentManager, agentQueue, router))
  app.route('/api', createSkillsRoutes(skillsLoader, agentManager))
  app.route('/api', createMemoryRoutes(memoryManager, agentManager, memoryIndexer))
  app.route('/api', createTasksRoutes(scheduler, agentManager, agentQueue))
  app.route('/api', createSystemRoutes(agentManager, eventBus, router))
  app.route('/api', createChannelsRoutes(channelManager))
  app.route('/api', createBrowserProfilesRoutes(agentManager, browserManager))
  app.route('/api', createRegistryRoutes(registryManager))
  app.route('/api', createLogsRoutes())
  app.route('/api', createWebhooksRoutes(channelManager))
  app.route('/api', createSettingsRoutes())
  app.route('/api', createIngestRoutes()) // [XJC-PATCH] T-G6 本地文档摄取配置
  // [XJC] 通用能力对齐底座：语音（T-A2）+ 知识库（T-A1），懒单例服务，无需注入 deps
  app.route('/api', createVoiceRoutes())
  app.route('/api', createKnowledgeRoutes())
  // [XJC] 自主进化引擎状态
  app.route('/api', createEvolutionRoutes())
  // [XJC] 用户反馈信号（👍/👎）：落库 + 喂进化引擎质量信号
  app.route('/api', createFeedbackRoutes())
  // [XJC] 卡密库（闲鱼虚拟商品发货）：商品/库存/发货台账管理
  app.route('/api', createFulfillmentRoutes())
  // [XJC] 工作流（通用/垂直编排）：列表/建改/运行/历史
  app.route('/api', createWorkflowsRoutes())
  // [XJC-PATCH] Local-only execution traces; protected by the same /api token gate.
  app.route('/api', createAgentOpsRoutes())
  // [XJC] 内置 MCP Server（对接 Cursor，路线 A）：默认关、Bearer 鉴权，挂根路径 /mcp。
  // 对话桥复用 web 消息同款链路（router.handleInbound + EventBus complete/error）。
  app.route('/', createMcpServerRoutes({
    listEmployees: () => agentManager.getAgents().map((a) => {
      // 与 runtime 同一条解析链（员工覆盖→全局默认），未配置时给出可读原因
      const resolution = resolveRuntimeModelConfig({ agentModel: a.model ?? null })
      const model = resolution.config
        ? `${resolution.config.modelId} (${resolution.config.source === 'custom' ? 'custom API' : 'builtin'}${a.model ? ', employee-specific' : ', global default'})`
        : null
      return { id: a.id, name: a.name ?? a.id, model }
    }),
    hasEmployee: (agentId) => agentManager.getAgent(agentId) !== undefined,
    dispatchMessage: ({ agentId, chatId, messageId, content }) => {
      router.handleInbound({
        id: messageId,
        chatId,
        sender: 'user',
        senderName: 'MCP',
        content,
        timestamp: new Date().toISOString(),
        isGroup: false,
        agentId,
      })
    },
    subscribeChatEvents: (chatId, handler) =>
      eventBus.subscribe({ chatId, types: ['complete', 'error'] }, (event) => {
        if (event.type === 'complete' && event.turnId) {
          handler({
            type: 'complete',
            fullText: event.fullText,
            turnId: event.turnId,
            cancelled: event.cancelled,
          })
        } else if (event.type === 'error' && event.turnId) {
          handler({ type: 'error', error: event.error, turnId: event.turnId })
        }
      }),
    recallMemory: (agentId, query, limit) =>
      memoryManager.recallMemory(agentId, query, limit).map((h) => ({ snippet: h.snippet, source: h.fileType })),
    cancelTurn: (chatId, turnId) => agentQueue.cancel(chatId, turnId),
  }))
  // [XJC] 媒体生成（T-B7）：状态 + 服务商一键分发
  app.route('/api', createMediaRoutes())
  // Commercial auth must mount BEFORE upstream auth to override POST /auth/login and GET /auth/user
  app.route('/api', createCommercialAuthRoutes())
  app.route('/api', createAuthRoutes())
  app.route('/api', createCreditRoutes())
  app.route('/api', createProxyRoutes())
  // Commercial isolation layer — device, templates, chat proxy, remote staff seeding
  app.route('/api', createCommercialRoutes({ agentManager, registryManager }))
  // Commercial diagnostic — for after-sales support
  app.route('/api', createDiagnosticRoutes())

  return app
}
