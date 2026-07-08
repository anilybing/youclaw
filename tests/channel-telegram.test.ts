import '../tests/setup-light.ts'
import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputFile } from 'grammy'
import { TelegramChannel, pickTelegramMediaKind } from '../src/channel/telegram.ts'

let tempDir: string
let pngFile: string
let pdfFile: string
let mp4File: string

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'xjc-telegram-test-'))
  pngFile = join(tempDir, 'chart.png')
  pdfFile = join(tempDir, 'report.pdf')
  mp4File = join(tempDir, 'demo.mp4')
  writeFileSync(pngFile, 'png-bytes')
  writeFileSync(pdfFile, 'pdf-bytes')
  writeFileSync(mp4File, 'mp4-bytes')
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('pickTelegramMediaKind', () => {
  test('image extensions map to photo', () => {
    for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp']) {
      expect(pickTelegramMediaKind(ext)).toBe('photo')
    }
  })

  test('mp4 maps to video', () => {
    expect(pickTelegramMediaKind('mp4')).toBe('video')
  })

  test('everything else maps to document', () => {
    expect(pickTelegramMediaKind('pdf')).toBe('document')
    expect(pickTelegramMediaKind('xlsx')).toBe('document')
    expect(pickTelegramMediaKind('')).toBe('document')
  })
})

// ---------------------------------------------------------------------------
// sendMedia integration tests (mock bot.api)
// ---------------------------------------------------------------------------

function createChannelWithMockApi() {
  const api = {
    sendPhoto: mock(async () => ({})),
    sendVideo: mock(async () => ({})),
    sendDocument: mock(async () => ({})),
    sendMessage: mock(async () => ({})),
  }
  const channel = new TelegramChannel('test-token', { onMessage: mock(() => {}) })
  ;(channel as any).bot = { api }
  return { channel, api }
}

describe('TelegramChannel.sendMedia', () => {
  test('png goes through sendPhoto with caption', async () => {
    const { channel, api } = createChannelWithMockApi()

    await channel.sendMedia('tg:12345', '这是图表', pngFile)

    expect(api.sendPhoto).toHaveBeenCalledTimes(1)
    const [chatId, input, opts] = (api.sendPhoto.mock.calls[0] ?? []) as any[]
    expect(chatId).toBe('12345')
    expect(input).toBeInstanceOf(InputFile)
    expect(opts.caption).toBe('这是图表')
    expect(api.sendDocument).not.toHaveBeenCalled()
    expect(api.sendVideo).not.toHaveBeenCalled()
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  test('pdf goes through sendDocument', async () => {
    const { channel, api } = createChannelWithMockApi()

    await channel.sendMedia('tg:12345', '', pdfFile)

    expect(api.sendDocument).toHaveBeenCalledTimes(1)
    const [chatId, input] = (api.sendDocument.mock.calls[0] ?? []) as any[]
    expect(chatId).toBe('12345')
    expect(input).toBeInstanceOf(InputFile)
    expect(api.sendPhoto).not.toHaveBeenCalled()
  })

  test('mp4 goes through sendVideo', async () => {
    const { channel, api } = createChannelWithMockApi()

    await channel.sendMedia('tg:12345', '', mp4File)

    expect(api.sendVideo).toHaveBeenCalledTimes(1)
    expect(api.sendPhoto).not.toHaveBeenCalled()
    expect(api.sendDocument).not.toHaveBeenCalled()
  })

  test('caption longer than 1024 chars is sent as a separate message', async () => {
    const { channel, api } = createChannelWithMockApi()
    const longText = 'x'.repeat(1025)

    await channel.sendMedia('tg:12345', longText, pngFile)

    expect(api.sendPhoto).toHaveBeenCalledTimes(1)
    const [, , opts] = (api.sendPhoto.mock.calls[0] ?? []) as any[]
    expect(opts.caption).toBeUndefined()
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    const [msgChatId, msgText] = (api.sendMessage.mock.calls[0] ?? []) as any[]
    expect(msgChatId).toBe('12345')
    expect(msgText).toBe(longText)
  })

  test('http URL is wrapped into an InputFile without touching the filesystem', async () => {
    const { channel, api } = createChannelWithMockApi()

    await channel.sendMedia('tg:12345', '', 'https://example.com/files/pic.png')

    expect(api.sendPhoto).toHaveBeenCalledTimes(1)
    const [, input] = (api.sendPhoto.mock.calls[0] ?? []) as any[]
    expect(input).toBeInstanceOf(InputFile)
  })

  test('remote URL pointing at an internal/metadata address is rejected (SSRF precheck)', async () => {
    const { channel, api } = createChannelWithMockApi()

    await expect(
      channel.sendMedia('tg:12345', '', 'http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow()
    expect(api.sendPhoto).not.toHaveBeenCalled()
    expect(api.sendDocument).not.toHaveBeenCalled()
    expect(api.sendVideo).not.toHaveBeenCalled()
  })

  test('remote URL with a non-http(s) protocol is rejected', async () => {
    const { channel, api } = createChannelWithMockApi()

    // file:// reaches sendMedia only if mis-routed; the SSRF precheck runs on http(s),
    // but a raw internal http host must still be blocked before hitting Telegram.
    await expect(
      channel.sendMedia('tg:12345', '', 'http://127.0.0.1:9000/secret.png'),
    ).rejects.toThrow()
    expect(api.sendPhoto).not.toHaveBeenCalled()
  })

  test('file larger than 50MB is rejected with a Chinese error', async () => {
    const { channel, api } = createChannelWithMockApi()
    const bigFile = join(tempDir, 'big.zip')
    writeFileSync(bigFile, '')
    truncateSync(bigFile, 50 * 1024 * 1024 + 1)

    await expect(channel.sendMedia('tg:12345', '', bigFile)).rejects.toThrow('超过 Telegram 单文件上限 50MB')
    expect(api.sendDocument).not.toHaveBeenCalled()
  })

  test('nonexistent local file is rejected', async () => {
    const { channel, api } = createChannelWithMockApi()

    await expect(channel.sendMedia('tg:12345', '', join(tempDir, 'missing.png'))).rejects.toThrow('媒体文件不存在')
    expect(api.sendPhoto).not.toHaveBeenCalled()
  })
})
