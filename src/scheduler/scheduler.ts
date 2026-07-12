import { basename, resolve } from 'node:path'
import { getLogger } from '../logger/index.ts'
import {
  saveMessage,
  upsertChat,
} from '../db/index.ts'
import { sendToChat } from '../channel/outbound-service.ts'
import { getPaths } from '../config/index.ts'
import {
  extractAttachments,
  formatResultWithAttachmentLines,
  MAX_TASK_ATTACHMENTS,
  validateAttachmentPaths,
} from './attachments.ts'
import { buildTaskMediaAttachments } from './media-attachments.ts'
import { cleanOldLogs } from '../logger/reader.ts'
import {
  calculateTaskNextRun,
  deleteTaskRunLogsOlderThan,
  insertTaskRunLog,
  listDueTasks,
  listStuckTasks,
  updateTaskRecord,
} from '../task/index.ts'
import type { ScheduledTask } from '../db/index.ts'
import type { AgentQueue } from '../agent/queue.ts'
import type { AgentManager } from '../agent/manager.ts'
import type { EventBus } from '../events/index.ts'
import { startWorkflowRun } from '../workflow/runner.ts'

// Auto-pause after N consecutive failures
const MAX_CONSECUTIVE_FAILURES = 5
// Stuck detection threshold (5 minutes)
const STUCK_THRESHOLD_MS = 5 * 60 * 1000
// Log pruning interval (every 120 ticks, ~1 hour)
const PRUNE_INTERVAL_TICKS = 120
// Log retention days
const LOG_RETAIN_DAYS = 30

export class Scheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private tickCount = 0
  // [XJC] 进程内在途任务集合：区分「本进程正在慢跑」与「上次进程崩溃遗留的锁」。
  // 卡死恢复清锁 + 短退避后，若原执行仍在跑，下一 tick 可能再次选中同一任务导致
  // 重复并发执行/重复投递；用它在 executeTask 入口去重，并让 recoverStuckTasks 跳过在途任务。
  private inFlight = new Set<string>()

  constructor(
    private agentQueue: AgentQueue,
    private agentManager: AgentManager,
    private eventBus: EventBus,
    // [XJC] 工作流触发器：默认真实实现，测试可注入以隔离 workflow runtime。
    private startWorkflow: typeof startWorkflowRun = startWorkflowRun,
  ) {}

  /** Start scheduling loop (check every 30 seconds) */
  start(): void {
    const logger = getLogger()
    if (this.intervalId) return

    logger.info('Scheduler started, checking every 30 seconds')
    // Execute immediately
    this.tick().catch((err) => {
      logger.error({ error: String(err) }, 'Scheduler tick failed')
    })

    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ error: String(err) }, 'Scheduler tick failed')
      })
    }, 30_000)
  }

  /** Stop scheduling */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      getLogger().info('Scheduler stopped')
    }
  }

  /** Check and execute due tasks */
  private async tick(): Promise<void> {
    const logger = getLogger()

    // Stuck detection: reset timed-out task running_since
    this.recoverStuckTasks()

    const now = new Date().toISOString()
    const dueTasks = listDueTasks(now)

    for (const task of dueTasks) {
      // Lock task synchronously to prevent duplicate pickup on next tick (race condition fix)
      updateTaskRecord(task.id, { runningSince: now })

      // No await: execute multiple due tasks in parallel
      this.executeTask(task).catch((err) => {
        logger.error({ taskId: task.id, error: String(err), category: 'task' }, 'Scheduled task execution failed')
      })
    }

    // Periodically prune old logs
    this.tickCount++
    if (this.tickCount >= PRUNE_INTERVAL_TICKS) {
      this.tickCount = 0
      try {
        const cutoff = new Date(Date.now() - LOG_RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString()
        const deleted = deleteTaskRunLogsOlderThan(cutoff)
        if (deleted > 0) {
          logger.info({ deleted }, 'Pruned expired run logs')
        }
        // Clean expired system log files
        const deletedLogs = cleanOldLogs(LOG_RETAIN_DAYS)
        if (deletedLogs > 0) {
          logger.info({ deleted: deletedLogs }, 'Cleaned expired system log files')
        }
      } catch (err) {
        logger.error({ error: String(err) }, 'Failed to prune run logs')
      }
    }
  }

  /** Detect and recover stuck tasks */
  private recoverStuckTasks(): void {
    const logger = getLogger()
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString()
    const stuckTasks = listStuckTasks(cutoff)

    for (const task of stuckTasks) {
      // [XJC] 本进程仍在跑的任务不是「卡死遗留锁」，不要清锁（否则会被下个 tick 重复选中并发执行）。
      // 只恢复真正的孤儿锁（如上次进程崩溃留下的 running_since）。
      if (this.inFlight.has(task.id)) continue

      const newFailures = (task.consecutive_failures ?? 0) + 1
      logger.warn(
        { taskId: task.id, runningSince: task.running_since, consecutiveFailures: newFailures, category: 'task' },
        'Stuck task detected, resetting running_since'
      )

      insertTaskRunLog({
        taskId: task.id,
        runAt: task.running_since!,
        durationMs: Date.now() - new Date(task.running_since!).getTime(),
        status: 'error',
        error: `Task execution timed out (exceeded ${STUCK_THRESHOLD_MS / 1000}s)`,
      })

      if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Too many consecutive failures, auto-pause (pass consecutiveFailures for correct backoff nextRun)
        const nextRun = this.calculateNextRun(task, { consecutiveFailures: newFailures })
        updateTaskRecord(task.id, {
          runningSince: null,
          consecutiveFailures: newFailures,
          status: 'paused',
          lastResult: `ERROR: ${newFailures} consecutive failures, auto-paused`,
          nextRun,
        })
        logger.warn({ taskId: task.id, consecutiveFailures: newFailures, category: 'task' }, 'Too many consecutive failures, task auto-paused')
      } else {
        // Calculate next run time with backoff
        const nextRun = this.calculateNextRun(task, { consecutiveFailures: newFailures })
        updateTaskRecord(task.id, {
          runningSince: null,
          consecutiveFailures: newFailures,
          lastResult: `ERROR: Task execution timed out`,
          nextRun,
        })
      }
    }
  }

  /**
   * [XJC] 产出任务结果：workflow_id 非空则触发工作流运行并取最终产出（outputs 末项，与前端「最终结果」一致），
   * 否则跑一次 agent 回合。工作流未成功会抛错，交由调用方的失败处理（退避/日志/自动暂停）。
   */
  private async produceResult(task: ScheduledTask): Promise<string> {
    if (task.workflow_id) {
      const { done } = this.startWorkflow(task.workflow_id, {})
      const final = await done
      if (final.status !== 'success') {
        throw new Error(final.error || `工作流运行未成功（状态：${final.status}）`)
      }
      const output = final.outputs.at(-1)
      return output && output.trim() ? output : '(工作流无输出)'
    }
    const result = await this.agentQueue.enqueue(task.agent_id, task.chat_id, task.prompt, { suppressOutbound: true })
    return result ?? '(no output)'
  }

  /** Execute a single task */
  async executeTask(task: ScheduledTask): Promise<void> {
    const logger = getLogger()

    // [XJC] 在途去重：同一任务在本进程已在跑则跳过，避免「卡死恢复清锁+短退避」后被重复并发执行。
    if (this.inFlight.has(task.id)) {
      logger.warn({ taskId: task.id, category: 'task' }, 'Task already in-flight in this process, skipping duplicate execution')
      return
    }
    this.inFlight.add(task.id)

    const runAt = new Date().toISOString()
    const startMs = Date.now()

    logger.info({ taskId: task.id, agentId: task.agent_id, taskName: task.name, category: 'task' }, 'Executing scheduled task')

    // running_since already set synchronously in tick(), no need to repeat

    try {
      // [XJC] 结果产出：workflow_id 非空 → 触发工作流并取最终产出；否则跑 agent 回合。
      // suppressOutbound：调度器自己经 deliver() 向 delivery_target 投递（cleanText + 📎、尊重 delivery_mode）；
      // 若不抑制，runtime 的 complete 会被 MessageRouter 再向 task.chat_id 发一次（渠道会话时即双发/泄漏）。
      const result = await this.produceResult(task)
      const durationMs = Date.now() - startMs

      // [XJC] 持久化字段（run-log result / task lastResult）与桌面会话落库口径一致：
      // 不存原始 [[attach:]] 标记，改存 cleanText + 每个附件一行 📎 <路径>。
      const displayResult = this.toDisplayResult(result)

      // Save execution result to messages table for Chat page visibility
      this.saveTaskMessages(task, runAt, result)

      // Deliver to external channel (best-effort)
      const deliveryStatus = await this.deliver(task, result)

      insertTaskRunLog({
        taskId: task.id,
        runAt,
        durationMs,
        status: 'success',
        result: displayResult,
        deliveryStatus,
      })

      // Calculate next run time (reset backoff on success)
      const nextRun = this.calculateNextRun(task)
      if (nextRun) {
        updateTaskRecord(task.id, {
          lastRun: runAt,
          nextRun,
          runningSince: null,
          consecutiveFailures: 0,
          lastResult: displayResult.slice(0, 500),
        })
      } else {
        // Mark once-type tasks as completed after execution
        updateTaskRecord(task.id, {
          lastRun: runAt,
          nextRun: null,
          status: 'completed',
          runningSince: null,
          consecutiveFailures: 0,
          lastResult: displayResult.slice(0, 500),
        })
      }

      logger.info({ taskId: task.id, agentId: task.agent_id, durationMs, category: 'task' }, 'Scheduled task executed successfully')
    } catch (err) {
      const durationMs = Date.now() - startMs
      const errorMsg = err instanceof Error ? err.message : String(err)

      insertTaskRunLog({
        taskId: task.id,
        runAt,
        durationMs,
        status: 'error',
        error: errorMsg,
        deliveryStatus: 'skipped',
      })

      const newFailures = (task.consecutive_failures ?? 0) + 1

      if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Too many consecutive failures, auto-pause (pass consecutiveFailures for correct backoff nextRun)
        const nextRun = this.calculateNextRun(task, { consecutiveFailures: newFailures })
        updateTaskRecord(task.id, {
          lastRun: runAt,
          nextRun,
          runningSince: null,
          consecutiveFailures: newFailures,
          status: 'paused',
          lastResult: `ERROR: ${errorMsg}`.slice(0, 500),
        })
        logger.warn({ taskId: task.id, consecutiveFailures: newFailures, category: 'task' }, 'Too many consecutive failures, task auto-paused')
      } else {
        // Calculate next run time with backoff
        const nextRun = this.calculateNextRun(task, { consecutiveFailures: newFailures })
        if (nextRun) {
          updateTaskRecord(task.id, {
            lastRun: runAt,
            nextRun,
            runningSince: null,
            consecutiveFailures: newFailures,
            lastResult: `ERROR: ${errorMsg}`.slice(0, 500),
          })
        } else {
          updateTaskRecord(task.id, {
            lastRun: runAt,
            nextRun: null,
            status: 'completed',
            runningSince: null,
            consecutiveFailures: newFailures,
            lastResult: `ERROR: ${errorMsg}`.slice(0, 500),
          })
        }
      }

      logger.error({ taskId: task.id, agentId: task.agent_id, error: errorMsg, consecutiveFailures: newFailures, category: 'task' }, 'Scheduled task execution failed')
    } finally {
      this.inFlight.delete(task.id)
    }
  }

  /** Deliver result to external channel (best-effort, failure does not affect task status) */
  private async deliver(
    task: Pick<ScheduledTask, 'id' | 'agent_id' | 'name' | 'prompt' | 'delivery_mode' | 'delivery_target'>,
    text: string,
  ): Promise<'sent' | 'failed' | 'skipped'> {
    if (task.delivery_mode !== 'push' || !task.delivery_target) {
      return 'skipped'
    }

    const logger = getLogger()
    const chatId = task.delivery_target

    // [XJC] 任务产物附件：提取 [[attach:...]] 标记，只放行 agent 工作区内真实存在的文件。
    // deliver 承诺绝不影响任务 success，准备阶段任何意外都吞掉并退回纯文本投递。
    let cleanText = text
    let attachments: string[] = []
    try {
      const extracted = extractAttachments(text)
      cleanText = extracted.cleanText
      if (extracted.paths.length > 0) {
        const agentWorkspaceDir = resolve(getPaths().agents, task.agent_id)
        const { accepted, rejected } = validateAttachmentPaths(extracted.paths, agentWorkspaceDir)
        for (const { path, reason } of rejected) {
          logger.warn({ taskId: task.id, path, reason, category: 'task' }, 'Task attachment rejected, skipping')
        }
        if (accepted.length > MAX_TASK_ATTACHMENTS) {
          logger.warn(
            { taskId: task.id, total: accepted.length, limit: MAX_TASK_ATTACHMENTS, category: 'task' },
            'Too many task attachments, extra ones ignored',
          )
        }
        attachments = accepted.slice(0, MAX_TASK_ATTACHMENTS)
      }
    } catch (err) {
      logger.warn({ taskId: task.id, error: String(err), category: 'task' }, 'Task attachment preparation failed, delivering text only')
    }

    try {
      const taskName = task.name || task.prompt.slice(0, 30)
      const header = `[Task: ${taskName}]`
      // Send directly through the channel outbound service and await the real send
      // result, so delivery_status reflects what actually reached the channel.
      // Deliberately NOT emitting a 'complete' event here: router.handleOutbound also
      // subscribes to 'complete' events, so emitting AND sending directly would push
      // the same message to the channel twice.
      await sendToChat({
        chatId,
        text: cleanText ? `${header}\n\n${cleanText}` : header,
      })
      logger.info({ taskId: task.id, deliveryTarget: chatId }, 'Task result delivered')
    } catch (err) {
      // 文本失败即整体 failed，附件不再发送
      logger.warn({ taskId: task.id, deliveryTarget: chatId, error: String(err) }, 'Delivery failed (best-effort)')
      return 'failed'
    }

    // 文本已送达即算 sent；附件逐个 best-effort，失败不降级状态
    const failedAttachments: string[] = []
    for (const path of attachments) {
      try {
        await sendToChat({ chatId, mediaUrl: path })
        logger.info({ taskId: task.id, deliveryTarget: chatId, path }, 'Task attachment delivered')
      } catch (err) {
        failedAttachments.push(path)
        logger.warn(
          { taskId: task.id, deliveryTarget: chatId, path, error: String(err), category: 'task' },
          'Task attachment delivery failed (best-effort)',
        )
      }
    }

    if (failedAttachments.length > 0) {
      const fileNames = failedAttachments.map((path) => basename(path)).join('、')
      try {
        await sendToChat({ chatId, text: `${failedAttachments.length} 个附件发送失败：${fileNames}` })
      } catch (err) {
        logger.warn(
          { taskId: task.id, deliveryTarget: chatId, error: String(err), category: 'task' },
          'Attachment failure notice delivery failed',
        )
      }
    }

    return 'sent'
  }

  /** Save task execution messages to messages table */
  saveTaskMessages(
    task: Pick<ScheduledTask, 'id' | 'chat_id' | 'agent_id' | 'prompt' | 'name'>,
    runAt: string,
    result: string,
    sender = 'scheduler',
    senderName = 'Scheduled Task',
  ): void {
    const timestamp = new Date().toISOString()

    // [XJC] 桌面会话落库不暴露内部 [[attach:]] 标记：改存 cleanText + 每个附件一行 📎 <路径>
    const { cleanText, paths } = extractAttachments(result)
    const displayResult = formatResultWithAttachmentLines(cleanText, paths)

    // [XJC] 结构化媒体附件：把工作区内、真实存在的图片/视频转成 messages.attachments，
    // 让定时任务产出在应用内像 web 聊天一样内联展示（正文仍保留上面的 📎 行不变）。
    // 附件准备任何意外都吞掉，绝不影响消息落库（与 deliver() 的 best-effort 口径一致）。
    let attachmentsJson: string | undefined
    try {
      if (paths.length > 0) {
        const agentWorkspaceDir = resolve(getPaths().agents, task.agent_id)
        const mediaAttachments = buildTaskMediaAttachments(paths, agentWorkspaceDir)
        if (mediaAttachments.length > 0) {
          attachmentsJson = JSON.stringify(mediaAttachments)
        }
      }
    } catch (err) {
      getLogger().warn(
        { taskId: task.id, error: String(err), category: 'task' },
        'Task media attachment preparation failed, saving message text only',
      )
    }

    // Save user prompt message (isFromMe=false means not sent by bot, consistent with router semantics)
    saveMessage({
      id: `${task.id}-${runAt}-user`,
      chatId: task.chat_id,
      sender,
      senderName,
      content: task.prompt,
      timestamp: runAt,
      isFromMe: false,
      isBotMessage: false,
    })

    // Save bot result message (isFromMe=true means sent by bot)
    // [XJC] attachments：结构化图片/视频，供应用内内联展示（无媒体产物时为 undefined，与旧行为一致）
    saveMessage({
      id: `${task.id}-${runAt}-bot`,
      chatId: task.chat_id,
      sender: task.agent_id,
      senderName: task.agent_id,
      content: displayResult,
      timestamp,
      isFromMe: true,
      isBotMessage: true,
      attachments: attachmentsJson,
    })

    // Update chat record
    const taskName = task.name || task.prompt.slice(0, 30)
    upsertChat(task.chat_id, task.agent_id, `Task: ${taskName}`, 'task')
  }

  /**
   * [XJC] 生成用于持久化/展示的结果文本：剥离内部 [[attach:]] 标记，
   * 每个附件改写成一行 📎 <路径>，与 saveTaskMessages 桌面会话落库口径一致，
   * 保证「任务详情 lastResult / 运行日志 result」不出现内部标记语法。
   * 无标记文本原样返回（extractAttachments 幂等）。
   */
  private toDisplayResult(result: string): string {
    const { cleanText, paths } = extractAttachments(result)
    return formatResultWithAttachmentLines(cleanText, paths)
  }

  /** Manually execute task (no running_since, does not affect consecutiveFailures) */
  async runManually(task: ScheduledTask): Promise<{ status: string; result?: string; error?: string }> {
    const runAt = new Date().toISOString()
    const startMs = Date.now()
    const runId = crypto.randomUUID().slice(0, 8)

    try {
      // [XJC] 结果产出同 executeTask：workflow_id 非空触发工作流，否则 agent 回合。
      // suppressOutbound：手动运行同样由 deliver() 独占渠道投递，避免 runtime.complete 经路由重复发送。
      const result = await this.produceResult(task)
      const durationMs = Date.now() - startMs

      // [XJC] run-log result 与桌面会话落库口径一致：清掉 [[attach:]] 标记、附件改 📎 行
      const displayResult = this.toDisplayResult(result)

      // Save execution result to messages table
      this.saveTaskMessages(task, `${runId}-${runAt}`, result, 'manual', 'Manual Run')

      // Deliver to external channel
      const deliveryStatus = await this.deliver(task, result)

      // Record run log
      insertTaskRunLog({
        taskId: task.id,
        runAt,
        durationMs,
        status: 'success',
        result: `[manual] ${displayResult}`.slice(0, 500),
        deliveryStatus,
      })

      return { status: 'success', result }
    } catch (err) {
      const durationMs = Date.now() - startMs
      const error = err instanceof Error ? err.message : String(err)

      // Record failure log
      insertTaskRunLog({
        taskId: task.id,
        runAt,
        durationMs,
        status: 'error',
        error: `[manual] ${error}`,
        deliveryStatus: 'skipped',
      })

      return { status: 'error', error }
    }
  }

  /** Calculate next run time */
  calculateNextRun(
    task: Pick<ScheduledTask, 'schedule_type' | 'schedule_value' | 'last_run'> & { timezone?: string | null },
    options?: { consecutiveFailures?: number },
  ): string | null {
    return calculateTaskNextRun(task, options)
  }
}
