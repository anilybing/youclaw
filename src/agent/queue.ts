// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { randomUUID } from 'node:crypto'
import {
  finishAgentOpsSpan,
  finishAgentOpsTrace,
  markAgentOpsTraceRunning,
  recordAgentOpsActiveDuration,
  startAgentOpsTrace,
  type AgentOpsTraceContext,
} from '../agentops/index.ts'
import { getLogger } from '../logger/index.ts'
import type { AgentManager } from './manager.ts'

interface QueueItem {
  agentId: string
  chatId: string
  prompt: string
  turnId: string
  abortController: AbortController
  agentOps: AgentOpsTraceContext
  ownsTrace: boolean
  activeStartedAt?: number
  requestedSkills?: string[]
  modelOverride?: { providerAccountId: string; modelId: string }
  browserProfileId?: string | null
  attachments?: Array<{ filename: string; mediaType: string; filePath: string }>
  suppressOutbound?: boolean
  afterResult?: (result: string) => Promise<void>
  resolve: (result: string) => void
  reject: (error: Error) => void
}

export interface EnqueueOptions {
  turnId?: string
  agentOps?: AgentOpsTraceContext
  requestedSkills?: string[]
  modelOverride?: { providerAccountId: string; modelId: string }
  browserProfileId?: string | null
  attachments?: Array<{ filename: string; mediaType: string; filePath: string }>
  // [XJC] 调度器发起的运行置真 → runtime emit 的 complete 带此标志 → 路由跳过渠道出站
  suppressOutbound?: boolean
  afterResult?: (result: string) => Promise<void>
}

export const QUEUE_CANCELLATION_CODE = 'TURN_CANCELLED'

export class QueueCancellationError extends Error {
  readonly code = QUEUE_CANCELLATION_CODE

  constructor(
    public readonly chatId: string,
    public readonly turnId: string,
    public readonly phase: 'queued' | 'running',
  ) {
    super(`Turn ${turnId} in chat ${chatId} was cancelled while ${phase}`)
    this.name = 'QueueCancellationError'
  }
}

export function isQueueCancellationError(error: unknown): error is QueueCancellationError {
  return error instanceof QueueCancellationError
    || (error instanceof Error && (error as Error & { code?: string }).code === QUEUE_CANCELLATION_CODE)
}

export interface QueueCancelResult {
  queued: number
  running: number
}

function tryAgentOps(action: () => void): void {
  try {
    action()
  } catch {
    // Tracing must never make the execution path unavailable.
  }
}

/**
 * Two-layer queue
 * Outer: per-agent concurrency control (maxConcurrency)
 * Inner: per agentId:chatId ordering within the same conversation
 * Different chats under the same agent can run concurrently
 */
export class AgentQueue {
  // Inner: ordered queue per chat
  private chatQueues: Map<string, QueueItem[]> = new Map()    // `${agentId}:${chatId}` -> queue
  private chatRunning: Set<string> = new Set()                 // currently running chatKeys
  private runningItems: Map<string, QueueItem> = new Map()

  // Outer: per-agent concurrency control
  private agentRunning: Map<string, number> = new Map()        // agentId -> current running count
  private agentManager: AgentManager

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager
  }

  /**
   * Enqueue a message and return the agent's reply
   */
  async enqueue(agentId: string, chatId: string, prompt: string, options?: EnqueueOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const turnId = options?.turnId?.trim() || randomUUID()
      const ownsTrace = !options?.agentOps
      const agentOps: AgentOpsTraceContext = options?.agentOps ?? {
        traceId: randomUUID(),
      }
      if (ownsTrace) {
        tryAgentOps(() => {
          startAgentOpsTrace({
            id: agentOps.traceId,
            kind: 'queue_turn',
            status: 'queued',
            agentId,
            chatId,
            turnId,
            coverage: 'exact',
          })
        })
      }
      const chatKey = `${agentId}:${chatId}`
      const queue = this.chatQueues.get(chatKey) ?? []
      queue.push({
        agentId,
        chatId,
        prompt,
        turnId,
        abortController: new AbortController(),
        agentOps,
        ownsTrace,
        requestedSkills: options?.requestedSkills,
        modelOverride: options?.modelOverride,
        browserProfileId: options?.browserProfileId,
        attachments: options?.attachments,
        suppressOutbound: options?.suppressOutbound,
        afterResult: options?.afterResult,
        resolve,
        reject,
      })
      this.chatQueues.set(chatKey, queue)

      // Update agent state queueDepth
      this.updateQueueDepth(agentId)

      // Try to schedule
      this.trySchedule(agentId, chatKey)
    })
  }

  /**
   * Cancel one exact turn, or every queued/running turn for a chat when turnId
   * is omitted. Removing queued work rejects its original promise with a typed
   * cancellation error.
   */
  cancel(chatId: string, turnId?: string): QueueCancelResult {
    let queued = 0
    let running = 0
    const affectedAgents = new Set<string>()

    for (const [chatKey, queue] of this.chatQueues) {
      const kept: QueueItem[] = []
      for (const item of queue) {
        if (item.chatId !== chatId || (turnId && item.turnId !== turnId)) {
          kept.push(item)
          continue
        }
        queued += 1
        affectedAgents.add(item.agentId)
        const error = new QueueCancellationError(item.chatId, item.turnId, 'queued')
        item.abortController.abort(error)
        this.finishCancelledItemTrace(item, error)
        item.reject(error)
      }
      if (kept.length > 0) this.chatQueues.set(chatKey, kept)
      else this.chatQueues.delete(chatKey)
    }

    for (const item of this.runningItems.values()) {
      if (item.chatId !== chatId || (turnId && item.turnId !== turnId)) continue
      if (item.abortController.signal.aborted) continue
      running += 1
      const error = new QueueCancellationError(item.chatId, item.turnId, 'running')
      item.abortController.abort(error)
    }

    for (const agentId of affectedAgents) {
      this.updateQueueDepth(agentId)
      this.tryScheduleAgent(agentId)
    }
    return { queued, running }
  }

  /**
   * Get the total queue depth for a given agent
   */
  getQueueDepth(agentId: string): number {
    let depth = 0
    for (const [key, queue] of this.chatQueues) {
      if (key.startsWith(`${agentId}:`)) {
        depth += queue.length
      }
    }
    return depth
  }

  /**
   * Try to schedule the next task for a given chat
   */
  private trySchedule(agentId: string, chatKey: string): void {
    const logger = getLogger()

    // If this chat is already running, wait for completion then auto-schedule
    if (this.chatRunning.has(chatKey)) {
      const pending = this.chatQueues.get(chatKey)?.length ?? 0
      logger.info({ agentId, chatKey, pending, category: 'queue' }, 'Chat already running, request queued')
      return
    }

    // Check agent concurrency limit
    const managed = this.agentManager.getAgent(agentId)
    const maxConcurrency = managed?.config.maxConcurrency ?? 1
    const currentRunning = this.agentRunning.get(agentId) ?? 0

    if (currentRunning >= maxConcurrency) {
      logger.info({ agentId, chatKey, currentRunning, maxConcurrency, category: 'queue' }, 'Agent at max concurrency, request queued')
      return
    }

    // Dequeue the next task
    const queue = this.chatQueues.get(chatKey)
    if (!queue || queue.length === 0) return

    const item = queue.shift()!
    this.chatRunning.add(chatKey)
    this.runningItems.set(chatKey, item)
    this.agentRunning.set(agentId, currentRunning + 1)
    this.updateQueueDepth(agentId)

    // Execute asynchronously
    this.processItem(item, chatKey).finally(() => {
      this.chatRunning.delete(chatKey)
      this.runningItems.delete(chatKey)
      const running = this.agentRunning.get(agentId) ?? 1
      this.agentRunning.set(agentId, Math.max(0, running - 1))
      this.updateQueueDepth(agentId)

      // Continue scheduling the next task for this chat
      this.trySchedule(agentId, chatKey)

      // Try scheduling tasks for other chats under the same agent
      this.tryScheduleAgent(agentId)
    })
  }

  /**
   * Try to schedule all pending chats under the same agent
   */
  private tryScheduleAgent(agentId: string): void {
    for (const chatKey of this.chatQueues.keys()) {
      if (chatKey.startsWith(`${agentId}:`)) {
        this.trySchedule(agentId, chatKey)
      }
    }
  }

  /**
   * Process a single queue item
   */
  private async processItem(item: QueueItem, chatKey: string): Promise<void> {
    const logger = getLogger()

    logger.info(
      { agentId: item.agentId, chatId: item.chatId, chatKey, category: 'queue' },
      'Processing queue task',
    )

    try {
      if (item.abortController.signal.aborted) {
        throw new QueueCancellationError(item.chatId, item.turnId, 'running')
      }
      const managed = this.agentManager.getAgent(item.agentId)
      if (!managed) {
        throw new Error(`Agent not found: ${item.agentId}`)
      }

      // Update agent state
      managed.state.isProcessing = true
      if (item.ownsTrace) {
        tryAgentOps(() => markAgentOpsTraceRunning(item.agentOps.traceId))
      }

      const processStartTime = Date.now()
      item.activeStartedAt = processStartTime
      logger.debug({
        agentId: item.agentId,
        chatId: item.chatId,
        chatKey,
        promptLength: item.prompt.length,
        hasAttachments: !!(item.attachments && item.attachments.length > 0),
        category: 'queue',
      }, 'Starting queue item processing')
      const executionState: NonNullable<import('./types.ts').ProcessParams['executionState']> = {
        status: 'pending',
      }
      const result = await managed.runtime.process({
        chatId: item.chatId,
        prompt: item.prompt,
        agentId: item.agentId,
        turnId: item.turnId,
        abortController: item.abortController,
        agentOps: item.agentOps,
        executionState,
        requestedSkills: item.requestedSkills,
        modelOverride: item.modelOverride,
        browserProfileId: item.browserProfileId,
        attachments: item.attachments,
        suppressOutbound: item.suppressOutbound,
      })

      if (item.abortController.signal.aborted) {
        throw new QueueCancellationError(item.chatId, item.turnId, 'running')
      }
      if (executionState.status === 'cancelled') {
        throw new QueueCancellationError(item.chatId, item.turnId, 'running')
      }
      if (executionState.status === 'failed') {
        const error = new Error(result.replace(/^Error:\s*/, '') || 'Agent runtime failed') as Error & { code?: string }
        error.code = executionState.errorCode ?? 'AGENT_RUNTIME_FAILED'
        throw error
      }

      // The cancellable agent turn ends with runtime completion. Post-result
      // memory hooks may still run, but are not a live turn and must not inflate
      // exact-abort running counts.
      this.runningItems.delete(chatKey)
      if (item.ownsTrace) {
        tryAgentOps(() => {
          recordAgentOpsActiveDuration(item.agentOps.traceId, Date.now() - processStartTime)
          finishAgentOpsTrace(item.agentOps.traceId, 'success')
        })
      }

      if (item.afterResult) {
        try {
          await item.afterResult(result)
        } catch (postErr) {
          logger.error({
            agentId: item.agentId,
            chatId: item.chatId,
            error: postErr instanceof Error ? postErr.message : String(postErr),
            category: 'queue',
          }, 'Post-result callback failed')
        }
      }

      // Update agent state
      managed.state.isProcessing = false
      managed.state.lastProcessedAt = new Date().toISOString()
      managed.state.totalProcessed++
      managed.state.lastError = null

      item.resolve(result)
    } catch (err) {
      const error = item.abortController.signal.aborted && !isQueueCancellationError(err)
        ? new QueueCancellationError(item.chatId, item.turnId, 'running')
        : err instanceof Error ? err : new Error(String(err))
      const cancelled = isQueueCancellationError(error)
      const log = cancelled ? logger.info.bind(logger) : logger.error.bind(logger)
      log({ agentId: item.agentId, chatId: item.chatId, turnId: item.turnId, error: error.message }, cancelled
        ? 'Queue task cancelled'
        : 'Queue task processing failed')

      // Update agent state
      const managed = this.agentManager.getAgent(item.agentId)
      if (managed) {
        managed.state.isProcessing = false
        managed.state.lastError = cancelled ? null : error.message
      }

      if (cancelled) {
        this.finishCancelledItemTrace(item, error)
      } else if (item.ownsTrace) {
        tryAgentOps(() => {
          if (item.activeStartedAt) {
            recordAgentOpsActiveDuration(item.agentOps.traceId, Date.now() - item.activeStartedAt)
          }
          finishAgentOpsTrace(item.agentOps.traceId, 'failed', {
            errorCode: (error as Error & { code?: string }).code ?? 'QUEUE_PROCESS_FAILED',
            stopReason: 'execution_error',
          })
        })
      }
      item.reject(error)
    }
  }

  private finishCancelledItemTrace(item: QueueItem, error: QueueCancellationError): void {
    tryAgentOps(() => {
      if (item.agentOps.spanId) {
        finishAgentOpsSpan(item.agentOps.spanId, 'cancelled', {
          errorCode: error.code,
          stopReason: error.phase,
        })
      }
      if (item.ownsTrace) {
        if (item.activeStartedAt) {
          recordAgentOpsActiveDuration(item.agentOps.traceId, Date.now() - item.activeStartedAt)
        }
        finishAgentOpsTrace(item.agentOps.traceId, 'cancelled', {
          errorCode: error.code,
          stopReason: error.phase,
        })
      }
    })
  }

  /**
   * Update agent state queueDepth
   */
  private updateQueueDepth(agentId: string): void {
    const managed = this.agentManager.getAgent(agentId)
    if (managed) {
      managed.state.queueDepth = this.getQueueDepth(agentId)
    }
  }
}
