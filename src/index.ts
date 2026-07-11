// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// Remove CLAUDECODE env var to prevent inherited Claude-specific session detection
delete process.env.CLAUDECODE

import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { websocket } from 'hono/bun'
import { loadEnv, getEnv, resolvePathInput } from './config/index.ts'
import { initLogger, getLogger } from './logger/index.ts'
import { initDatabase } from './db/index.ts'
import { EventBus } from './events/index.ts'
import { AgentManager, AgentQueue, PromptBuilder, AgentRouter, HooksManager, SecretsManager } from './agent/index.ts'
import { configureSkillsMcpRuntime } from './agent/skills-mcp.ts'
import { configureEmployeeMcpRuntime } from './agent/employee-mcp.ts'
import { configureWorkflowRuntime } from './workflow/runner.ts'
import { reconcileInterruptedRuns, seedBuiltinWorkflows } from './workflow/store.ts'
import { runSingleCompletion } from './agent/persona-optimizer.ts'
import { MessageRouter, ChannelManager } from './channel/index.ts'
import { registerChannelOutboundService } from './channel/outbound-service.ts'
import { SkillsLoader, SkillsWatcher, RegistryManager } from './skills/index.ts'
import { MemoryManager, MemoryIndexer } from './memory/index.ts'
import { ensureDistillTasks } from './memory/distill-scheduler.ts'
import { ensureChannelDigestTask, ensureIngestTask } from './ingest/ingest-scheduler.ts'
import { initEvolutionBridge } from './evolution/service.ts'
import { Scheduler } from './scheduler/index.ts'
import { BrowserManager } from './browser/index.ts'
import { createApp } from './routes/index.ts'
import { RealtimeHub } from './realtime/hub.ts'
import { ensureBunRuntime } from './agent/runtime.ts'
import { resetShellEnvCache } from './utils/shell-env.ts'
import { ensurePortableToolsInPath, getInjectedPortablePaths } from './config/portable-tools.ts'
import { isPortableMode } from './config/paths.ts'
import { reconcileInterruptedAgentOpsTraces } from './agentops/store.ts'

async function main() {
  // 1. Load environment variables
  let env: ReturnType<typeof getEnv>
  try {
    loadEnv()
    env = getEnv()
  } catch (err) {
    console.error('[STARTUP] Step 1 failed: load env', err)
    throw err
  }

  // 2. Initialize logger
  const logger = initLogger()
  logger.info('XiaoJuClaw starting...')

  // 2b. Pre-extract embedded Bun runtime (before any agent code runs)
  try {
    const bunRuntimePath = ensureBunRuntime()
    if (bunRuntimePath) {
      logger.info({ path: bunRuntimePath }, 'Bun runtime ready (embedded)')
      resetShellEnvCache()  // Ensure embedded Bun dir is picked up by getShellEnv()
    } else {
      logger.info('Using system Bun runtime')
    }
  } catch (err) {
    logger.warn({ err }, '[STARTUP] Step 2b failed: ensure Bun runtime, continuing without embedded runtime')
  }

  // 2c. [XJC-PATCH] T-E4: 静默启用便携工具 —— health.ts 模块加载期 env 尚未就绪会静默失败，
  // 此处 env/logger 均已初始化，兜底注入并汇报（manifest 版本告警在函数内部走 warn）
  try {
    ensurePortableToolsInPath()
    const injected = getInjectedPortablePaths()
    logger.info(
      { category: 'portable-tools', portable: isPortableMode(), paths: injected },
      injected.length > 0
        ? `Portable tools enabled in PATH (${injected.length} dir(s)): ${injected.join(', ')}`
        : 'Portable tools: no tool directories found to inject',
    )
    resetShellEnvCache()
  } catch (err) {
    logger.warn({ err }, '[STARTUP] Step 2c failed: enable portable tools in PATH')
  }

  // 3. Initialize database
  try {
    initDatabase()
    const interruptedTraces = reconcileInterruptedAgentOpsTraces()
    if (interruptedTraces > 0) {
      logger.warn({ interruptedTraces }, 'Recovered interrupted execution traces')
    }
    logger.info('Database initialized')
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 3 failed: init database')
    throw err
  }

  // 4. Create EventBus
  const eventBus = new EventBus()
  const realtimeHub = new RealtimeHub(eventBus)

  // 4b. Initialize browser subsystem and ensure the default managed profile exists
  const browserManager = new BrowserManager()
  try {
    browserManager.ensureDefaultProfile()
    logger.info('Browser manager initialized')
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 4b failed: init browser manager')
    throw err
  }

  // 5. Create SkillsLoader and SkillsWatcher
  let skillsLoader: SkillsLoader
  try {
    skillsLoader = new SkillsLoader()
    logger.info({ count: skillsLoader.loadAllSkills().length }, 'Skills loaded')
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 5 failed: load skills')
    throw err
  }

  let agentManagerRef: AgentManager | null = null
  const skillsWatcher = new SkillsWatcher(skillsLoader, {
    onReload: (skills) => {
      logger.info({ count: skills.length }, 'Skills hot-reloaded')
    },
  })
  skillsWatcher.start()

  // 5b. Create RegistryManager
  const registryManager = new RegistryManager(skillsLoader)

  // 6. Create MemoryManager and MemoryIndexer
  let memoryManager: MemoryManager
  try {
    memoryManager = new MemoryManager()
    logger.info('Memory manager initialized')
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 6 failed: init memory manager')
    throw err
  }
  let memoryIndexer: MemoryIndexer | null = null
  try {
    memoryIndexer = new MemoryIndexer()
    memoryIndexer.initTable()
    memoryIndexer.rebuildIndex()
    memoryManager.attachIndexer(memoryIndexer)
    logger.info('Memory search index built')
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'FTS5 index init failed, search unavailable')
  }

  // 7. Create SecretsManager
  const secretsManager = new SecretsManager()
  try {
    secretsManager.loadFromEnv()
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 7 failed: init secrets manager')
    throw err
  }

  // 8. Create HooksManager
  const hooksManager = new HooksManager()

  // 9. Create PromptBuilder, AgentRouter
  const promptBuilder = new PromptBuilder(skillsLoader, memoryManager)
  const agentRouter = new AgentRouter()

  // 10. Create AgentManager (inject all new modules)
  let agentManager: AgentManager
  try {
    agentManager = new AgentManager(
      eventBus,
      promptBuilder,
      hooksManager,
      agentRouter,
      secretsManager,
      skillsLoader,
      memoryManager,
      browserManager,
    )
    await agentManager.loadAgents()
    agentManagerRef = agentManager
    logger.info({ count: agentManager.getAgents().length }, 'Agents loaded')
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 10 failed: init agent manager / load agents')
    throw err
  }

  // 10b. [XJC] 对话式技能自管理工具依赖装配（skills-mcp 运行时单例）
  configureSkillsMcpRuntime({ agentManager, skillsLoader, registryManager })
  // 10c. [XJC] 对话式建员工工具依赖装配（employee-mcp 运行时单例）
  configureEmployeeMcpRuntime({ agentManager })

  // 11. Create AgentQueue
  const agentQueue = new AgentQueue(agentManager)

  // 12. Create MessageRouter (with MemoryManager)
  const router = new MessageRouter(agentManager, agentQueue, eventBus, memoryManager, skillsLoader)

  // 13. Create ChannelManager and load channels
  let channelManager: ChannelManager
  try {
    channelManager = new ChannelManager(router, (msg) => router.handleInbound(msg), eventBus)
    await channelManager.seedFromEnv(env)     // Migrate from env on first launch
    await channelManager.loadFromDatabase()   // Load and connect all enabled channels
    registerChannelOutboundService(channelManager)
    logger.info('Channels loaded')
  } catch (err) {
    logger.error({ err }, '[STARTUP] Step 13 failed: init channel manager')
    throw err
  }

  // 14. Create Scheduler and start
  const scheduler = new Scheduler(agentQueue, agentManager, eventBus)
  scheduler.start()
  logger.info('Task scheduler started')

  // [XJC] 工作流引擎装配：逐步执行走 web 消息同款链路（handleInbound + complete/error 桥）
  // + 首启预置内置流水线（垂直 3 + 通用 1；用户删过不复活）
  try {
    configureWorkflowRuntime({
      hasEmployee: (id) => Boolean(agentManager.getAgent(id)),
      dispatchMessage: ({ agentId, chatId, messageId, content, agentOps }) => {
        router.handleInbound({
          id: messageId,
          chatId,
          sender: 'user',
          senderName: '工作流',
          content,
          timestamp: new Date().toISOString(),
          isGroup: false,
          agentId,
          agentOps,
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
            handler({
              type: 'error',
              error: event.error,
              turnId: event.turnId,
              errorCode: event.errorCode,
              stopReason: event.stopReason,
            })
          }
        }),
      // llm 节点：沿用工作流员工的显式模型；未显式配置才继承全局激活模型。
      runLlm: (agentId, prompt, context) => {
        const employee = agentManager.getAgent(agentId)
        if (!employee) throw new Error(`执行员工「${agentId}」不存在`)
        return runSingleCompletion(
          '你是工作流中的一个执行节点。只输出本步骤要求的成果本体，不要寒暄、不要解释过程。',
          prompt,
          {
            agentModel: employee.config.hasExplicitModel ? employee.config.model : undefined,
            agentId,
            purpose: 'workflow_llm',
            signal: context?.signal,
            agentOps: context
              ? {
                  traceId: context.traceId,
                  spanId: context.spanId,
                  workflowId: context.workflowId,
                  workflowRunId: context.workflowRunId,
                  internal: true,
                }
              : undefined,
          },
        )
      },
      cancelTurn: (chatId, turnId) => agentQueue.cancel(chatId, turnId),
    })
    const interruptedRuns = reconcileInterruptedRuns()
    if (interruptedRuns > 0) {
      logger.warn({ interruptedRuns }, 'Recovered interrupted workflow runs as failed')
    }
    seedBuiltinWorkflows()
  } catch (err) {
    logger.warn({ err }, 'Workflow engine init failed (feature degrades silently)')
  }

  // [XJC-PATCH] T-G1 记忆自动蒸馏：幂等种子日纪要/周蒸馏系统任务（每员工，活跃门控+错峰）
  ensureDistillTasks({ listAgentIds: () => agentManager.getAgents().map((a) => a.id) })

  ensureIngestTask({ hasAgent: (id) => Boolean(agentManager.getAgent(id)) }) // [XJC-PATCH] T-G6 本地文档摄取轮询（src/ingest/）
  ensureChannelDigestTask({ hasAgent: (id) => Boolean(agentManager.getAgent(id)) }) // [XJC-PATCH] G6.2 渠道消息日摘要（23:40，先于 G1 蒸馏）

  // [XJC] 自主进化引擎桥：事件驱动零 token 学习（settings.evolution.enabled 开关门控）
  // + 启动预热各员工 hint 缓存（重启后首轮对话即有经验提示）
  try {
    initEvolutionBridge(eventBus, () => agentManager.getAgents().map((a) => a.id))
  } catch (err) {
    logger.warn({ err }, 'Evolution bridge init failed (feature degrades silently)')
  }

  // 16. Startup memory maintenance: log cleanup + snapshot restore
  for (const agentConfig of agentManager.getAgents()) {
    memoryManager.pruneOldLogs(agentConfig.id, 30)
    memoryManager.restoreFromSnapshot(agentConfig.id)
  }

  // 17. Create HTTP server
  const app = createApp({ agentManager, agentQueue, eventBus, router, channelManager, skillsLoader, registryManager, memoryManager, memoryIndexer, scheduler, browserManager, realtimeHub })

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      fetch: (request, server) => app.fetch(request, server),
      port: env.PORT,
      hostname: '127.0.0.1',  // Listen on localhost only to avoid Windows firewall prompts
      idleTimeout: 255,       // Max idle timeout (seconds) for SSE/long-running requests
      websocket,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Bun may emit different messages depending on platform:
    //   "Failed to start server. Is port X in use?" (Windows)
    //   "address already in use" (Unix)
    const isPortConflict = msg.includes('address already in use') || msg.includes('Failed to start server')
    if (isPortConflict) {
      logger.error({ port: env.PORT }, `Port ${env.PORT} is already in use`)
      console.error(`[PORT_CONFLICT] Port ${env.PORT} is already in use`)
      process.exit(1)
    }
    throw err
  }

  logger.info({ port: env.PORT }, `HTTP server started: http://localhost:${env.PORT}`)
  logger.info('XiaoJuClaw ready')

  // 18. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...')
    await channelManager.disconnectAll()
    await browserManager.shutdown().catch(() => {})
    skillsWatcher.stop()
    scheduler.stop()
    realtimeHub.destroy()
    server.stop()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Windows: handle process exit event as a last-resort cleanup.
  // On Windows, SIGTERM/SIGINT may not fire when the parent Tauri process
  // is killed via taskkill /F. The 'exit' event is more reliable for cleanup.
  if (process.platform === 'win32') {
    process.on('exit', () => {
      try { server.stop() } catch {}
    })
  }
}

function writeStartupCrashLog(errorText: string): void {
  try {
    const baseDir = process.env.DATA_DIR
      ? resolvePathInput(process.env.DATA_DIR)
      : resolve(tmpdir(), 'XiaoJuClaw-data')
    mkdirSync(baseDir, { recursive: true })
    const logPath = resolve(baseDir, 'startup-crash.log')
    const line = `[${new Date().toISOString()}] ${errorText}\n`
    appendFileSync(logPath, line, 'utf-8')
  } catch {
    // best-effort only
  }
}

main().catch((err) => {
  const errorText = err instanceof Error ? err.stack ?? err.message : String(err)
  const context = [
    `PORT=${process.env.PORT ?? '(unset)'}`,
    `DATA_DIR=${process.env.DATA_DIR ?? '(unset)'}`,
    `TEMP=${process.env.TEMP ?? '(unset)'}`,
    `BUN_TMPDIR=${process.env.BUN_TMPDIR ?? '(unset)'}`,
  ].join(' ')
  console.error('[STARTUP] Fatal error:', errorText)
  writeStartupCrashLog(`[context: ${context}] ${errorText}`)
  process.exit(1)
})
