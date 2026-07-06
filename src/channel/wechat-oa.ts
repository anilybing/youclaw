// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/env.ts'
import { getAuthToken } from '../routes/auth.ts'
import { getDatabase } from '../db/index.ts'
import type { Channel, InboundMessage, OnInboundMessage } from './types.ts'

export interface WechatOAChannelOpts {
  onMessage: OnInboundMessage
}

/**
 * WeChat Official Account channel via ReadmeX Bridge (Long Polling).
 * Communicates with ReadmeX's Telegram-API-compatible bridge endpoints.
 * Uses the logged-in user's auth token automatically (no manual config needed).
 */
export class WechatOAChannel implements Channel {
  name = 'wechat-oa'

  private _connected = false
  private abortController: AbortController | null = null
  private offset = 0
  private _offsetLoaded = false
  private pollPromise: Promise<void> | null = null
  private opts: WechatOAChannelOpts

  constructor(opts: WechatOAChannelOpts) {
    this.opts = opts
  }

  private get kvKey(): string {
    return `wechat_oa_offset:${this.name}`
  }

  private loadOffset(): void {
    const db = getDatabase()
    const row = db.query('SELECT value FROM kv_state WHERE key = ?').get(this.kvKey) as { value: string } | null
    if (row) {
      this.offset = Number(row.value)
      this._offsetLoaded = true
      getLogger().info({ offset: this.offset }, 'WeChat OA restored offset from database')
    }
  }

  private saveOffset(): void {
    const db = getDatabase()
    db.run(
      'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
      [this.kvKey, String(this.offset)]
    )
  }

  private getToken(): string {
    const token = getAuthToken()
    if (!token) {
      throw new Error('Not logged in: WeChat OA channel requires ReadmeX login')
    }
    return token
  }

  async connect(): Promise<void> {
    const logger = getLogger()
    this.loadOffset()
    const baseUrl = this.getBaseUrl()
    const token = this.getToken()

    // Verify connectivity with a quick non-blocking getUpdates
    const res = await fetch(`${baseUrl}/api/wechat/getUpdates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        rdxtoken: token,
      },
      body: JSON.stringify({ timeout: 0, limit: 1 }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`WeChat OA bridge connectivity check failed: ${res.status} ${text}`)
    }
    // Consume body to release connection
    await res.text().catch(() => {})

    // Bootstrap: on first connection (no saved offset), fetch the latest update_id
    // so we skip historical messages and only process new ones going forward
    if (!this._offsetLoaded) {
      try {
        const bootstrapRes = await fetch(`${baseUrl}/api/wechat/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', rdxtoken: token },
          body: JSON.stringify({ offset: -1, limit: 1, timeout: 0 }),
        })
        if (bootstrapRes.ok) {
          const rawText = await bootstrapRes.text()
          const safeJson = fixLargeChatIds(rawText)
          const data = JSON.parse(safeJson) as GetUpdatesResponse
          if (data.ok && data.result.length > 0) {
            const maxUpdateId = Math.max(...data.result.map(u => u.update_id))
            this.offset = maxUpdateId + 1
          }
        }
      } catch (err) {
        logger.warn({ err }, 'WeChat OA offset bootstrap failed, starting from 0')
      }
      this.saveOffset()
      this._offsetLoaded = true
      logger.info({ offset: this.offset }, 'WeChat OA bootstrapped offset (skipped historical)')
    }

    this._connected = true
    logger.info('WeChat OA channel connected')

    // Start polling loop (fire and forget, tracked via pollPromise)
    this.pollPromise = this.pollLoop()
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const logger = getLogger()
    const baseUrl = this.getBaseUrl()
    const numericChatId = chatId.replace(/^wxoa:/, '')

    try {
      const token = this.getToken()
      const res = await fetch(`${baseUrl}/api/wechat/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          rdxtoken: token,
        },
        body: JSON.stringify({ chat_id: numericChatId, text }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        logger.error({ chatId, status: res.status, body }, 'Failed to send WeChat OA message')
      } else {
        logger.debug({ chatId, length: text.length }, 'WeChat OA message sent')
      }
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send WeChat OA message')
    }
  }

  isConnected(): boolean {
    return this._connected
  }

  ownsChatId(chatId: string): boolean {
    return chatId.startsWith('wxoa:')
  }

  async disconnect(): Promise<void> {
    const logger = getLogger()
    this._connected = false
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    if (this.pollPromise) {
      await this.pollPromise
      this.pollPromise = null
    }
    logger.info('WeChat OA channel disconnected')
  }

  private getBaseUrl(): string {
    const env = getEnv()
    const url = env.XiaoJuClaw_API_URL
    if (!url) {
      throw new Error('XiaoJuClaw_API_URL is not configured, required for WeChat OA channel')
    }
    return url.replace(/\/+$/, '')
  }

  private async pollLoop(): Promise<void> {
    const logger = getLogger()

    while (this._connected) {
      try {
        this.abortController = new AbortController()
        const baseUrl = this.getBaseUrl()

        const token = this.getToken()
        const res = await fetch(`${baseUrl}/api/wechat/getUpdates`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            rdxtoken: token,
          },
          body: JSON.stringify({ offset: this.offset, limit: 100, timeout: 20 }),
          signal: this.abortController.signal,
        })

        if (!res.ok) {
          const body = await res.text().catch(() => '')
          logger.error({ status: res.status, body }, 'WeChat OA poll error')
          await this.sleep(5000)
          continue
        }

        // Handle large chatId numbers: extract raw text and fix precision loss
        const rawText = await res.text()
        const safeJson = fixLargeChatIds(rawText)
        const data = JSON.parse(safeJson) as GetUpdatesResponse

        if (!data.ok || !Array.isArray(data.result)) {
          logger.error({ data }, 'WeChat OA poll: unexpected response')
          await this.sleep(5000)
          continue
        }

        if (data.result.length > 0) {
          logger.debug({ count: data.result.length }, 'WeChat OA poll received updates')
        }

        for (const update of data.result) {
          this.handleUpdate(update)
          // Track offset for next poll
          if (update.update_id >= this.offset) {
            this.offset = update.update_id + 1
          }
        }

        // Persist offset so restarts don't replay old messages
        if (data.result.length > 0) {
          this.saveOffset()
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          break
        }
        // Bun uses different error type for abort
        if (err instanceof Error && err.name === 'AbortError') {
          break
        }
        logger.error({ err }, 'WeChat OA poll loop error')
        await this.sleep(5000)
      }
    }
  }

  private handleUpdate(update: TelegramUpdate): void {
    if (!update.message) return

    const msg = update.message
    const chatId = `wxoa:${msg.chat.id}`
    const text = msg.text || msg.caption || ''
    if (!text) return

    const message: InboundMessage = {
      id: String(msg.message_id),
      chatId,
      sender: String(msg.from?.id ?? msg.chat.id),
      senderName: msg.from?.first_name || msg.from?.username || 'WeChat User',
      content: text,
      timestamp: new Date(msg.date * 1000).toISOString(),
      isGroup: false,
      channel: 'wechat-oa',
    }

    this.opts.onMessage(message)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this._connected) return resolve()
      const timer = setTimeout(resolve, ms)
      // Allow GC if disconnected
      if (timer && typeof timer === 'object' && 'unref' in timer) {
        (timer as { unref: () => void }).unref()
      }
    })
  }
}

/**
 * Fix large chat.id numbers that exceed Number.MAX_SAFE_INTEGER.
 * ReadmeX's chatId is SHA-256 first 8 bytes -> Java long (max 2^63-1).
 * We convert numeric chat.id values to strings before JSON.parse.
 */
function fixLargeChatIds(json: string): string {
  // Match "id": followed by a large number (more than 15 digits) in chat objects
  return json.replace(/"id"\s*:\s*(\d{16,})/g, '"id":"$1"')
}

// ---- Telegram-compatible response types ----

interface GetUpdatesResponse {
  ok: boolean
  result: TelegramUpdate[]
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramMessage {
  message_id: number
  date: number
  text?: string
  caption?: string
  chat: { id: string | number }
  from?: {
    id: number
    first_name?: string
    username?: string
  }
}
