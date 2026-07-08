import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  registerChannelOutboundService, sendToChat, normalizeOutboundMedia,
} from '../src/channel/outbound-service.ts'
import type { Channel } from '../src/channel/types.ts'

let tempDir: string
let tempFile: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'xjc-outbound-test-'))
  tempFile = join(tempDir, 'report.pdf')
  writeFileSync(tempFile, 'pdf-bytes')
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function createChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'mock-channel',
    connect: async () => {},
    sendMessage: async () => {},
    isConnected: () => true,
    ownsChatId: () => true,
    disconnect: async () => {},
    ...overrides,
  }
}

describe('channel outbound service', () => {
  test('routes text sends to channel.sendMessage', async () => {
    const sendMessage = mock(async () => {})
    registerChannelOutboundService({
      getChannelForChat: () => createChannel({ sendMessage }),
    } as any)

    const result = await sendToChat({ chatId: 'wxp:test:user@im.wechat', text: 'hello' })

    expect(result).toEqual({ ok: true, mode: 'text' })
    expect(sendMessage).toHaveBeenCalledWith('wxp:test:user@im.wechat', 'hello')
  })

  test('routes media sends to channel.sendMedia with the normalized local path', async () => {
    const sendMedia = mock(async () => {})
    registerChannelOutboundService({
      getChannelForChat: () => createChannel({ sendMedia }),
    } as any)

    const result = await sendToChat({
      chatId: 'wxp:test:user@im.wechat',
      text: 'caption',
      mediaUrl: tempFile,
    })

    expect(result).toEqual({ ok: true, mode: 'media' })
    expect(sendMedia).toHaveBeenCalledWith('wxp:test:user@im.wechat', 'caption', tempFile)
  })

  test('converts file:// URLs to a local path before dispatching', async () => {
    const sendMedia = mock(async () => {})
    registerChannelOutboundService({
      getChannelForChat: () => createChannel({ sendMedia }),
    } as any)

    await sendToChat({
      chatId: 'tg:123',
      text: '',
      mediaUrl: pathToFileURL(tempFile).href,
    })

    expect(sendMedia).toHaveBeenCalledWith('tg:123', '', tempFile)
  })

  test('throws when channel does not implement sendMedia', async () => {
    registerChannelOutboundService({
      getChannelForChat: () => createChannel(),
    } as any)

    await expect(
      sendToChat({ chatId: 'tg:123', text: '', mediaUrl: tempFile }),
    ).rejects.toThrow('does not support media sending')
  })

  test('throws for a nonexistent local path', async () => {
    const sendMedia = mock(async () => {})
    registerChannelOutboundService({
      getChannelForChat: () => createChannel({ sendMedia }),
    } as any)

    await expect(
      sendToChat({ chatId: 'tg:123', text: '', mediaUrl: join(tempDir, 'missing.pdf') }),
    ).rejects.toThrow('媒体文件不存在')
    expect(sendMedia).not.toHaveBeenCalled()
  })
})

describe('normalizeOutboundMedia', () => {
  test('passes http(s) URLs through and infers name/extension', () => {
    const media = normalizeOutboundMedia('https://example.com/files/%E6%8A%A5%E5%91%8A.XLSX?sig=abc')
    expect(media).toEqual({
      kind: 'remote',
      source: 'https://example.com/files/%E6%8A%A5%E5%91%8A.XLSX?sig=abc',
      fileName: '报告.XLSX',
      extension: 'xlsx',
    })
  })

  test('converts file:// URLs to a verified local path', () => {
    const media = normalizeOutboundMedia(pathToFileURL(tempFile).href)
    expect(media.kind).toBe('local')
    expect(media.source).toBe(tempFile)
    expect(media.fileName).toBe('report.pdf')
    expect(media.extension).toBe('pdf')
  })

  test('accepts absolute local paths that exist', () => {
    const media = normalizeOutboundMedia(tempFile)
    expect(media.kind).toBe('local')
    expect(media.source).toBe(tempFile)
  })

  test('rejects a nonexistent local path', () => {
    expect(() => normalizeOutboundMedia(join(tempDir, 'nope.png'))).toThrow('媒体文件不存在')
  })

  test('rejects a directory path', () => {
    const dir = join(tempDir, 'subdir')
    mkdirSync(dir, { recursive: true })
    expect(() => normalizeOutboundMedia(dir)).toThrow('不是一个文件')
  })

  test('rejects relative paths', () => {
    expect(() => normalizeOutboundMedia('./relative/file.png')).toThrow('绝对路径')
  })

  test('rejects unsupported protocols', () => {
    expect(() => normalizeOutboundMedia('ftp://example.com/a.zip')).toThrow('不支持的媒体地址协议')
  })

  test('rejects empty values', () => {
    expect(() => normalizeOutboundMedia('   ')).toThrow('媒体地址为空')
  })

  test('rejects remote URLs resolving to internal/metadata addresses (centralized SSRF guard)', () => {
    expect(() => normalizeOutboundMedia('http://169.254.169.254/latest/meta-data/')).toThrow('内网/保留地址')
    expect(() => normalizeOutboundMedia('http://127.0.0.1:8080/x.png')).toThrow('内网/保留地址')
    expect(() => normalizeOutboundMedia('http://10.0.0.5/a.pdf')).toThrow('内网/保留地址')
    expect(() => normalizeOutboundMedia('http://192.168.1.1/a.pdf')).toThrow('内网/保留地址')
    expect(() => normalizeOutboundMedia('http://localhost/a.pdf')).toThrow('localhost')
  })

  test('still accepts public remote URLs', () => {
    const media = normalizeOutboundMedia('https://example.com/a.png')
    expect(media.kind).toBe('remote')
    expect(media.fileName).toBe('a.png')
  })
})

describe('sendToChat SSRF guard', () => {
  test('a media URL pointing at an internal address is rejected and never reaches the channel', async () => {
    const sendMedia = mock(async () => {})
    registerChannelOutboundService({
      getChannelForChat: () => createChannel({ sendMedia }),
    } as any)

    await expect(
      sendToChat({ chatId: 'tg:123', text: '', mediaUrl: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow()
    expect(sendMedia).not.toHaveBeenCalled()
  })
})
