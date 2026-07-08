// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { Bot, InputFile } from 'grammy'
import { getLogger } from '../logger/index.ts'
import { assertSafeRemoteUrl } from './media-fetch.ts'
import type { Channel, InboundMessage, OnInboundMessage } from './types.ts'

const TELEGRAM_MAX_LENGTH = 4096
// Telegram caption limit; longer text is sent as a separate follow-up message
const TELEGRAM_CAPTION_LIMIT = 1024
// Bot API upload limit for files sent by bots
const TELEGRAM_MEDIA_MAX_BYTES = 50 * 1024 * 1024

const TELEGRAM_PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const TELEGRAM_VIDEO_EXTENSIONS = new Set(['mp4'])

/** Route a media file to the matching Bot API method by file extension. */
export function pickTelegramMediaKind(extension: string): 'photo' | 'video' | 'document' {
  if (TELEGRAM_PHOTO_EXTENSIONS.has(extension)) return 'photo'
  if (TELEGRAM_VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'document'
}

function inferTelegramMediaName(mediaUrl: string, isRemote: boolean): string {
  if (!isRemote) return basename(mediaUrl)
  try {
    return decodeURIComponent(basename(new URL(mediaUrl).pathname))
  } catch {
    return ''
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage
}

export class TelegramChannel implements Channel {
  name = 'telegram'

  private bot: Bot | null = null
  private botToken: string
  private opts: TelegramChannelOpts

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken
    this.opts = opts
  }

  async connect(): Promise<void> {
    const logger = getLogger()
    this.bot = new Bot(this.botToken)

    // /chatid — reply with current chat ID
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id
      const chatType = ctx.chat.type
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown'

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      )
    })

    // /ping — health check
    this.bot.command('ping', (ctx) => {
      ctx.reply('XiaoJuClaw is online.')
    })

    // Text message handler
    this.bot.on('message:text', async (ctx) => {
      // Only intercept registered Telegram built-in commands; other / messages pass through (may be skill invocations)
      const builtinCommands = new Set(['chatid', 'ping'])
      if (ctx.message.text.startsWith('/')) {
        const firstWord = ctx.message.text.split(/\s/)[0]!
        const cmd = firstWord.slice(1).toLowerCase().split('@')[0]! // handle /chatid@bot_name format
        if (builtinCommands.has(cmd)) return
      }

      const chatId = `tg:${ctx.chat.id}`
      let content = ctx.message.text
      const timestamp = new Date(ctx.message.date * 1000).toISOString()
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown'
      const sender = ctx.from?.id.toString() || ''
      const msgId = ctx.message.message_id.toString()
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'
      // 群聊时 ctx.chat.title 即真实群名（私聊无此字段）
      const groupName =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'
          ? ctx.chat.title
          : undefined

      // Handle @mention: if bot is mentioned, replace @bot_username with @XiaoJuClaw
      const botUsername = ctx.me?.username?.toLowerCase()
      if (botUsername) {
        const entities = ctx.message.entities || []
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase()
            return mentionText === `@${botUsername}`
          }
          return false
        })
        if (isBotMentioned) {
          // Replace @bot_username with @XiaoJuClaw for unified trigger format
          const regex = new RegExp(`@${botUsername}`, 'gi')
          content = content.replace(regex, '@XiaoJuClaw')
        }
      }

      const message: InboundMessage = {
        id: msgId,
        chatId,
        sender,
        senderName,
        content,
        timestamp,
        isGroup,
        channel: 'telegram',
        ...(groupName ? { groupName } : {}),
      }

      this.opts.onMessage(message)

      logger.debug(
        { chatId, sender: senderName },
        'Telegram message received',
      )
    })

    // Error handler
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error')
    })

    // Start in long polling mode
    return new Promise<void>((resolve, reject) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          )
          resolve()
        },
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err: msg }, 'Telegram bot failed to start')
        this.bot = null
        reject(new Error(`Telegram bot failed to start: ${msg}`))
      })
    })
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const logger = getLogger()
    if (!this.bot) {
      logger.warn('Telegram bot not initialized, cannot send message')
      return
    }

    try {
      const numericId = chatId.replace(/^tg:/, '')

      // Telegram limits each message to 4096 characters; longer messages need chunking
      if (text.length <= TELEGRAM_MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text, {
          parse_mode: 'Markdown',
        })
      } else {
        for (let i = 0; i < text.length; i += TELEGRAM_MAX_LENGTH) {
          const chunk = text.slice(i, i + TELEGRAM_MAX_LENGTH)
          await this.bot.api.sendMessage(numericId, chunk, {
            parse_mode: 'Markdown',
          })
        }
      }

      logger.debug({ chatId, length: text.length }, 'Telegram message sent')
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Telegram message')
    }
  }

  async sendMedia(chatId: string, text: string, mediaUrl: string): Promise<void> {
    const logger = getLogger()
    if (!this.bot) {
      logger.warn('Telegram bot not initialized, cannot send media')
      return
    }

    const numericId = chatId.replace(/^tg:/, '')
    const isRemote = /^https?:\/\//i.test(mediaUrl)
    // Remote 由 Telegram 服务端下载（InputFile(URL)），本地不缓存；此处至少做 SSRF 预检，
    // 挡掉内网/环回/云元数据地址与非 http(s) 协议。
    if (isRemote) {
      assertSafeRemoteUrl(mediaUrl)
    }
    const fileName = inferTelegramMediaName(mediaUrl, isRemote)
    const kind = pickTelegramMediaKind(
      fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '',
    )

    if (!isRemote) {
      if (!existsSync(mediaUrl)) {
        throw new Error(`媒体文件不存在：${mediaUrl}`)
      }
      const size = statSync(mediaUrl).size
      if (size > TELEGRAM_MEDIA_MAX_BYTES) {
        throw new Error(
          `文件大小 ${(size / 1024 / 1024).toFixed(1)}MB 超过 Telegram 单文件上限 50MB，已取消发送`,
        )
      }
    }

    const input = isRemote
      ? new InputFile(new URL(mediaUrl), fileName || undefined)
      : new InputFile(mediaUrl, fileName || undefined)
    // Telegram caption is limited to 1024 chars; longer text goes out as a follow-up message
    const caption = text && text.length <= TELEGRAM_CAPTION_LIMIT ? text : undefined

    try {
      if (kind === 'photo') {
        await this.bot.api.sendPhoto(numericId, input, { caption, parse_mode: 'Markdown' })
      } else if (kind === 'video') {
        await this.bot.api.sendVideo(numericId, input, { caption, parse_mode: 'Markdown' })
      } else {
        await this.bot.api.sendDocument(numericId, input, { caption, parse_mode: 'Markdown' })
      }

      if (text && !caption) {
        await this.sendMessage(chatId, text)
      }

      logger.debug({ chatId, kind, fileName }, 'Telegram media sent')
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Telegram media')
      throw err // Re-throw so caller knows the send failed
    }
  }

  isConnected(): boolean {
    return this.bot !== null
  }

  ownsChatId(chatId: string): boolean {
    return chatId.startsWith('tg:')
  }

  async disconnect(): Promise<void> {
    const logger = getLogger()
    if (this.bot) {
      try {
        await this.bot.stop()
      } catch (err) {
        // grammy's stop() internally calls getUpdates to confirm offset,
        // which may throw if token is invalid; safe to ignore
        logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'Telegram bot stop error (ignored)')
      }
      this.bot = null
      logger.info('Telegram bot stopped')
    }
  }
}
