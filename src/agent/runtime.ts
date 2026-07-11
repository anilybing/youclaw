// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { createAgentSession, createCodingTools, createFindTool, createGrepTool, createLsTool, SessionManager, AuthStorage, DefaultResourceLoader, getAgentDir } from '@mariozechner/pi-coding-agent'
import type { AgentSession, AgentSessionEvent, SessionEntry, ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { AssistantMessage } from '@mariozechner/pi-ai'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { writeModelInvocationLog } from '../logger/model-invocation.ts'
import { deleteSession, getMessages, getSessionEntry, saveSession } from '../db/index.ts'
import type { EventBus } from '../events/index.ts'
import { ErrorCode } from '../events/types.ts'
import type { AgentToolUse } from '../events/types.ts'
import type { PromptBuilder } from './prompt-builder.ts'
import type { HooksManager } from './hooks.ts'
import { buildParsedDocumentsPrompt, ingestDocumentAttachments } from './document-mcp.ts'
import { preprocessAttachments } from './document-converter.ts'
import { abortRegistry } from './abort-registry.ts'
import { getAuthToken } from '../routes/auth.ts'
import { resolvePiModel } from './model-resolver.ts'
import type { BrowserManager } from '../browser/index.ts'
import type { SkillsLoader } from '../skills/loader.ts'
import type { MemoryManager } from '../memory/index.ts'
import { buildRecoveredConversationPrompt, resolveStoredSessionFile, type StoredSessionEntry } from './context-utils.ts'
import type { AgentConfig, ProcessParams } from './types.ts'
import { clearBootstrapSnapshotOnSessionRollover } from './bootstrap-cache.ts'
import type { SecretsManager } from './secrets.ts'
import { buildRuntimeCustomTools, filterConfiguredTools } from './runtime-tools.ts'
import { createSubagentTool } from './subagent-mcp.ts'
import { AgentCompiler } from './compiler.ts'
import { resolveMediaTurnContext } from './media-intent.ts'
import { getEvolutionService } from '../evolution/service.ts'
import { buildLessonsBlock } from '../feedback/lessons.ts'
import { buildPlanBlock } from '../plans/store.ts'
import { getMediaService } from '../media/service.ts'
import type { MediaStatus } from '../media/types.ts'
import { isMediaTool, mediaAttachmentFromToolResult } from './media-attachments.ts'
import type { Attachment } from '../types/attachment.ts'
import { resolveRuntimeModelConfig } from './runtime-model.ts'
import {
  classifyToolEffect,
  isModelPriceKnown,
  markAgentOpsCoverage,
  recordAgentOpsModelUsage,
  recordAgentOpsTool,
  type AgentOpsTraceContext,
} from '../agentops/index.ts'
import {
  authorizeWorkflowModel,
  authorizeWorkflowTool,
  isWorkflowBudgetError,
  recordWorkflowModelUsage,
  type WorkflowBudgetError,
} from '../workflow/budget.ts'

const COMPACTION_MEMORY_INSTRUCTIONS = [
  'Focus on durable context for future turns.',
  'Preserve user preferences, decisions, open questions, file paths, and unfinished work.',
  'Call out concrete TODOs and unresolved risks.',
].join(' ')

type CompactionSummary = {
  summary: string
  trigger: 'manual' | 'auto'
  sessionId?: string
}

type AssistantSessionMessage = {
  role?: string
  stopReason?: string
  errorMessage?: string
  content?: Array<{ type?: string; text?: string }>
}

type RuntimeAttachment = {
  filename: string
  mediaType: string
  filePath?: string
  data?: string
  size?: number
}

function buildAbortedSessionResult(fullText: string, sessionId: string) {
  return { fullText, sessionId, aborted: true }
}

// [XJC] T-A3 视觉:附件图片转 base64 进多模态
// collectPromptImages 只消费带 data(纯 base64) 的附件；上传链路只有 filePath，
// 此函数在进 prompt 前读盘补齐 data。限制:单图 ≤maxBytes、最多 maxCount 张，
// 超限/读失败逐张跳过（保持无 data，回退为路径文本引用），绝不抛错影响文本主流程。
export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_PROMPT_IMAGE_COUNT = 4

export function hydratePromptImageAttachments(
  attachments: RuntimeAttachment[] | undefined,
  options?: {
    maxBytes?: number
    maxCount?: number
    warn?: (context: Record<string, unknown>, message: string) => void
  },
): RuntimeAttachment[] | undefined {
  if (!attachments || attachments.length === 0) {
    return attachments
  }

  const maxBytes = options?.maxBytes ?? MAX_PROMPT_IMAGE_BYTES
  const maxCount = options?.maxCount ?? MAX_PROMPT_IMAGE_COUNT
  const warn = options?.warn ?? (() => {})
  let hydratedCount = 0

  return attachments.map((attachment) => {
    if (!attachment.mediaType.startsWith('image/')) {
      return attachment
    }
    if (typeof attachment.data === 'string' && attachment.data.length > 0) {
      hydratedCount += 1
      return attachment
    }
    if (!attachment.filePath) {
      return attachment
    }
    if (hydratedCount >= maxCount) {
      warn({ filename: attachment.filename, maxCount }, 'Skipping prompt image: too many image attachments')
      return attachment
    }
    try {
      const size = statSync(attachment.filePath).size
      if (size > maxBytes) {
        warn({ filename: attachment.filename, size, maxBytes }, 'Skipping prompt image: file exceeds size limit')
        return attachment
      }
      const data = readFileSync(attachment.filePath).toString('base64')
      hydratedCount += 1
      return { ...attachment, data }
    } catch (err) {
      warn(
        { filename: attachment.filename, filePath: attachment.filePath, error: err instanceof Error ? err.message : String(err) },
        'Skipping prompt image: failed to read file',
      )
      return attachment
    }
  })
}

type SessionWithSystemPromptOverride = {
  _baseSystemPrompt?: string
  _rebuildSystemPrompt?: (toolNames: string[]) => string
}

function applySystemPromptOverrideToSession(session: AgentSession, systemPrompt: string): void {
  const prompt = systemPrompt.trim()
  session.agent.setSystemPrompt(prompt)
  const mutableSession = session as unknown as SessionWithSystemPromptOverride
  mutableSession._baseSystemPrompt = prompt
  mutableSession._rebuildSystemPrompt = () => prompt
}

export function buildEmptyAssistantResponseErrorMessage(modelConfig: {
  provider: string
  modelId: string
  baseUrl: string
}): string {
  const parts = [
    `Model returned an empty response (provider=${modelConfig.provider}, model=${modelConfig.modelId})`,
  ]
  if (modelConfig.baseUrl) {
    parts.push(`baseUrl=${modelConfig.baseUrl}`)
  }
  parts.push('Please check MODEL_PROVIDER, MODEL_ID, MODEL_BASE_URL, and model authentication.')
  return parts.join('. ')
}

export class AgentRuntime {
  private config: AgentConfig
  private eventBus: EventBus
  private promptBuilder: PromptBuilder
  private hooksManager: HooksManager | null
  private skillsLoader: SkillsLoader | null
  private memoryManager: MemoryManager | null
  private browserManager: BrowserManager | null
  private secretsManager: SecretsManager | null

  constructor(
    config: AgentConfig,
    eventBus: EventBus,
    promptBuilder: PromptBuilder,
    hooksManager?: HooksManager,
    skillsLoader?: SkillsLoader,
    memoryManager?: MemoryManager,
    browserManager?: BrowserManager,
    secretsManager?: SecretsManager,
  ) {
    this.config = config
    this.eventBus = eventBus
    this.promptBuilder = promptBuilder
    this.hooksManager = hooksManager ?? null
    this.skillsLoader = skillsLoader ?? null
    this.memoryManager = memoryManager ?? null
    this.browserManager = browserManager ?? null
    this.secretsManager = secretsManager ?? null
  }

  /**
   * Process a user message and return the agent's reply.
   */
  async process(params: ProcessParams): Promise<string> {
    const { chatId, prompt, agentId, turnId, suppressOutbound } = params
    const logger = getLogger()
    if (params.executionState) params.executionState.status = 'pending'

    this.emitProcessing(agentId, chatId, true, turnId)
    const emitCancellationCompletion = (
      fullText = '',
      sessionId = '',
      completedToolUse: AgentToolUse[] = [],
    ): string => {
      if (params.executionState) {
        params.executionState.status = 'cancelled'
        params.executionState.errorCode = ErrorCode.CANCELLED
      }
      this.eventBus.emit({
        type: 'complete',
        agentId,
        chatId,
        fullText,
        sessionId,
        turnId,
        toolUse: completedToolUse,
        suppressOutbound,
        cancelled: true,
      })
      return fullText
    }
    const finishEarlyCancellation = (): string => {
      const result = emitCancellationCompletion()
      this.emitProcessing(agentId, chatId, false, turnId)
      return result
    }
    if (params.abortController?.signal.aborted) {
      return finishEarlyCancellation()
    }

    if (this.hooksManager) {
      await this.hooksManager.execute(agentId, 'on_session_start', {
        agentId,
        chatId,
        phase: 'on_session_start',
        payload: { chatId },
      })
    }
    if (params.abortController?.signal.aborted) {
      return finishEarlyCancellation()
    }

    const existingSession = getSessionEntry(agentId, chatId)
    logger.info({
      agentId,
      chatId,
      hasSession: !!existingSession?.sessionId,
      promptPreview: prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt,
      category: 'agent',
    }, 'Processing message')

    const startTime = Date.now()
    let toolUse: AgentToolUse[] = []
    let mediaAttachments: Attachment[] = []
    try {
      let finalPrompt = prompt
      if (this.hooksManager) {
        const preCtx = await this.hooksManager.execute(agentId, 'pre_process', {
          agentId,
          chatId,
          phase: 'pre_process',
          payload: { prompt, chatId },
        })
        if (params.abortController?.signal.aborted) {
          return emitCancellationCompletion()
        }
        if (preCtx.abort) {
          return preCtx.abortReason ?? 'Message blocked by hook'
        }
        if (preCtx.modifiedPayload?.prompt) {
          finalPrompt = preCtx.modifiedPayload.prompt as string
        }
      }

      const resolvedModel = resolveRuntimeModelConfig({
        agentModel: this.config.hasExplicitModel ? this.config.model : undefined,
      })
      const modelConfig = resolvedModel.config
      if (!modelConfig) {
        throw new Error(resolvedModel.error ?? 'No model config available. Please configure a model in Settings.')
      }

      if (modelConfig.provider === 'builtin') {
        const authToken = getAuthToken()
        if (!authToken) {
          throw new Error('Not logged in: Please log in to use built-in models')
        }
      }

      logger.info({
        provider: modelConfig.provider,
        model: modelConfig.modelId,
        baseUrl: modelConfig.baseUrl || '(default)',
      }, 'Model config loaded')

      const { fullText, sessionId, sessionFile, aborted, toolUse: collectedToolUse, mediaAttachments: collectedMediaAttachments } = await this.executeQuery(
        finalPrompt,
        agentId,
        chatId,
        existingSession,
        modelConfig,
        params.browserProfileId,
        params.requestedSkills,
        params.attachments,
        turnId,
        params.abortController,
        params.agentOps,
      )
      toolUse = collectedToolUse
      mediaAttachments = collectedMediaAttachments

      if (aborted) {
        if (params.executionState) params.executionState.status = 'cancelled'
        deleteSession(agentId, chatId)
      } else if (sessionId) {
        clearBootstrapSnapshotOnSessionRollover({
          cacheKey: `${agentId}:${chatId}`,
          previousSessionId: existingSession?.sessionId ?? null,
          nextSessionId: sessionId,
        })
        saveSession(agentId, chatId, sessionId, sessionFile)
      }

      let finalText = fullText
      if (this.hooksManager) {
        const postCtx = await this.hooksManager.execute(agentId, 'post_process', {
          agentId,
          chatId,
          phase: 'post_process',
          payload: { fullText, chatId },
        })
        if (postCtx.modifiedPayload?.fullText) {
          finalText = postCtx.modifiedPayload.fullText as string
        }
      }

      const cancelled = aborted || params.abortController?.signal.aborted === true
      if (cancelled && params.executionState) {
        params.executionState.status = 'cancelled'
        params.executionState.errorCode = ErrorCode.CANCELLED
      }

      if (!cancelled && !finalText.trim()) {
        throw new Error(buildEmptyAssistantResponseErrorMessage(modelConfig))
      }

      if (cancelled) {
        emitCancellationCompletion(finalText, sessionId, toolUse)
      } else if (finalText.trim().length > 0) {
        this.eventBus.emit({
          type: 'complete',
          agentId,
          chatId,
          fullText: finalText,
          sessionId,
          turnId,
          toolUse,
          attachments: mediaAttachments.length > 0 ? mediaAttachments : undefined,
          suppressOutbound,
        })
      }

      const durationMs = Date.now() - startTime
      logger.info({ agentId, chatId, sessionId, responseLength: finalText.length, durationMs, category: 'agent' }, 'Message processing completed')

      if (this.hooksManager) {
        await this.hooksManager.execute(agentId, 'on_session_end', {
          agentId,
          chatId,
          phase: 'on_session_end',
          payload: { sessionId, fullText: finalText },
        })
      }

      if (!cancelled && params.executionState) params.executionState.status = 'success'
      return finalText
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err)
      logger.error({ agentId, chatId, error: rawError, durationMs: Date.now() - startTime, category: 'agent' }, 'Message processing failed')

      const budgetError = isWorkflowBudgetError(err) ? err : null
      const cancelled = params.abortController?.signal.aborted === true
      const { message: userError, errorCode } = cancelled
        ? { message: 'Request cancelled.', errorCode: ErrorCode.CANCELLED }
        : budgetError
          ? { message: budgetError.message, errorCode: ErrorCode.WORKFLOW_BUDGET_EXCEEDED }
          : this.humanizeError(rawError)
      if (params.executionState) {
        params.executionState.status = cancelled ? 'cancelled' : 'failed'
        params.executionState.errorCode = errorCode
      }
      logger.info({ agentId, chatId, errorCode, userError, category: 'agent' }, 'Error code identification result')

      if (this.hooksManager) {
        await this.hooksManager.execute(agentId, 'on_error', {
          agentId,
          chatId,
          phase: 'on_error',
          payload: { error: rawError },
        })
      }

      this.eventBus.emit({
        type: 'error',
        agentId,
        chatId,
        error: userError,
        errorCode,
        stopReason: cancelled ? 'cancelled' : budgetError?.stopReason,
        turnId,
        toolUse,
      })

      return `Error: ${userError}`
    } finally {
      this.emitProcessing(agentId, chatId, false, turnId)
    }
  }

  /**
   * Execute agent query via pi-mono in-process session.
   */
  private async executeQuery(
    prompt: string,
    agentId: string,
    chatId: string,
    existingSession: StoredSessionEntry | null,
    modelConfig: { apiKey: string; baseUrl: string; modelId: string; provider: string },
    browserProfileId?: string | null,
    requestedSkills?: string[],
    attachments?: RuntimeAttachment[],
    turnId?: string,
    externalAbortController?: AbortController,
    agentOps?: AgentOpsTraceContext,
  ): Promise<{ fullText: string; sessionId: string; sessionFile: string | null; aborted: boolean; toolUse: AgentToolUse[]; mediaAttachments: Attachment[] }> {
    const logger = getLogger()
    const abortController = externalAbortController ?? new AbortController()
    if (turnId) abortRegistry.register(chatId, turnId, abortController)
    else abortRegistry.register(chatId, abortController)
    const invocationId = randomUUID()
    const toolUse: AgentToolUse[] = []
    // [XJC] 本回合内置媒体工具产出的图片/视频，随 complete 事件下发并落库为消息附件（对话内联展示）
    const mediaAttachments: Attachment[] = []
    const browserDisabled = browserProfileId === null
    const browserTarget = this.config.browser?.target ?? 'host'
    const resolvedBrowserProfile = this.browserManager
      ? (browserDisabled
          ? null
          : this.browserManager.resolveProfileSelection(
              browserProfileId ?? undefined,
              this.config.browser?.defaultProfile ?? this.config.browserProfile,
            ))
      : null
    const effectiveBrowserProfileId = resolvedBrowserProfile?.id
    const skillSnapshot = this.skillsLoader
      ? this.skillsLoader.buildSnapshotForAgent(this.config, requestedSkills)
      : { prompt: '', skills: [], resolvedSkills: [], version: 0 }
    const skillsPrompt = skillSnapshot.prompt
    logger.info({
      agentId,
      chatId,
      skillSnapshotVersion: skillSnapshot.version,
      skillCount: skillSnapshot.skills.length,
      skillNames: skillSnapshot.skills.map((skill) => skill.name),
      category: 'agent',
    }, 'Skill snapshot prepared')
    let memoryContext = this.memoryManager && this.config.memory?.enabled !== false
      ? this.memoryManager.getMemoryContext(agentId, {
          recentDays: this.config.memory?.recentDays,
          maxContextChars: this.config.memory?.maxContextChars,
          query: prompt,
        })
      : undefined
    // [XJC] 自主进化：注入引擎行为提示 + covenant 活跃规则（均同步读缓存，零时延；开关关闭恒 null）
    try {
      const evolutionHint = getEvolutionService().getHintFor(agentId)
      if (evolutionHint) {
        const hintBlock = `<evolution_hint>\n以下是从你过往任务成败中学到的经验提示，作为做法参考（无需向用户提及）：\n${evolutionHint}\n</evolution_hint>`
        memoryContext = memoryContext ? `${memoryContext}\n\n${hintBlock}` : hintBlock
      }
      // covenant 闭环最后一公里：引擎审批通过的行为规则（AGENTS.md）进入行为层
      const evolutionRules = getEvolutionService().getRulesFor()
      if (evolutionRules) {
        const rulesBlock = `<evolution_rules>\n以下是进化引擎审批通过的行为规则，请遵循（无需向用户提及）：\n${evolutionRules}\n</evolution_rules>`
        memoryContext = memoryContext ? `${memoryContext}\n\n${rulesBlock}` : rulesBlock
      }
    } catch { /* 进化提示注入失败不影响对话 */ }
    // [XJC] 用户反馈教训（确定性，不依赖进化开关/Python）：近期点踩原因注入，立刻影响后续回答
    try {
      const lessonsBlock = buildLessonsBlock(agentId)
      if (lessonsBlock) {
        memoryContext = memoryContext ? `${memoryContext}\n\n${lessonsBlock}` : lessonsBlock
      }
    } catch { /* 教训注入失败不影响对话 */ }
    // [XJC] 显式计划（自主强化）：本会话有未完成计划则每轮注入——压缩/重启后 agent 仍知道走到哪
    try {
      const planBlock = buildPlanBlock(chatId)
      if (planBlock) {
        memoryContext = memoryContext ? `${memoryContext}\n\n${planBlock}` : planBlock
      }
    } catch { /* 计划注入失败不影响对话 */ }

    let fullText = ''
    let mediaStatus: MediaStatus | undefined
    try {
      mediaStatus = getMediaService().status()
    } catch {
      // Advisory prompt context only; media tool execution remains authoritative.
    }
    const mediaTurnContext = resolveMediaTurnContext(chatId, prompt, mediaStatus)

    const cwd = this.config.workspaceDir
    const model = resolvePiModel(modelConfig)

    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey(model.provider, modelConfig.apiKey)

    if (modelConfig.provider === 'builtin') {
      const authToken = getAuthToken()
      if (authToken) {
        model.headers = { ...model.headers, rdxtoken: authToken }
      }
    }

    const sessionsDir = resolve(getPaths().data, 'sessions', agentId)
    mkdirSync(sessionsDir, { recursive: true })
    const existingSessionFile = resolveStoredSessionFile(sessionsDir, existingSession)

    const sessionManager = existingSessionFile && existsSync(existingSessionFile)
      ? SessionManager.open(existingSessionFile, sessionsDir)
      : SessionManager.create(cwd, sessionsDir)

    // [XJC] 自主强化：补挂原生 Grep/Find/Ls 只读检索工具（此前只有 Read/Bash/Edit/Write，
    // 检索全靠 Bash 绕行；office 子代理白名单里的 grep/find/ls 也自此真实可用）
    const tools = filterConfiguredTools([
      ...createCodingTools(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
    ], this.config)
    const customToolRuntime = await buildRuntimeCustomTools({
      config: this.config,
      browserManager: this.browserManager,
      secretsManager: this.secretsManager,
      memoryManager: this.memoryManager,
      chatId,
      agentId,
      workspaceDir: cwd,
      documentAttachmentPaths: attachments
        ?.map((attachment) => attachment.filePath)
        .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0),
      mediaAuthorization: mediaTurnContext.authorization,
      browserProfileId: effectiveBrowserProfileId,
      browserTarget,
      reservedToolNames: tools.map((tool) => tool.name),
    })
    const customTools = filterConfiguredTools(customToolRuntime.tools, this.config)
    // [XJC] 子代理委派：ref 定义先编译为当前 runtime 使用的内联专员，再挂 delegate 工具。
    // customTools 此时不含 delegate → 传给子代理的工具池天然防套娃。
    let effectiveCustomTools = customTools
    try {
      if (this.config.agents && Object.keys(this.config.agents).length > 0) {
        const subagents = new AgentCompiler(this.promptBuilder).resolve(this.config.agents, agentId)
        const delegateTool = createSubagentTool({
          subagents,
          cwd,
          builtinPool: tools,
          customPool: customTools,
          parentModel: model,
          // 子代理独立模型：解析失败返回 null → 工具层回退父模型
          resolveModel: (modelId: string) => {
            try {
              const resolved = resolveRuntimeModelConfig({ agentModel: modelId })
              return resolved.config ? resolvePiModel(resolved.config) : null
            } catch { return null }
          },
          // 注入父技能快照，专员可用父的技能脚本
          skillsPrompt,
        })
        if (delegateTool) effectiveCustomTools = [...customTools, delegateTool]
      }
    } catch (err) {
      getLogger().warn({ agentId, error: err instanceof Error ? err.message : String(err), category: 'subagent' }, 'Failed to mount delegate tool')
    }
    const availableToolNames = [...tools, ...effectiveCustomTools].map((tool) => tool.name)
    const requiredMediaTool = mediaTurnContext.intent === 'generate-image'
      ? 'mcp__media__generate_image'
      : mediaTurnContext.intent === 'edit-image'
        ? 'mcp__media__edit_image'
        : mediaTurnContext.intent === 'generate-video'
          ? 'mcp__media__generate_video'
          : null
    const mediaTurnInstruction = requiredMediaTool && !availableToolNames.includes(requiredMediaTool)
      ? `<runtime_media_instruction>The current employee configuration does not allow ${requiredMediaTool}. ` +
        `Do not search for a skill or ask for an API Key. Explain that this employee must be allowed to use the built-in media tool.</runtime_media_instruction>`
      : mediaTurnContext.systemInstruction
    const systemPrompt = this.promptBuilder.build(
      this.config.workspaceDir,
      this.config,
      {
        agentId,
        chatId,
        requestedSkills,
        skillsPrompt,
        memoryContext,
        browserProfileId: effectiveBrowserProfileId,
        browserDisabled,
        browserTarget,
        mediaStatus,
        mediaTurnInstruction,
        availableToolNames,
        browserProfile: resolvedBrowserProfile
          ? {
              id: resolvedBrowserProfile.id,
              driver: resolvedBrowserProfile.driver,
              userDataDir: resolvedBrowserProfile.userDataDir,
            }
          : undefined,
      },
    )
    let modelRound = 0
    let workflowBudgetStop: WorkflowBudgetError | null = null
    const pricingKnown = isModelPriceKnown(model)
    if (agentOps && !pricingKnown) {
      try {
        markAgentOpsCoverage({
          traceId: agentOps.traceId,
          spanId: agentOps.spanId,
          coverage: 'partial',
          note: 'unknown_model_price',
        })
      } catch {
        // Trace persistence is best-effort.
      }
    }
    const pendingModelCalls: Array<{ round: number; startedAt: number }> = []
    const markProviderUsageUnavailable = (): void => {
      if (!agentOps) return
      try {
        markAgentOpsCoverage({
          traceId: agentOps.traceId,
          spanId: agentOps.spanId,
          coverage: 'partial',
          note: 'provider_usage_unavailable',
        })
      } catch {
        // Trace persistence is best-effort.
      }
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      extensionFactories: [
        (pi) => {
          pi.on('before_provider_request', (event, ctx) => {
            if (workflowBudgetStop) {
              ctx.abort()
              return
            }
            if (agentOps?.workflowRunId) {
              try {
                authorizeWorkflowModel(agentOps.workflowRunId, pricingKnown)
              } catch (err) {
                if (isWorkflowBudgetError(err)) {
                  workflowBudgetStop = err
                  ctx.abort()
                  return
                }
                throw err
              }
            }
            modelRound += 1
            const round = modelRound
            pendingModelCalls.push({ round, startedAt: Date.now() })
            writeModelInvocationLog({
              event: 'request',
              invocationId,
              round,
              agentId,
              chatId,
              model: {
                provider: model.provider,
                modelId: model.id,
                baseUrl: modelConfig.baseUrl || undefined,
              },
              session: {
                resumed: Boolean(existingSessionFile && existsSync(existingSessionFile)),
                sessionFile: existingSessionFile ?? sessionManager.getSessionFile() ?? null,
              },
              payload: event.payload,
            })
          })
          pi.on('tool_call', (event) => {
            if (!agentOps?.workflowRunId) return
            const effect = classifyToolEffect(event.toolName)
            try {
              authorizeWorkflowTool(agentOps.workflowRunId, effect)
            } catch (err) {
              if (!isWorkflowBudgetError(err)) throw err
              workflowBudgetStop = err
              if (agentOps) {
                try {
                  recordAgentOpsTool({
                    traceId: agentOps.traceId,
                    spanId: agentOps.spanId,
                    toolName: event.toolName,
                    effect,
                    executed: false,
                  })
                } catch {
                  // Trace persistence is best-effort.
                }
              }
              return { block: true, reason: err.message }
            }
          })
        },
      ],
    })
    await resourceLoader.reload()

    logger.info({
      agentId,
      chatId,
      systemPromptLength: systemPrompt.length,
      model: model.id,
      provider: model.provider,
      isResume: !!existingSessionFile,
      sessionFile: existingSessionFile ?? sessionManager.getSessionFile(),
      browserProfileId: effectiveBrowserProfileId,
      category: 'agent',
    }, 'Creating agent session')

    const queryStartTime = Date.now()
    try {
      const { session } = await createAgentSession({
        cwd,
        model,
        tools,
        customTools: effectiveCustomTools,
        resourceLoader,
        authStorage,
        sessionManager,
      })

      applySystemPromptOverrideToSession(session, systemPrompt)

      const compactionSummaries: CompactionSummary[] = []
      await this.prepareSessionForPrompt(session, agentId, chatId, model.id, compactionSummaries)

      const browserDisabledNotice = { sent: false }
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        this.handleSessionEvent(event, agentId, chatId, (text) => {
          fullText += text
        }, compactionSummaries, toolUse, turnId, browserDisabled, browserDisabledNotice, agentOps, mediaAttachments)

        if (event.type === 'turn_end') {
          const current = pendingModelCalls.shift()
          const assistantMessage = event.message as AssistantMessage
          if (assistantMessage?.role === 'assistant' && assistantMessage.usage && agentOps) {
            const latencyMs = current ? Date.now() - current.startedAt : undefined
            try {
              recordAgentOpsModelUsage({
                traceId: agentOps.traceId,
                spanId: agentOps.spanId,
                model: { provider: model.provider, id: model.id },
                usage: assistantMessage.usage,
                pricingKnown,
                latencyMs,
              })
            } catch {
              // Trace persistence is best-effort and never changes the reply path.
            }
            if (agentOps.workflowRunId) {
              try {
                recordWorkflowModelUsage(
                  agentOps.workflowRunId,
                  assistantMessage.usage,
                  pricingKnown,
                  latencyMs ?? 0,
                )
              } catch (err) {
                if (isWorkflowBudgetError(err)) {
                  workflowBudgetStop = err
                  void session.abort().catch(() => {})
                }
              }
            }
          } else if (current && agentOps) {
            markProviderUsageUnavailable()
          }
          if (!current) return
          const responseText = this.extractAssistantText(event.message)
          writeModelInvocationLog({
            event: 'response',
            invocationId,
            round: current.round,
            agentId,
            chatId,
            model: {
              provider: model.provider,
              modelId: model.id,
              baseUrl: modelConfig.baseUrl || undefined,
            },
            session: {
              resumed: Boolean(existingSessionFile && existsSync(existingSessionFile)),
              sessionFile: session.sessionManager.getSessionFile() ?? existingSessionFile ?? null,
            },
            payload: event.message,
            responseText,
            result: {
              durationMs: Date.now() - current.startedAt,
              outputLength: responseText.length,
            },
          })
        }
      })

      const promptWithFallback = (!existingSessionFile || !existsSync(existingSessionFile))
        ? this.buildRecoveredPrompt(chatId, prompt)
        : prompt
      const fileAttachments = attachments
        ?.filter((attachment) => typeof attachment.filePath === 'string' && attachment.filePath.length > 0)
        .map((attachment) => ({
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          filePath: attachment.filePath!,
        })) ?? []
      const { parsedDocuments, remainingAttachments } = await ingestDocumentAttachments(
        chatId,
        fileAttachments,
        (event) => this.emitDocumentStatus(agentId, chatId, event.documentId, event.filename, event.status, event.error, turnId),
      )
      const promptWithDocuments = parsedDocuments.length > 0
        ? `${promptWithFallback}\n\n${buildParsedDocumentsPrompt(parsedDocuments)}`.trim()
        : promptWithFallback
      const processedAttachments = remainingAttachments.length > 0
        ? await preprocessAttachments(remainingAttachments)
        : []
      const promptWithAttachments = this.appendAttachmentInstructions(promptWithDocuments, processedAttachments)
      const remainingAttachmentPaths = new Set(remainingAttachments.map((attachment) => attachment.filePath).filter(Boolean))
      // [XJC] T-A3 视觉:附件图片转 base64 进多模态（仅视觉模型；任何失败回退现状路径引用）
      let attachmentsForImages = attachments
      try {
        if (Array.isArray(model.input) && model.input.includes('image')) {
          attachmentsForImages = hydratePromptImageAttachments(attachments, {
            warn: (context, message) => logger.warn({ ...context, agentId, chatId, category: 'agent' }, message),
          })
        }
      } catch (err) {
        logger.warn({ agentId, chatId, error: err instanceof Error ? err.message : String(err), category: 'agent' }, 'Failed to hydrate image attachments, falling back to path references')
        attachmentsForImages = attachments
      }
      const promptImages = this.collectPromptImages(attachmentsForImages, remainingAttachmentPaths)

      abortController.signal.addEventListener('abort', () => {
        session.abort().catch(() => {})
      }, { once: true })

      try {
        try {
          // A queue cancellation can happen while session/tool setup is still
          // awaiting. Do not call prompt after that registration race: aborting
          // an idle session does not guarantee the next prompt stays aborted.
          if (abortController.signal.aborted) {
            return {
              ...buildAbortedSessionResult(
                fullText,
                session.sessionManager.getSessionId(),
              ),
              sessionFile: session.sessionManager.getSessionFile() ?? null,
              toolUse,
              mediaAttachments,
            }
          }
          if (agentOps?.workflowRunId) {
            authorizeWorkflowModel(agentOps.workflowRunId, pricingKnown)
          }
          if (promptImages.length > 0) {
            await session.prompt(promptWithAttachments, { images: promptImages })
          } else {
            await session.prompt(promptWithAttachments)
          }
        } catch (err) {
          if (workflowBudgetStop) {
            throw workflowBudgetStop
          }
          if (isWorkflowBudgetError(err)) {
            throw err
          }
          if (abortController.signal.aborted) {
            if (pendingModelCalls.length > 0) markProviderUsageUnavailable()
            logger.info({ agentId, chatId, category: 'agent' }, 'Agent session aborted by user, returning partial text')
            const finalSessionId = session.sessionManager.getSessionId()
            const finalSessionFile = session.sessionManager.getSessionFile() ?? null
            const current = pendingModelCalls[0]
            if (current) {
              writeModelInvocationLog({
                event: 'error',
                invocationId,
                round: current.round,
                agentId,
                chatId,
                model: {
                  provider: model.provider,
                  modelId: model.id,
                  baseUrl: modelConfig.baseUrl || undefined,
                },
                session: {
                  resumed: Boolean(existingSessionFile && existsSync(existingSessionFile)),
                  sessionFile: finalSessionFile,
                },
                result: {
                  durationMs: Date.now() - current.startedAt,
                  outputLength: fullText.length,
                  sessionId: finalSessionId,
                  sessionFile: finalSessionFile,
                },
                error: {
                  message: 'aborted',
                  partialOutput: fullText,
                },
              })
            }
            return {
              ...buildAbortedSessionResult(fullText, finalSessionId),
              sessionFile: finalSessionFile,
              toolUse,
              mediaAttachments,
            }
          }
          if (pendingModelCalls.length > 0) markProviderUsageUnavailable()
          const current = pendingModelCalls[0]
          writeModelInvocationLog({
            event: 'error',
            invocationId,
            round: current?.round,
            agentId,
            chatId,
            model: {
              provider: model.provider,
              modelId: model.id,
              baseUrl: modelConfig.baseUrl || undefined,
            },
            session: {
              resumed: Boolean(existingSessionFile && existsSync(existingSessionFile)),
              sessionFile: session.sessionManager.getSessionFile() ?? existingSessionFile ?? null,
            },
            result: {
              durationMs: current ? Date.now() - current.startedAt : Date.now() - queryStartTime,
              outputLength: fullText.length,
            },
            error: {
              message: err instanceof Error ? err.message : String(err),
              partialOutput: fullText,
            },
          })
          throw err
        }

        if (pendingModelCalls.length > 0) markProviderUsageUnavailable()
        if (workflowBudgetStop) {
          throw workflowBudgetStop
        }
        const sessionError = getLatestAssistantError(session.sessionManager.getEntries())
        if (sessionError) {
          throw new Error(sessionError)
        }
      } finally {
        unsubscribe()
      }

      this.finalizeSession(agentId, chatId, session, model.id, compactionSummaries)

      const finalSessionId = session.sessionManager.getSessionId()
      const finalSessionFile = session.sessionManager.getSessionFile() ?? null

      const durationMs = Date.now() - queryStartTime
      logger.info({
        agentId,
        chatId,
        totalDurationMs: durationMs,
        finalSessionId,
        finalSessionFile,
        category: 'agent',
      }, 'Agent session finished')

      return {
        fullText,
        sessionId: finalSessionId,
        sessionFile: finalSessionFile,
        aborted: false,
        toolUse,
        mediaAttachments,
      }
    } finally {
      await customToolRuntime.dispose()
      abortRegistry.unregister(chatId, turnId)
    }
  }

  /**
   * Handle a pi-mono session event and map to XiaoJuClaw EventBus events.
   */
  private handleSessionEvent(
    event: AgentSessionEvent,
    agentId: string,
    chatId: string,
    appendText: (text: string) => void,
    compactionSummaries: CompactionSummary[],
    toolUseHistory: AgentToolUse[],
    turnId: string | undefined,
    browserDisabled = false,
    browserDisabledNotice: { sent: boolean } = { sent: false },
    agentOps?: AgentOpsTraceContext,
    mediaAttachments?: Attachment[],
  ): void {
    switch (event.type) {
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent.type === 'text_delta') {
          appendText(assistantEvent.delta)
          this.emitStream(agentId, chatId, assistantEvent.delta, turnId)
        }
        break
      }

      case 'tool_execution_start': {
        const logger = getLogger()
        if (agentOps) {
          try {
            const effect = classifyToolEffect(event.toolName)
            recordAgentOpsTool({
              traceId: agentOps.traceId,
              spanId: agentOps.spanId,
              toolName: event.toolName,
              effect,
            })
            if (effect === 'unknown') {
              markAgentOpsCoverage({
                traceId: agentOps.traceId,
                spanId: agentOps.spanId,
                coverage: 'partial',
                note: 'unknown_tool_effect',
              })
            }
          } catch {
            // Trace persistence is best-effort.
          }
        }
        logger.info({
          agentId,
          chatId,
          tool: event.toolName,
          input: JSON.stringify(event.args).slice(0, 500),
          category: 'tool_use',
        }, `Tool call: ${event.toolName}`)

        const disabledBrowserReason = this.getDisabledBrowserToolBlockReason(event.toolName, event.args, browserDisabled)
        if (disabledBrowserReason && !browserDisabledNotice.sent) {
          browserDisabledNotice.sent = true
          const message = this.buildDisabledBrowserUserMessage(disabledBrowserReason)
          appendText(message)
          this.emitStream(agentId, chatId, message, turnId)
        }

        toolUseHistory.push({
          id: `tool:${turnId ?? 'turnless'}:${toolUseHistory.length + 1}`,
          name: event.toolName,
          input: JSON.stringify(event.args).slice(0, 200),
          status: 'done',
        })

        if (this.hooksManager) {
          this.hooksManager.execute(agentId, 'pre_tool_use', {
            agentId,
            chatId,
            phase: 'pre_tool_use',
            payload: { tool: event.toolName, input: event.args },
          }).then((ctx) => {
            if (ctx.abort) {
              this.emitStream(agentId, chatId, `\n[Tool ${event.toolName} blocked by hook: ${ctx.abortReason ?? 'unknown reason'}]\n`, turnId)
            }
          }).catch(() => {
            // Hook errors should not affect main flow.
          })
        }

        this.emitToolUse(agentId, chatId, event.toolName, event.args, turnId)
        break
      }

      case 'tool_execution_end': {
        // [XJC] 内置媒体工具产出的图片/视频 → 收集为消息附件，随 complete 事件下发内联展示
        if (mediaAttachments && isMediaTool(event.toolName)) {
          const attachment = mediaAttachmentFromToolResult(event.toolName, event.result, event.isError)
          if (attachment && !mediaAttachments.some((existing) => existing.filePath === attachment.filePath)) {
            mediaAttachments.push(attachment)
          }
        }
        break
      }

      case 'auto_compaction_end':
        if (event.result?.summary) {
          compactionSummaries.push({ summary: event.result.summary, trigger: 'auto' })
        }
        break

      case 'agent_end':
      case 'auto_compaction_start':
        break
    }
  }

  private getDisabledBrowserToolBlockReason(toolName: string, input: unknown, browserDisabled: boolean): string | null {
    if (!browserDisabled) return null
    if (!input || typeof input !== 'object') return null

    const payload = input as Record<string, unknown>
    if (toolName === 'Skill' && payload.skill === 'agent-browser') {
      return 'If this task is blocked by login, CAPTCHA, or site verification, ask the user to switch the chat browser setting from "None" to a browser profile and retry.'
    }
    if (toolName === 'Bash' && typeof payload.command === 'string' && /\bagent-browser\b/.test(payload.command)) {
      return 'If this task is blocked by login, CAPTCHA, or site verification, ask the user to switch the chat browser setting from "None" to a browser profile and retry.'
    }

    return null
  }

  private buildDisabledBrowserUserMessage(reason: string): string {
    return `Browser automation is currently disabled for this request. ${reason}`
  }

  private buildRecoveredPrompt(chatId: string, prompt: string): string {
    const limit = this.config.memory?.historyFallbackMessages ?? 12
    if (limit <= 0) return prompt

    const messages = getMessages(chatId, limit + 4).reverse().map((message) => ({
      content: message.content ?? '',
      isBotMessage: message.is_bot_message === 1,
    }))

    return buildRecoveredConversationPrompt(messages, prompt, limit)
  }

  private shouldCompactSession(sessionFile: string | undefined | null): boolean {
    const maxSessionBytes = this.config.memory?.maxSessionBytes ?? 262144
    if (!sessionFile || maxSessionBytes <= 0 || !existsSync(sessionFile)) {
      return false
    }

    try {
      return statSync(sessionFile).size > maxSessionBytes
    } catch {
      return false
    }
  }

  private async prepareSessionForPrompt(
    session: AgentSession,
    agentId: string,
    chatId: string,
    modelId: string,
    compactionSummaries: CompactionSummary[],
  ): Promise<void> {
    if (!this.shouldCompactSession(session.sessionManager.getSessionFile())) {
      return
    }

    const logger = getLogger()
    try {
      const previousSessionFile = session.sessionManager.getSessionFile()
      const previousSessionId = session.sessionManager.getSessionId()
      const result = await session.compact(COMPACTION_MEMORY_INSTRUCTIONS)
      if (result.summary) {
        compactionSummaries.push({ summary: result.summary, trigger: 'manual', sessionId: previousSessionId })
      }
      session.sessionManager.newSession({ parentSession: previousSessionFile ?? undefined })
    } catch (err) {
      logger.warn({ agentId, chatId, error: err instanceof Error ? err.message : String(err) }, 'Failed to compact oversized session before prompt')
    }
  }

  private finalizeSession(
    agentId: string,
    chatId: string,
    session: AgentSession,
    modelId: string,
    compactionSummaries: CompactionSummary[],
  ): void {
    const previousSessionFile = session.sessionManager.getSessionFile()
    const sessionId = session.sessionManager.getSessionId()

    for (const item of compactionSummaries.splice(0)) {
      this.memoryManager?.saveSessionSummary(agentId, chatId, item.sessionId ?? sessionId, item.summary, {
        trigger: item.trigger,
        model: modelId,
      })
    }

    if (!this.shouldCompactSession(previousSessionFile)) {
      return
    }

    try {
      session.sessionManager.newSession({ parentSession: previousSessionFile ?? undefined })
    } catch (err) {
      getLogger().warn({ agentId, chatId, error: err instanceof Error ? err.message : String(err) }, 'Failed to roll over session after prompt')
    }
  }

  /**
   * Convert errors to user-readable messages with error codes.
   */
  private humanizeError(raw: string): { message: string; errorCode: ErrorCode } {
    const normalizedRaw = normalizeAssistantErrorMessage(raw) ?? raw

    if (/request interrupted by user/i.test(raw) || /request was aborted/i.test(normalizedRaw)) {
      return { message: normalizedRaw, errorCode: ErrorCode.UNKNOWN }
    }
    if (/returned an empty response|empty response/i.test(raw) || /returned an empty response|empty response/i.test(normalizedRaw)) {
      return {
        message: 'Model returned an empty response. Please check MODEL_PROVIDER, MODEL_ID, MODEL_BASE_URL, and model authentication.',
        errorCode: ErrorCode.MODEL_CONNECTION_FAILED,
      }
    }
    if (/insufficient|credit|balance|quota|insufficient_credits/i.test(raw) || /insufficient|credit|balance|quota|insufficient_credits/i.test(normalizedRaw)) {
      return { message: 'Insufficient credits or API quota. Please check your account balance.', errorCode: ErrorCode.INSUFFICIENT_CREDITS }
    }
    if (/not logged in|please log in/i.test(raw) || /not logged in|please log in/i.test(normalizedRaw)) {
      return { message: 'Please log in to use built-in models.', errorCode: ErrorCode.AUTH_FAILED }
    }
    if (/unauthorized|authentication_error|invalid.*token|invalid.*key|\b401\b/i.test(raw) || /unauthorized|authentication_error|invalid.*token|invalid.*key|\b401\b/i.test(normalizedRaw)) {
      return { message: 'Model authentication failed. Please check your API Key in Settings → Models.', errorCode: ErrorCode.AUTH_FAILED }
    }
    if (/rate.?limit|too many requests|429/i.test(raw) || /rate.?limit|too many requests|429/i.test(normalizedRaw)) {
      return { message: 'Request rate limited. Please try again later.', errorCode: ErrorCode.RATE_LIMITED }
    }
    if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(raw) || /ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(normalizedRaw)) {
      return { message: 'Cannot reach the model API. Please check your network connection and Base URL.', errorCode: ErrorCode.NETWORK_ERROR }
    }
    if (/\b50[0-9]\b|server error|bad gateway|service unavailable/i.test(raw) || /\b50[0-9]\b|server error|bad gateway|service unavailable/i.test(normalizedRaw)) {
      return { message: 'The model API returned a server error. This is usually temporary — please retry.', errorCode: ErrorCode.MODEL_CONNECTION_FAILED }
    }
    return { message: normalizedRaw, errorCode: ErrorCode.UNKNOWN }
  }

  private appendAttachmentInstructions(
    prompt: string,
    attachments: Array<{ filename: string; mediaType: string; filePath: string }>,
  ): string {
    if (attachments.length === 0) {
      return prompt
    }

    const parts: string[] = []
    const imageFiles = attachments.filter((attachment) => attachment.mediaType.startsWith('image/'))
    const otherFiles = attachments.filter((attachment) => !attachment.mediaType.startsWith('image/'))

    if (imageFiles.length > 0) {
      const list = imageFiles
        .map((attachment) => `- ${attachment.filePath} (${attachment.mediaType}, ${attachment.filename})`)
        .join('\n')
      parts.push(`[Attached images]\n${list}\nImage files are attached at these local paths.`)
    }

    if (otherFiles.length > 0) {
      const list = otherFiles
        .map((attachment) => `- ${attachment.filePath} (${attachment.mediaType}, ${attachment.filename})`)
        .join('\n')
      parts.push(`[Attached files]\n${list}\nPlease read these files before answering.`)
    }

    if (parts.length === 0) {
      return prompt
    }

    return `${prompt}\n\n${parts.join('\n\n')}`.trim()
  }

  private collectPromptImages(
    attachments: RuntimeAttachment[] | undefined,
    remainingAttachmentPaths: Set<string>,
  ): Array<{ type: 'image'; data: string; mimeType: string }> {
    if (!attachments || attachments.length === 0) {
      return []
    }

    return attachments
      .filter((attachment) => {
        if (!attachment.mediaType.startsWith('image/')) return false
        if (typeof attachment.data !== 'string' || attachment.data.length === 0) return false
        if (!attachment.filePath) return true
        return remainingAttachmentPaths.has(attachment.filePath)
      })
      .map((attachment) => ({
        type: 'image' as const,
        data: attachment.data!,
        mimeType: attachment.mediaType,
      }))
  }

  private extractAssistantText(message: unknown): string {
    if (!message || typeof message !== 'object') {
      return ''
    }

    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) {
      return ''
    }

    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const typedPart = part as { type?: unknown; text?: unknown }
        return typedPart.type === 'text' && typeof typedPart.text === 'string'
          ? typedPart.text
          : ''
      })
      .filter(Boolean)
      .join('\n')
  }

  private emitProcessing(agentId: string, chatId: string, isProcessing: boolean, turnId?: string): void {
    this.eventBus.emit({ type: 'processing', agentId, chatId, isProcessing, turnId })
  }

  private emitStream(agentId: string, chatId: string, text: string, turnId?: string): void {
    this.eventBus.emit({ type: 'stream', agentId, chatId, text, turnId })
  }

  private emitToolUse(agentId: string, chatId: string, tool: string, input: unknown, turnId?: string): void {
    this.eventBus.emit({
      type: 'tool_use',
      agentId,
      chatId,
      tool,
      input: JSON.stringify(input).slice(0, 200),
      turnId,
    })
  }

  private emitDocumentStatus(
    agentId: string,
    chatId: string,
    documentId: string,
    filename: string,
    status: 'parsing' | 'parsed' | 'failed',
    error?: string,
    turnId?: string,
  ): void {
    this.eventBus.emit({
      type: 'document_status',
      agentId,
      chatId,
      documentId,
      filename,
      status,
      error,
      turnId,
    })
  }
}

export function getBunRuntimeDir(): string | null {
  const runtimeDir = resolve(process.cwd(), 'src-tauri', 'resources', 'bun-runtime')
  return existsSync(runtimeDir) ? runtimeDir : null
}

export function ensureBunRuntime(): string | null {
  const runtimeDir = getBunRuntimeDir()
  if (!runtimeDir) return null

  const executable = resolve(runtimeDir, process.platform === 'win32' ? 'bun.exe' : 'bun')
  return existsSync(executable) ? executable : null
}

function getLatestAssistantMessage(entries: SessionEntry[]): AssistantSessionMessage | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.type !== 'message') continue

    const message = entry.message as AssistantSessionMessage
    if (message.role === 'assistant') {
      return message
    }
  }

  return null
}

function combineErrorParts(summary: string | null, detail: string | null): string | null {
  if (summary && detail && summary !== detail) {
    return `${summary}: ${detail}`
  }
  return detail ?? summary
}

function extractStructuredErrorMessage(value: Record<string, unknown>): string | null {
  const summary = typeof value.error === 'string'
    ? value.error.trim() || null
    : extractNestedErrorMessage(value.error)
  const detail = extractNestedErrorMessage(value.message ?? value.errorMessage ?? value.detail)

  return combineErrorParts(summary, detail)
}

function extractNestedErrorMessage(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value !== 'object') return null

  return extractStructuredErrorMessage(value as Record<string, unknown>)
}

export function normalizeAssistantErrorMessage(raw: string | undefined, stopReason?: string): string | null {
  const trimmed = raw?.trim()
  if (trimmed) {
    const jsonStart = trimmed.indexOf('{')
    if (jsonStart >= 0) {
      const prefix = trimmed.slice(0, jsonStart).trim().replace(/[:\s]+$/, '')
      const jsonText = trimmed.slice(jsonStart)
      try {
        const parsed = JSON.parse(jsonText)
        const nested = extractNestedErrorMessage(parsed)
        if (nested && prefix && prefix !== nested) {
          return `${prefix}: ${nested}`
        }
        if (nested) return nested
      } catch {
        // Fall through to the raw message when the provider returned non-JSON text.
      }
    }

    return extractNestedErrorMessage(trimmed) ?? trimmed
  }

  if (stopReason === 'aborted') {
    return 'Request was aborted.'
  }
  if (stopReason === 'error') {
    return 'Model returned an error without details.'
  }

  return null
}

export function getLatestAssistantError(entries: SessionEntry[]): string | null {
  const message = getLatestAssistantMessage(entries)
  if (!message) return null

  const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined
  const normalized = normalizeAssistantErrorMessage(message.errorMessage, stopReason)
  if (stopReason === 'error' || stopReason === 'aborted') {
    return normalized
  }

  const hasTextContent = message.content?.some((item) => item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) ?? false
  if (!hasTextContent && normalized) {
    return normalized
  }

  return null
}
