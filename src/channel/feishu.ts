import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { getLogger } from '../logger/index.ts'
import { fetchRemoteMediaToBuffer } from './media-fetch.ts'
import type { EventBus } from '../events/bus.ts'
import type { Channel, InboundMessage, OnInboundMessage } from './types.ts'

const FEISHU_TEXT_CHUNK_LIMIT = 4000
// Interactive cards have stricter limits due to JSON wrapper overhead (~200 bytes)
const FEISHU_CARD_CHUNK_LIMIT = 3500
// Feishu OpenAPI limits: images up to 10MB, files up to 30MB
const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024

// Formats accepted by im.image.create (JPEG/PNG/WEBP/GIF/TIFF/BMP/ICO)
const FEISHU_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'ico'])

type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

const FEISHU_FILE_TYPE_BY_EXTENSION: Record<string, FeishuFileType> = {
  opus: 'opus',
  mp4: 'mp4',
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  xls: 'xls',
  xlsx: 'xls',
  ppt: 'ppt',
  pptx: 'ppt',
}

/** Map a file extension to the file_type expected by im.file.create. */
export function mapFeishuFileType(extension: string): FeishuFileType {
  return FEISHU_FILE_TYPE_BY_EXTENSION[extension.toLowerCase()] ?? 'stream'
}

function feishuExtensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

function inferRemoteFileName(url: string): string {
  try {
    const name = decodeURIComponent(basename(new URL(url).pathname))
    if (name) return name
  } catch {
    // fall through to the generated name
  }
  return `media-${Date.now()}`
}

/** SDK typings expose upload results unwrapped, but stay defensive about {data:{...}} wrappers. */
function extractUploadKey(res: unknown, key: 'image_key' | 'file_key'): string | undefined {
  if (!res || typeof res !== 'object') return undefined
  const direct = (res as Record<string, unknown>)[key]
  if (typeof direct === 'string') return direct
  const data = (res as Record<string, unknown>).data
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>)[key]
    if (typeof nested === 'string') return nested
  }
  return undefined
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage
  eventBus?: EventBus
  _client?: Lark.Client  // for test injection
}

/**
 * Feishu message event data structure (im.message.receive_v1)
 */
interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string
      user_id?: string
      union_id?: string
    }
    sender_type?: string
    tenant_key?: string
  }
  message: {
    message_id: string
    root_id?: string
    parent_id?: string
    chat_id: string
    chat_type: 'p2p' | 'group'
    message_type: string
    content: string
    mentions?: Array<{
      key: string
      id: { open_id?: string; user_id?: string; union_id?: string }
      name: string
      tenant_key?: string
    }>
  }
}

/**
 * Extract plain text from Feishu message content JSON
 */
export function extractTextContent(contentJson: string, messageType: string): string {
  try {
    const parsed = JSON.parse(contentJson)

    if (messageType === 'text') {
      return (parsed.text as string) || ''
    }

    if (messageType === 'post') {
      return extractPostText(parsed)
    }

    return ''
  } catch {
    return contentJson
  }
}

/**
 * Extract text from rich text (post) messages
 */
export function extractPostText(parsed: Record<string, unknown>): string {
  // post format: { title?, content: [[{ tag, text?, ... }]] } or { zh_cn: { title?, content: [...] } }
  const postBody = (parsed.zh_cn || parsed.en_us || parsed) as Record<string, unknown>
  const title = (postBody.title as string) || ''
  const contentBlocks = (postBody.content || []) as Array<Array<Record<string, unknown>>>

  const parts: string[] = []
  if (title) parts.push(title)

  for (const paragraph of contentBlocks) {
    const paraTexts: string[] = []
    for (const element of paragraph) {
      if (element.tag === 'text') {
        paraTexts.push(element.text as string)
      } else if (element.tag === 'a') {
        paraTexts.push((element.text as string) || (element.href as string) || '')
      } else if (element.tag === 'at') {
        // @mention: preserve @name format
        if (element.user_name) {
          paraTexts.push(`@${element.user_name}`)
        }
      } else if (element.tag === 'img') {
        paraTexts.push('[image]')
      }
    }
    if (paraTexts.length > 0) {
      parts.push(paraTexts.join(''))
    }
  }

  return parts.join('\n')
}

/**
 * Strip @mentions of the bot itself from message text
 */
export function stripBotMention(
  text: string,
  mentions: Array<{ key: string; id: { open_id?: string }; name: string }>,
  botOpenId: string,
): string {
  let result = text
  for (const mention of mentions) {
    if (mention.id.open_id === botOpenId) {
      // Remove @bot placeholder (e.g. @_user_1) and name
      result = result.replace(new RegExp(mention.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
    }
  }
  return result.trim()
}

/**
 * Split text into chunks
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit))
  }
  return chunks
}

export class FeishuChannel implements Channel {
  name = 'feishu'

  private client: Lark.Client
  private wsClient: Lark.WSClient | null = null
  private _connected = false
  private appId: string
  private appSecret: string
  private opts: FeishuChannelOpts
  private botOpenId: string | null = null
  private eventBus: EventBus | null = null
  private unsubscribeEvents: (() => void) | null = null
  private pendingReactions: Map<string, { messageId: string; reactionId: string }> = new Map()

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId
    this.appSecret = appSecret
    this.opts = opts
    this.eventBus = opts.eventBus ?? null

    this.client = opts._client ?? new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
    })
  }

  async connect(): Promise<void> {
    const logger = getLogger()

    // Get bot's open_id (used for @mention filtering)
    try {
      const response = await this.client.request<{ code: number; bot?: { open_id?: string; bot_name?: string }; data?: { bot?: { open_id?: string; bot_name?: string } } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      })
      const bot = response.bot || response.data?.bot
      if (bot?.open_id) {
        this.botOpenId = bot.open_id
        logger.info({ botOpenId: this.botOpenId, botName: bot.bot_name }, 'Feishu bot info retrieved')
      }
    } catch (err) {
      logger.warn({ error: err }, 'Failed to get Feishu bot info, @mention filtering may be inaccurate')
    }

    // Create event dispatcher
    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          this.handleMessageEvent(data as FeishuMessageEvent)
        } catch (err) {
          logger.error({ error: err }, 'Failed to process Feishu message event')
        }
      },
    })

    // Use WebSocket long connection to receive events
    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    })

    await this.wsClient.start({ eventDispatcher })
    logger.info('Feishu WebSocket long connection started')
    // WSClient.start is async without callback, give some time for connection
    await new Promise<void>(r => setTimeout(r, 1500))
    this._connected = true

    if (this.eventBus) {
      this.unsubscribeEvents = this.eventBus.subscribe(
        { types: ['complete', 'error'] },
        (event) => {
          if ('chatId' in event && event.chatId?.startsWith('feishu:')) {
            this.removeProcessingReaction(event.chatId)
          }
        }
      )
    }
  }

  /**
   * Handle inbound message event
   */
  private handleMessageEvent(event: FeishuMessageEvent): void {
    const logger = getLogger()
    const { sender, message: msg } = event

    // Only process text and rich text messages
    if (msg.message_type !== 'text' && msg.message_type !== 'post') {
      logger.debug({ messageType: msg.message_type }, 'Feishu: skipping non-text message')
      return
    }

    // Extract text content
    let content = extractTextContent(msg.content, msg.message_type)
    if (!content) return

    // Handle @mention: strip bot's own @mentions
    if (msg.mentions && this.botOpenId) {
      content = stripBotMention(content, msg.mentions, this.botOpenId)
    }

    const chatId = `feishu:${msg.chat_id}`
    const senderId = sender.sender_id.open_id || sender.sender_id.user_id || 'unknown'
    const isGroup = msg.chat_type === 'group'

    // Find sender name from mentions, otherwise use open_id
    const senderName = senderId

    const inbound: InboundMessage = {
      id: msg.message_id,
      chatId,
      sender: senderId,
      senderName,
      content,
      timestamp: new Date().toISOString(),
      isGroup,
      channel: 'feishu',
    }

    // Asynchronously add processing reaction (non-blocking)
    this.addProcessingReaction(msg.message_id, chatId)

    this.opts.onMessage(inbound)
    logger.debug({ chatId, sender: senderId, chatType: msg.chat_type }, 'Feishu message received')
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const logger = getLogger()

    try {
      const feishuChatId = chatId.replace(/^feishu:/, '')

      // Check for code blocks or tables to choose message format
      const shouldUseCard = /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)

      // Use stricter limit for cards (JSON wrapper overhead)
      const chunkLimit = shouldUseCard ? FEISHU_CARD_CHUNK_LIMIT : FEISHU_TEXT_CHUNK_LIMIT
      const chunks = chunkText(text, chunkLimit)

      for (const chunk of chunks) {
        if (shouldUseCard) {
          try {
            await this.sendCard(feishuChatId, chunk)
          } catch (cardErr) {
            // Fallback to post format if card fails (e.g. content too long)
            logger.warn({ chatId, error: cardErr }, 'Feishu card send failed, falling back to post format')
            await this.sendPost(feishuChatId, chunk)
          }
        } else {
          await this.sendPost(feishuChatId, chunk)
        }
      }

      logger.debug({ chatId, length: text.length }, 'Feishu message sent')
    } catch (err) {
      logger.error({ chatId, error: err }, 'Feishu message send failed')
      throw err  // Re-throw so caller knows the send failed
    }
  }

  async sendMedia(chatId: string, text: string, mediaUrl: string): Promise<void> {
    const logger = getLogger()
    const feishuChatId = chatId.replace(/^feishu:/, '')
    const isRemote = /^https?:\/\//i.test(mediaUrl)

    let tempDir: string | null = null
    try {
      let localPath = mediaUrl
      let fileName: string

      if (isRemote) {
        // Remote media must be downloaded first: im.image/file.create only accept binary uploads.
        // 大小上限按扩展名区分（图片 10MB / 文件 30MB），经 media-fetch 做 SSRF 校验 + 下载即限流。
        fileName = inferRemoteFileName(mediaUrl)
        const remoteMax = FEISHU_IMAGE_EXTENSIONS.has(feishuExtensionOf(fileName))
          ? FEISHU_IMAGE_MAX_BYTES
          : FEISHU_FILE_MAX_BYTES
        const remote = await fetchRemoteMediaToBuffer(mediaUrl, { maxBytes: remoteMax })
        tempDir = mkdtempSync(join(tmpdir(), 'xiaojuclaw-feishu-media-'))
        localPath = join(tempDir, fileName)
        writeFileSync(localPath, remote.buffer)
      } else {
        if (!existsSync(mediaUrl)) {
          throw new Error(`媒体文件不存在：${mediaUrl}`)
        }
        fileName = basename(mediaUrl)
      }

      const extension = feishuExtensionOf(fileName)
      const size = statSync(localPath).size
      if (size === 0) {
        throw new Error(`媒体文件为空，飞书不支持发送空文件：${fileName}`)
      }

      if (FEISHU_IMAGE_EXTENSIONS.has(extension)) {
        if (size > FEISHU_IMAGE_MAX_BYTES) {
          throw new Error(
            `图片大小 ${(size / 1024 / 1024).toFixed(1)}MB 超过飞书图片上限 10MB，已取消发送`,
          )
        }
        const uploaded = await this.client.im.image.create({
          data: { image_type: 'message', image: createReadStream(localPath) },
        })
        const imageKey = extractUploadKey(uploaded, 'image_key')
        if (!imageKey) {
          throw new Error('飞书图片上传失败：接口未返回 image_key')
        }
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: feishuChatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        })
      } else {
        if (size > FEISHU_FILE_MAX_BYTES) {
          throw new Error(
            `文件大小 ${(size / 1024 / 1024).toFixed(1)}MB 超过飞书文件上限 30MB，已取消发送`,
          )
        }
        const uploaded = await this.client.im.file.create({
          data: {
            file_type: mapFeishuFileType(extension),
            file_name: fileName,
            file: createReadStream(localPath),
          },
        })
        const fileKey = extractUploadKey(uploaded, 'file_key')
        if (!fileKey) {
          throw new Error('飞书文件上传失败：接口未返回 file_key')
        }
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: feishuChatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        })
      }

      // Feishu media messages carry no caption; send accompanying text separately
      if (text.trim()) {
        await this.sendMessage(chatId, text)
      }

      logger.debug({ chatId, fileName, size }, 'Feishu media sent')
    } catch (err) {
      logger.error({ chatId, error: err }, 'Feishu media send failed')
      throw err  // Re-throw so caller knows the send failed
    } finally {
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {
          // ignore temp cleanup errors
        }
      }
    }
  }

  /**
   * Send in rich text (post) format (supports basic markdown)
   */
  private async sendPost(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: 'md', text }]],
          },
        }),
      },
    })
  }

  /**
   * Send as interactive card (supports code blocks, tables, etc.)
   */
  private async sendCard(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          config: { wide_screen_mode: true },
          body: {
            elements: [{ tag: 'markdown', content: text }],
          },
        }),
      },
    })
  }

  private async addProcessingReaction(messageId: string, chatId: string): Promise<void> {
    try {
      const res = await this.client.im.messageReaction.create({
        data: { reaction_type: { emoji_type: 'Typing' } },
        path: { message_id: messageId },
      })
      if (res?.data?.reaction_id) {
        this.pendingReactions.set(chatId, { messageId, reactionId: res.data.reaction_id })
      }
    } catch (err) {
      getLogger().debug({ error: err, messageId }, 'Failed to add Feishu reaction')
    }
  }

  private async removeProcessingReaction(chatId: string): Promise<void> {
    const pending = this.pendingReactions.get(chatId)
    if (!pending) return
    this.pendingReactions.delete(chatId)
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: pending.messageId, reaction_id: pending.reactionId },
      })
    } catch (err) {
      getLogger().debug({ error: err, chatId }, 'Failed to remove Feishu reaction')
    }
  }

  isConnected(): boolean {
    return this._connected
  }

  ownsChatId(chatId: string): boolean {
    return chatId.startsWith('feishu:')
  }

  async disconnect(): Promise<void> {
    const logger = getLogger()
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents()
      this.unsubscribeEvents = null
    }
    if (this.wsClient) {
      try {
        this.wsClient.close()
      } catch {
        // ignore close errors
      }
      this.wsClient = null
      this._connected = false
      logger.info('Feishu WebSocket connection closed')
    }
  }
}
