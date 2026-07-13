// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// （渠道会话标题不再落原始 type/首条消息：好友昵称 → 实例自定义名 → 类型中文名）
import { AgentManager } from '../agent/manager.ts'
import { AgentQueue } from '../agent/queue.ts'
import { EventBus } from '../events/bus.ts'
import { saveMessage, upsertChat, getDatabase, getChannelRecord } from '../db/index.ts'
import { randomUUID } from 'node:crypto'
import { getLogger } from '../logger/index.ts'
import type { MemoryManager } from '../memory/index.ts'
import type { SkillsLoader } from '../skills/index.ts'
import { injectMessageTimestamp } from '../agent/message-timestamp.ts'
import { parseSkillInvocations } from '../skills/invoke.ts'
import { inferChannelType } from './config-schema.ts'
import { deriveChannelChatTitle } from './naming.ts'
import type { InboundMessage, Channel } from './types.ts'
import type { AgentToolUse } from '../events/types.ts'
import type { Attachment } from '../types/attachment.ts'
import { ErrorCode } from '../events/types.ts'
import { isQueueCancellationError } from '../agent/queue.ts'

export class MessageRouter {
  private channels: Channel[] = []
  private memoryManager: MemoryManager | null = null
  private skillsLoader: SkillsLoader | null = null

  constructor(
    private agentManager: AgentManager,
    private agentQueue: AgentQueue,
    private eventBus: EventBus,
    memoryManager?: MemoryManager,
    skillsLoader?: SkillsLoader,
  ) {
    if (memoryManager) {
      this.memoryManager = memoryManager
    }
    if (skillsLoader) {
      this.skillsLoader = skillsLoader
    }
    this.eventBus.subscribe({ types: ['complete'] }, (event) => {
      if (event.type === 'complete') {
        // [XJC-PATCH] suppressOutbound(定时任务)由 scheduler.saveTaskMessages 独占落库
        // (清洗 [[attach:]] 标记为 📎 行)。此处再落一条含原始标记的未清洗文本会造成
        // 本地任务会话「双条 + 标记泄漏」,故 suppressOutbound 时跳过 router 落库。
        if (event.fullText.trim() && !event.suppressOutbound) {
          this.persistCompletedReply(
            event.chatId,
            event.agentId,
            event.fullText,
            event.sessionId,
            event.turnId,
            event.toolUse,
            event.cancelled ? ErrorCode.CANCELLED : undefined,
            event.attachments,
          )
        } else if (event.cancelled && !event.suppressOutbound) {
          this.persistErroredReply(
            event.chatId,
            event.agentId,
            'Request cancelled.',
            ErrorCode.CANCELLED,
            event.turnId,
            event.toolUse,
          )
        }
        // [XJC] 调度器发起的运行 suppressOutbound=true：仍落库,但不由此处向渠道发送,
        // 渠道投递统一交给 scheduler.deliver()（cleanText + 📎，且尊重 delivery_mode）。
        // 否则渠道会话上的定时任务会「双发」，且 delivery_mode='none' 也会泄漏原始结果。
        if (!event.suppressOutbound && !event.cancelled) {
          this.handleOutbound(event.chatId, event.fullText)
        }
      }
    })
    this.eventBus.subscribe({ types: ['error'] }, (event) => {
      if (event.type === 'error') {
        this.persistErroredReply(event.chatId, event.agentId, event.error, event.errorCode, event.turnId, event.toolUse)
      }
    })
  }

  addChannel(channel: Channel) {
    this.channels.push(channel)
  }

  removeChannel(name: string) {
    this.channels = this.channels.filter((ch) => ch.name !== name)
  }

  // Handle inbound messages (from any channel)
  async handleInbound(message: InboundMessage): Promise<void> {
    const logger = getLogger()

    // Infer channel type (prefer message's channel field, otherwise match against registered channels)
    const channel = message.channel ?? this.inferChannel(message.chatId)

    // Prefer agentId from message (Web API scenario), otherwise route by chatId
    const managed = message.agentId
      ? this.agentManager.getAgent(message.agentId)
      : this.agentManager.resolveAgent(message.chatId)
    if (!managed) {
      logger.warn({ chatId: message.chatId, agentId: message.agentId }, 'No matching agent found')
      return
    }

    const { config } = managed

    // Check trigger (group chat scenario)
    if (message.isGroup && config.requiresTrigger !== false) {
      const trigger = config.trigger ? new RegExp(config.trigger, 'i') : null
      if (trigger && !trigger.test(message.content)) {
        return // not triggered in group chat, ignore
      }
    }

    // Parse skill invocations (from message itself or already parsed upstream)
    let requestedSkills = message.requestedSkills ?? []
    let contentForAgent = message.content

    if (requestedSkills.length === 0 && this.skillsLoader) {
      const knownNames = this.skillsLoader.getUsableSkillNamesForAgent(config)
      const parsed = parseSkillInvocations(message.content, knownNames)
      requestedSkills = parsed.requestedSkills
      contentForAgent = parsed.cleanContent || message.content
    }

    // Check if chat already exists (for new_chat event)
    // [XJC] 渠道会话标题：好友昵称 → 实例自定义名 → 类型中文名（web 会话仍用首条消息）
    const chatIdType = inferChannelType(message.chatId)
    const chatTitle = chatIdType === 'web'
      ? message.content.replace(/\n/g, ' ').slice(0, 50)
      : deriveChannelChatTitle({
          channelType: chatIdType,
          sender: message.sender,
          senderName: message.senderName,
          isGroup: message.isGroup,
          groupName: message.groupName,
          instanceLabel: this.resolveChannelInstanceLabel(message.chatId),
        })
    const db = getDatabase()
    const existingChat = db.query("SELECT 1 FROM chats WHERE chat_id = ?").get(message.chatId)

    // Deduplicate: skip if this message already exists (non-web channels only, web uses fresh UUIDs)
    if (channel !== 'web') {
      const existing = db.query('SELECT 1 FROM messages WHERE id = ? AND chat_id = ?').get(message.id, message.chatId)
      if (existing) {
        logger.debug({ id: message.id, chatId: message.chatId, channel }, 'Duplicate message skipped')
        return
      }
    }

    // Save to database
    // Only seed the title for a new conversation. Passing chatTitle on every
    // turn would overwrite a user-customized title now that upsertChat honors
    // explicit name updates.
    upsertChat(message.chatId, config.id, existingChat ? undefined : chatTitle, channel)
    saveMessage({
      id: message.id,
      chatId: message.chatId,
      sender: message.sender,
      senderName: message.senderName,
      content: message.content,
      timestamp: message.timestamp,
      isFromMe: false,
      isBotMessage: false,
      attachments: message.attachments ? JSON.stringify(message.attachments) : undefined,
    })

    // Emit events for frontend real-time updates
    if (!existingChat) {
      this.eventBus.emit({ type: 'new_chat', agentId: config.id, chatId: message.chatId, name: chatTitle, channel })
    }
    this.eventBus.emit({
      type: 'inbound_message', agentId: config.id, chatId: message.chatId,
      messageId: message.id, content: message.content, senderName: message.senderName, timestamp: message.timestamp,
    })

    logger.info({ agentId: config.id, chatId: message.chatId, requestedSkills }, 'Routing message to agent')

    // Enqueue for processing (pass requestedSkills)
    try {
      const contentForModel = injectMessageTimestamp(contentForAgent, {
        timestamp: message.timestamp,
      })

      await this.agentQueue.enqueue(
        config.id,
        message.chatId,
        contentForModel,
        {
          turnId: message.id,
          requestedSkills: requestedSkills.length > 0 ? requestedSkills : undefined,
          modelOverride: message.modelOverride,
          browserProfileId: message.browserProfileId,
          attachments: message.attachments,
          agentOps: message.agentOps,
          afterResult: async (result) => {
            if (!result.trim()) return
            if (!this.memoryManager) return
            // Workflow turns are internal execution plumbing. Persisting their
            // generated prompts/results as durable user memory pollutes future
            // conversations and double-counts hidden model work.
            if (message.agentOps?.internal || message.chatId.startsWith('workflow:')) return

            try {
              this.memoryManager.appendDailyLog(
                config.id,
                message.chatId,
                message.content,
                result,
                config.memory?.maxLogEntryLength,
              )
            } catch (logErr) {
              getLogger().error({ error: logErr, agentId: config.id }, 'Failed to append daily log')
            }

            if (message.isGroup || config.memory?.enabled === false) {
              return
            }

            try {
              await this.memoryManager.rememberTurn(config.id, message.chatId, message.content, result)
            } catch (memoryErr) {
              getLogger().error({ error: memoryErr, agentId: config.id }, 'Failed to append daily memory note')
            }
          },
        },
      )
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      if (isQueueCancellationError(err)) {
        logger.info({ chatId: message.chatId, turnId: message.id, phase: err.phase }, 'Message turn cancelled')
        if (err.phase === 'queued') {
          this.eventBus.emit({
            type: 'error',
            agentId: config.id,
            chatId: message.chatId,
            error: 'Request cancelled.',
            errorCode: ErrorCode.CANCELLED,
            turnId: message.id,
          })
        }
        return
      }
      logger.error({ error: err, chatId: message.chatId }, 'Message processing failed')

      // Emit error event so frontend and channels are notified
      this.eventBus.emit({
        type: 'error',
        agentId: config.id,
        chatId: message.chatId,
        error: errorMessage,
        turnId: message.id,
      })

      // Send error notification to the originating channel (avoid leaking internal details)
      const errorText = errorMessage.includes('timed out')
        ? '⚠️ 请求超时，请稍后重试。'
        : '⚠️ 处理失败，请稍后重试。'
      this.handleOutbound(message.chatId, errorText).catch(() => {})
    }
  }

  // Get statuses of all registered channels
  getChannelStatuses(): Array<{ name: string; connected: boolean }> {
    return this.channels.map((ch) => ({
      name: ch.name,
      connected: ch.isConnected(),
    }))
  }

  // Infer channel name from chatId prefix
  private inferChannel(chatId: string): string {
    for (const ch of this.channels) {
      if (ch.ownsChatId(chatId)) return ch.name
    }
    return 'web'
  }

  // [XJC] 查这条消息归属的渠道实例的自定义名称（实例 name 即 channels 表主键 id）
  private resolveChannelInstanceLabel(chatId: string): string | undefined {
    for (const ch of this.channels) {
      if (ch.ownsChatId(chatId)) {
        const record = getChannelRecord(ch.name)
        const label = record?.label?.trim()
        if (label) return label
      }
    }
    return undefined
  }

  // Handle outbound messages (send to the corresponding channel)
  private async handleOutbound(chatId: string, text: string) {
    for (const channel of this.channels) {
      if (channel.ownsChatId(chatId)) {
        try {
          await channel.sendMessage(chatId, text)
        } catch (err) {
          getLogger().error({ error: err, chatId }, 'Channel send failed')
        }
        return
      }
    }
  }

  private persistCompletedReply(
    chatId: string,
    agentId: string,
    fullText: string,
    sessionId: string,
    turnId?: string,
    toolUse?: AgentToolUse[],
    errorCode?: string,
    attachments?: Attachment[],
  ): void {
    if (!turnId || this.hasAssistantMessageForTurn(chatId, turnId)) return
    const senderName = this.getAgentDisplayName(agentId, chatId)

    saveMessage({
      id: randomUUID(),
      chatId,
      sender: 'assistant',
      senderName,
      content: fullText,
      timestamp: new Date().toISOString(),
      isFromMe: true,
      isBotMessage: true,
      attachments: attachments && attachments.length > 0 ? JSON.stringify(attachments) : undefined,
      toolUse: toolUse && toolUse.length > 0 ? JSON.stringify(toolUse) : undefined,
      sessionId: sessionId || undefined,
      turnId,
      errorCode,
    })
    upsertChat(chatId, agentId)
  }

  private persistErroredReply(
    chatId: string,
    agentId: string,
    error: string,
    errorCode?: string,
    turnId?: string,
    toolUse?: AgentToolUse[],
  ): void {
    if (!turnId || this.hasAssistantMessageForTurn(chatId, turnId)) return
    const senderName = this.getAgentDisplayName(agentId, chatId)

    saveMessage({
      id: randomUUID(),
      chatId,
      sender: 'assistant',
      senderName,
      content: errorCode === 'INSUFFICIENT_CREDITS' ? '' : `⚠️ ${error}`,
      timestamp: new Date().toISOString(),
      isFromMe: true,
      isBotMessage: true,
      toolUse: toolUse && toolUse.length > 0 ? JSON.stringify(toolUse) : undefined,
      turnId,
      errorCode,
    })
    upsertChat(chatId, agentId)
  }

  private hasAssistantMessageForTurn(chatId: string, turnId: string): boolean {
    const db = getDatabase()
    const existing = db.query(
      'SELECT 1 FROM messages WHERE chat_id = ? AND turn_id = ? AND is_bot_message = 1 LIMIT 1',
    ).get(chatId, turnId)
    return !!existing
  }

  private getAgentDisplayName(agentId: string, chatId: string): string {
    const direct = 'getAgent' in this.agentManager && typeof this.agentManager.getAgent === 'function'
      ? this.agentManager.getAgent(agentId)
      : undefined
    if (direct?.config.name) return direct.config.name

    const resolved = 'resolveAgent' in this.agentManager && typeof this.agentManager.resolveAgent === 'function'
      ? this.agentManager.resolveAgent(chatId)
      : undefined
    return resolved?.config.name ?? agentId
  }
}
