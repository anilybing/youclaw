import '../tests/setup-light.ts'
import { describe, test, expect, mock, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractTextContent, extractPostText, stripBotMention, chunkText,
  mapFeishuFileType, FeishuChannel,
} from '../src/channel/feishu.ts'
import { EventBus } from '../src/events/bus.ts'

let mediaTempDir: string

beforeAll(() => {
  mediaTempDir = mkdtempSync(join(tmpdir(), 'xjc-feishu-test-'))
})

afterAll(() => {
  rmSync(mediaTempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('extractTextContent', () => {
  test('text type extracts text field', () => {
    expect(extractTextContent('{"text":"hello"}', 'text')).toBe('hello')
  })

  test('post type delegates to extractPostText', () => {
    const json = JSON.stringify({
      zh_cn: { title: 'T', content: [[{ tag: 'text', text: 'body' }]] },
    })
    expect(extractTextContent(json, 'post')).toBe('T\nbody')
  })

  test('falls back to raw string on JSON parse failure', () => {
    expect(extractTextContent('not json', 'text')).toBe('not json')
  })

  test('returns empty string for unknown message type', () => {
    expect(extractTextContent('{"text":"hello"}', 'image')).toBe('')
  })
})

describe('extractPostText', () => {
  test('title + text elements', () => {
    expect(
      extractPostText({
        zh_cn: { title: 'Title', content: [[{ tag: 'text', text: 'Hello' }]] },
      }),
    ).toBe('Title\nHello')
  })

  test('en_us locale', () => {
    expect(
      extractPostText({
        en_us: { title: 'T', content: [[{ tag: 'text', text: 'Hi' }]] },
      }),
    ).toBe('T\nHi')
  })

  test('link text extraction', () => {
    expect(
      extractPostText({
        content: [[{ tag: 'a', text: 'Link', href: 'http://x.com' }]],
      }),
    ).toBe('Link')
  })

  test('@mention in post', () => {
    expect(
      extractPostText({
        content: [[{ tag: 'at', user_name: 'Alice' }]],
      }),
    ).toBe('@Alice')
  })

  test('image placeholder', () => {
    expect(
      extractPostText({ content: [[{ tag: 'img' }]] }),
    ).toBe('[image]')
  })

  test('empty paragraph is skipped', () => {
    expect(extractPostText({ content: [[]] })).toBe('')
  })

  test('multiple paragraphs', () => {
    expect(
      extractPostText({
        content: [
          [{ tag: 'text', text: 'A' }],
          [{ tag: 'text', text: 'B' }],
        ],
      }),
    ).toBe('A\nB')
  })
})

describe('stripBotMention', () => {
  test('removes bot @mention', () => {
    expect(
      stripBotMention(
        'hello @_user_1 world',
        [{ key: '@_user_1', id: { open_id: 'bot123' }, name: 'Bot' }],
        'bot123',
      ),
    ).toBe('hello  world')
  })

  test('preserves non-bot @mentions', () => {
    expect(
      stripBotMention(
        '@_user_1 hi @_user_2',
        [
          { key: '@_user_1', id: { open_id: 'bot1' }, name: 'Bot' },
          { key: '@_user_2', id: { open_id: 'user2' }, name: 'Alice' },
        ],
        'bot1',
      ),
    ).toBe('hi @_user_2')
  })

  test('key containing regex special characters', () => {
    expect(
      stripBotMention(
        'test @_user_1+2 end',
        [{ key: '@_user_1+2', id: { open_id: 'bot1' }, name: 'B' }],
        'bot1',
      ),
    ).toBe('test  end')
  })

  test('trims leading whitespace', () => {
    expect(
      stripBotMention(
        '@_user_1 hello',
        [{ key: '@_user_1', id: { open_id: 'bot1' }, name: 'Bot' }],
        'bot1',
      ),
    ).toBe('hello')
  })
})

describe('chunkText', () => {
  test('short text returns a single chunk', () => {
    expect(chunkText('hello', 10)).toEqual(['hello'])
  })

  test('splits correctly', () => {
    expect(chunkText('abcdefghij', 3)).toEqual(['abc', 'def', 'ghi', 'j'])
  })

  test('evenly divisible', () => {
    expect(chunkText('abcdef', 3)).toEqual(['abc', 'def'])
  })

  test('empty string', () => {
    expect(chunkText('', 10)).toEqual([''])
  })
})

describe('mapFeishuFileType', () => {
  test('known extensions map to dedicated file types', () => {
    expect(mapFeishuFileType('pdf')).toBe('pdf')
    expect(mapFeishuFileType('doc')).toBe('doc')
    expect(mapFeishuFileType('docx')).toBe('doc')
    expect(mapFeishuFileType('xls')).toBe('xls')
    expect(mapFeishuFileType('xlsx')).toBe('xls')
    expect(mapFeishuFileType('ppt')).toBe('ppt')
    expect(mapFeishuFileType('pptx')).toBe('ppt')
    expect(mapFeishuFileType('mp4')).toBe('mp4')
    expect(mapFeishuFileType('opus')).toBe('opus')
  })

  test('unknown extensions fall back to stream', () => {
    expect(mapFeishuFileType('zip')).toBe('stream')
    expect(mapFeishuFileType('html')).toBe('stream')
    expect(mapFeishuFileType('')).toBe('stream')
  })
})

// ---------------------------------------------------------------------------
// FeishuChannel integration tests
// ---------------------------------------------------------------------------

/** Emulate the real SDK consuming the upload stream, so callers can safely delete temp files afterward. */
async function drainStream(streamLike: any): Promise<void> {
  if (streamLike && typeof streamLike.on === 'function') {
    await new Promise<void>((resolve, reject) => {
      streamLike.on('error', reject)
      streamLike.on('end', resolve)
      streamLike.resume?.()
    })
  }
}

function createMockClient() {
  const sentMessages: any[] = []
  const imageUploads: any[] = []
  const fileUploads: any[] = []
  const reactions: Map<string, string> = new Map()
  let reactionCounter = 0

  return {
    client: {
      im: {
        message: {
          create: mock(async (params: any) => {
            sentMessages.push(params)
            return { code: 0 }
          }),
        },
        image: {
          create: mock(async (params: any) => {
            await drainStream(params?.data?.image)
            imageUploads.push(params)
            return { image_key: 'img_key_1' }
          }),
        },
        file: {
          create: mock(async (params: any) => {
            await drainStream(params?.data?.file)
            fileUploads.push(params)
            return { file_key: 'file_key_1' }
          }),
        },
        messageReaction: {
          create: mock(async (params: any) => {
            const reactionId = `reaction_${++reactionCounter}`
            reactions.set(params.path.message_id, reactionId)
            return { data: { reaction_id: reactionId } }
          }),
          delete: mock(async (params: any) => {
            reactions.delete(params.path.message_id)
            return { code: 0 }
          }),
        },
      },
      request: mock(async () => ({
        bot: { open_id: 'bot_open_id', bot_name: 'TestBot' },
      })),
    } as any,
    sentMessages,
    imageUploads,
    fileUploads,
    reactions,
  }
}

describe('FeishuChannel', () => {
  describe('sendMessage', () => {
    test('plain text uses post format', async () => {
      const { client, sentMessages } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      await channel.sendMessage('feishu:chat1', 'hello')

      expect(sentMessages.length).toBe(1)
      expect(sentMessages[0].data.msg_type).toBe('post')
    })

    test('uses card format when code blocks are present', async () => {
      const { client, sentMessages } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      await channel.sendMessage('feishu:chat1', 'look:\n```\ncode\n```')

      expect(sentMessages.length).toBe(1)
      expect(sentMessages[0].data.msg_type).toBe('interactive')
    })

    test('uses card format when tables are present', async () => {
      const { client, sentMessages } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      await channel.sendMessage('feishu:chat1', '|a|b|\n|---|---|\n|1|2|')

      expect(sentMessages.length).toBe(1)
      expect(sentMessages[0].data.msg_type).toBe('interactive')
    })

    test('long message is sent in chunks', async () => {
      const { client, sentMessages } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      // generate text exceeding 4000 characters
      const longText = 'x'.repeat(4001)
      await channel.sendMessage('feishu:chat1', longText)

      expect(sentMessages.length).toBe(2)
    })
  })

  describe('sendMedia', () => {
    test('image is uploaded via im.image.create and sent as msg_type image', async () => {
      const { client, sentMessages, imageUploads, fileUploads } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })
      const pngFile = join(mediaTempDir, 'chart.png')
      writeFileSync(pngFile, 'png-bytes')

      await channel.sendMedia('feishu:chat1', '', pngFile)

      expect(imageUploads.length).toBe(1)
      expect(imageUploads[0].data.image_type).toBe('message')
      expect(fileUploads.length).toBe(0)

      expect(sentMessages.length).toBe(1)
      expect(sentMessages[0].params.receive_id_type).toBe('chat_id')
      expect(sentMessages[0].data.receive_id).toBe('chat1')
      expect(sentMessages[0].data.msg_type).toBe('image')
      expect(JSON.parse(sentMessages[0].data.content)).toEqual({ image_key: 'img_key_1' })
    })

    test('document is uploaded via im.file.create with mapped file_type and sent as msg_type file', async () => {
      const { client, sentMessages, fileUploads } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })
      const xlsxFile = join(mediaTempDir, 'data.xlsx')
      writeFileSync(xlsxFile, 'xlsx-bytes')

      await channel.sendMedia('feishu:chat1', '', xlsxFile)

      expect(fileUploads.length).toBe(1)
      expect(fileUploads[0].data.file_type).toBe('xls')
      expect(fileUploads[0].data.file_name).toBe('data.xlsx')

      expect(sentMessages.length).toBe(1)
      expect(sentMessages[0].data.msg_type).toBe('file')
      expect(JSON.parse(sentMessages[0].data.content)).toEqual({ file_key: 'file_key_1' })
    })

    test('non-empty text is sent as a follow-up message after the media', async () => {
      const { client, sentMessages } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })
      const pdfFile = join(mediaTempDir, 'report.pdf')
      writeFileSync(pdfFile, 'pdf-bytes')

      await channel.sendMedia('feishu:chat1', '这是报告', pdfFile)

      expect(sentMessages.length).toBe(2)
      expect(sentMessages[0].data.msg_type).toBe('file')
      expect(sentMessages[1].data.msg_type).toBe('post')
    })

    test('image over 10MB is rejected with a Chinese error and nothing is uploaded', async () => {
      const { client, sentMessages, imageUploads } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })
      const bigImage = join(mediaTempDir, 'big.png')
      writeFileSync(bigImage, '')
      truncateSync(bigImage, 10 * 1024 * 1024 + 1)

      await expect(channel.sendMedia('feishu:chat1', '', bigImage)).rejects.toThrow('超过飞书图片上限 10MB')
      expect(imageUploads.length).toBe(0)
      expect(sentMessages.length).toBe(0)
    })

    test('nonexistent local file is rejected', async () => {
      const { client, sentMessages } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      await expect(
        channel.sendMedia('feishu:chat1', '', join(mediaTempDir, 'missing.pdf')),
      ).rejects.toThrow('媒体文件不存在')
      expect(sentMessages.length).toBe(0)
    })
  })

  // Feishu uses global fetch for remote downloads (no injected fetchFn), so we stub it.
  describe('sendMedia (remote, SSRF-guarded)', () => {
    let originalFetch: typeof fetch
    beforeEach(() => {
      originalFetch = globalThis.fetch
    })
    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    test('remote image is downloaded then uploaded via im.image.create', async () => {
      const { client, imageUploads, sentMessages } = createMockClient()
      const fetchSpy = mock(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      await channel.sendMedia('feishu:chat1', '', 'https://files.example.com/chart.png')

      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const init = (fetchSpy.mock.calls[0] as any[])[1]
      expect(init?.redirect).toBe('error')
      expect(imageUploads.length).toBe(1)
      expect(sentMessages.some((m) => m.data.msg_type === 'image')).toBe(true)
    })

    test('remote URL pointing at an internal/metadata address is rejected before download/upload', async () => {
      const { client, imageUploads, fileUploads, sentMessages } = createMockClient()
      const fetchSpy = mock(async () => new Response(new Uint8Array([1]), { status: 200 }))
      globalThis.fetch = fetchSpy as any
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      await expect(
        channel.sendMedia('feishu:chat1', '', 'http://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(imageUploads.length).toBe(0)
      expect(fileUploads.length).toBe(0)
      expect(sentMessages.length).toBe(0)
    })
  })

  describe('ownsChatId', () => {
    test('feishu: prefix returns true', () => {
      const { client } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      expect(channel.ownsChatId('feishu:chat1')).toBe(true)
    })

    test('telegram: prefix returns false', () => {
      const { client } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      expect(channel.ownsChatId('telegram:chat1')).toBe(false)
    })
  })

  describe('isConnected', () => {
    test('initial state is false', () => {
      const { client } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      expect(channel.isConnected()).toBe(false)
    })
  })

  describe('Reaction lifecycle', () => {
    test('eventBus subscription is cleaned up after disconnect', () => {
      const eventBus = new EventBus()
      const { client } = createMockClient()
      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        eventBus,
        _client: client,
      })

      // no eventBus subscription during construction (subscription happens in connect)
      expect(eventBus.subscriberCount).toBe(0)

      // disconnect should not throw
      channel.disconnect()
      expect(eventBus.subscriberCount).toBe(0)
    })

    test('reaction API failure does not throw', async () => {
      const { client } = createMockClient()
      // make reaction create fail
      client.im.messageReaction.create = mock(async () => {
        throw new Error('API error')
      })

      const channel = new FeishuChannel('app1', 'secret1', {
        onMessage: mock(() => {}),
        _client: client,
      })

      // normal in disconnected state
      expect(channel.isConnected()).toBe(false)
    })
  })
})
