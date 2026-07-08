import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLogger } from '../logger/index.ts'
import { assertSafeRemoteUrl } from './media-fetch.ts'
import type { ChannelManager } from './manager.ts'

let channelManagerRef: ChannelManager | null = null

export interface NormalizedOutboundMedia {
  /** 'remote' = http(s) URL, 'local' = verified absolute file path */
  kind: 'remote' | 'local'
  /** http(s) URL for remote media, absolute local file path for local media */
  source: string
  /** Best-effort file name inferred from the path or URL ('' when unknown) */
  fileName: string
  /** Lowercase file extension without the leading dot ('' when unknown) */
  extension: string
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Normalize an outbound media reference into either a remote http(s) URL or a
 * verified absolute local file path.
 *
 * Accepted inputs: http(s) URL, file:// URL, absolute local path.
 */
export function normalizeOutboundMedia(mediaUrl: string): NormalizedOutboundMedia {
  const raw = (mediaUrl ?? '').trim()
  if (!raw) {
    throw new Error('媒体地址为空：仅支持 http(s) URL、file:// URL 或绝对本地路径')
  }

  if (/^https?:\/\//i.test(raw)) {
    // 集中式 SSRF 校验：所有渠道出站都经 sendToChat → normalize，一处挡内网/元数据/非 http(s)。
    const parsed = assertSafeRemoteUrl(raw)
    const fileName = decodeUriComponentSafely(basename(parsed.pathname))
    return { kind: 'remote', source: raw, fileName, extension: extensionOf(fileName) }
  }

  let localPath = raw
  if (/^file:\/\//i.test(raw)) {
    try {
      localPath = fileURLToPath(raw)
    } catch {
      throw new Error(`无效的 file:// URL：${raw}`)
    }
  } else if (raw.includes('://')) {
    throw new Error(`不支持的媒体地址协议：${raw}（仅支持 http(s) URL、file:// URL 或绝对本地路径）`)
  } else if (!isAbsolute(raw)) {
    throw new Error(`媒体路径必须是绝对路径：${raw}（仅支持 http(s) URL、file:// URL 或绝对本地路径）`)
  }

  if (!existsSync(localPath)) {
    throw new Error(`媒体文件不存在：${localPath}`)
  }
  if (!statSync(localPath).isFile()) {
    throw new Error(`媒体路径不是一个文件：${localPath}`)
  }

  const fileName = basename(localPath)
  return { kind: 'local', source: localPath, fileName, extension: extensionOf(fileName) }
}

function logInfo(message: string, extra: Record<string, unknown>): void {
  try {
    getLogger().info(extra, message)
  } catch {
    // Logger is not always initialized in isolated unit tests.
  }
}

export function registerChannelOutboundService(channelManager: ChannelManager): void {
  channelManagerRef = channelManager
}

/** Test-only: clear the registered manager so tests do not leak state into each other. */
export function resetChannelOutboundService(): void {
  channelManagerRef = null
}

export async function sendToChat(params: {
  chatId: string
  text?: string
  mediaUrl?: string
}): Promise<{ ok: true; mode: 'text' | 'media' }> {
  const { chatId, text = '', mediaUrl } = params
  const manager = channelManagerRef
  if (!manager) {
    throw new Error('Channel outbound service is not initialized')
  }

  const channel = manager.getChannelForChat(chatId)
  if (!channel) {
    throw new Error(`No connected channel found for chatId: ${chatId}`)
  }

  if (mediaUrl) {
    if (!channel.sendMedia) {
      throw new Error(`Channel "${channel.name}" does not support media sending`)
    }
    const media = normalizeOutboundMedia(mediaUrl)
    await channel.sendMedia(chatId, text, media.source)
    logInfo('Outbound media sent via channel service', {
      chatId,
      channel: channel.name,
      mediaUrl: media.source,
      mediaKind: media.kind,
    })
    return { ok: true, mode: 'media' }
  }

  await channel.sendMessage(chatId, text)
  logInfo('Outbound text sent via channel service', { chatId, channel: channel.name })
  return { ok: true, mode: 'text' }
}
