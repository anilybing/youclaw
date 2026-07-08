import '../tests/setup-light.ts'
import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateSignature, decryptMessage, encryptMessage,
  extractTextFromXml, chunkText, mapWeComMediaType, WeComChannel,
} from '../src/channel/wecom.ts'

let mediaTempDir: string

beforeAll(() => {
  mediaTempDir = mkdtempSync(join(tmpdir(), 'xjc-wecom-test-'))
})

afterAll(() => {
  rmSync(mediaTempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('generateSignature', () => {
  test('generates correct SHA1 signature', () => {
    const sig = generateSignature('token123', '1234567890', 'nonce1', 'encrypt_data')
    expect(sig).toMatch(/^[0-9a-f]{40}$/)
  })

  test('different sort order produces the same signature', () => {
    const sig1 = generateSignature('a', 'b', 'c', 'd')
    const sig2 = generateSignature('a', 'b', 'c', 'd')
    expect(sig1).toBe(sig2)
  })

  test('different inputs produce different signatures', () => {
    const sig1 = generateSignature('token1', '123', 'nonce', 'enc')
    const sig2 = generateSignature('token2', '123', 'nonce', 'enc')
    expect(sig1).not.toBe(sig2)
  })
})

describe('decryptMessage / encryptMessage', () => {
  // 43-character encodingAESKey (base64 without trailing '=', 43 chars)
  const encodingAESKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  const corpId = 'wx1234567890'

  test('encrypt-decrypt round trip', () => {
    const original = 'Hello, WeCom!'
    const encrypted = encryptMessage(encodingAESKey, corpId, original)
    const { message, corpId: decryptedCorpId } = decryptMessage(encodingAESKey, encrypted)
    expect(message).toBe(original)
    expect(decryptedCorpId).toBe(corpId)
  })

  test('empty message encrypt-decrypt', () => {
    const original = ''
    const encrypted = encryptMessage(encodingAESKey, corpId, original)
    const { message } = decryptMessage(encodingAESKey, encrypted)
    expect(message).toBe(original)
  })

  test('long message encrypt-decrypt', () => {
    const original = 'test'.repeat(500)
    const encrypted = encryptMessage(encodingAESKey, corpId, original)
    const { message } = decryptMessage(encodingAESKey, encrypted)
    expect(message).toBe(original)
  })
})

describe('extractTextFromXml', () => {
  test('extracts text message', () => {
    const xml = `<xml>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[hello world]]></Content>
      <FromUserName><![CDATA[user123]]></FromUserName>
      <AgentID>1000001</AgentID>
      <MsgId>12345</MsgId>
    </xml>`
    const result = extractTextFromXml(xml)
    expect(result.msgType).toBe('text')
    expect(result.content).toBe('hello world')
    expect(result.fromUserName).toBe('user123')
    expect(result.agentId).toBe('1000001')
    expect(result.msgId).toBe('12345')
  })

  test('image message', () => {
    const xml = `<xml><MsgType><![CDATA[image]]></MsgType><Content></Content></xml>`
    const result = extractTextFromXml(xml)
    expect(result.msgType).toBe('image')
    expect(result.content).toBe('')
  })

  test('empty content', () => {
    const xml = '<xml></xml>'
    const result = extractTextFromXml(xml)
    expect(result.msgType).toBe('')
    expect(result.content).toBe('')
  })

  test('extracts Encrypt field', () => {
    const xml = '<xml><Encrypt><![CDATA[encrypted_data]]></Encrypt></xml>'
    const result = extractTextFromXml(xml)
    expect(result.encrypt).toBe('encrypted_data')
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

describe('mapWeComMediaType', () => {
  test('jpg/jpeg/png map to image', () => {
    expect(mapWeComMediaType('jpg')).toBe('image')
    expect(mapWeComMediaType('jpeg')).toBe('image')
    expect(mapWeComMediaType('png')).toBe('image')
  })

  test('mp4 maps to video', () => {
    expect(mapWeComMediaType('mp4')).toBe('video')
  })

  test('everything else maps to file (incl. gif, which WeCom image upload rejects)', () => {
    expect(mapWeComMediaType('gif')).toBe('file')
    expect(mapWeComMediaType('pdf')).toBe('file')
    expect(mapWeComMediaType('')).toBe('file')
  })
})

// ---------------------------------------------------------------------------
// WeComChannel integration tests (mock fetch)
// ---------------------------------------------------------------------------

function createMockFetch() {
  const calls: { url: string; init?: RequestInit }[] = []

  const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString()
    calls.push({ url: urlStr, init })

    // token request
    if (urlStr.includes('gettoken')) {
      return new Response(JSON.stringify({ access_token: 'test_token', expires_in: 7200, errcode: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // send message
    if (urlStr.includes('message/send')) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // temporary material upload
    if (urlStr.includes('media/upload')) {
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', media_id: 'MEDIA_ID_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // remote media download (SSRF-guarded outbound media)
    if (urlStr.includes('files.example.com')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }

    return new Response('Not Found', { status: 404 })
  }) as any

  return { fetch: mockFetch, calls }
}

describe('WeComChannel', () => {
  const encodingAESKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

  describe('sendMessage', () => {
    test('correct API URL and access_token parameter', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      // manually set token
      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      await channel.sendMessage('wecom:user123', 'hello')

      const msgCall = calls.find(c => c.url.includes('message/send'))
      expect(msgCall).toBeDefined()
      expect(msgCall!.url).toContain('access_token=test_token')
      expect(msgCall!.init?.method).toBe('POST')

      const body = JSON.parse(msgCall!.init?.body as string)
      expect(body.touser).toBe('user123')
      expect(body.msgtype).toBe('text')
      expect(body.text.content).toBe('hello')
    })

    test('2048 character chunking', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      const longText = 'x'.repeat(2049)
      await channel.sendMessage('wecom:user1', longText)

      const msgCalls = calls.filter(c => c.url.includes('message/send'))
      expect(msgCalls.length).toBe(2)
    })

    test('auto-refreshes expired token', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      // set expired token
      ;(channel as any).accessToken = { access_token: 'old_token', expires_in: 7200, fetchedAt: Date.now() - 8000000 }

      await channel.sendMessage('wecom:user1', 'hello')

      const tokenCall = calls.find(c => c.url.includes('gettoken'))
      expect(tokenCall).toBeDefined()
    })
  })

  describe('sendMedia', () => {
    test('image is uploaded with type=image and sent as msgtype image', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })
      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      const pngFile = join(mediaTempDir, 'chart.png')
      writeFileSync(pngFile, 'png-bytes')

      await channel.sendMedia('wecom:user123', '', pngFile)

      const uploadCall = calls.find(c => c.url.includes('media/upload'))
      expect(uploadCall).toBeDefined()
      expect(uploadCall!.url).toContain('type=image')
      expect(uploadCall!.url).toContain('access_token=test_token')

      const sendCall = calls.find(c => c.url.includes('message/send'))
      expect(sendCall).toBeDefined()
      const body = JSON.parse(sendCall!.init?.body as string)
      expect(body.touser).toBe('user123')
      expect(body.msgtype).toBe('image')
      expect(body.image.media_id).toBe('MEDIA_ID_1')
    })

    test('document is uploaded with type=file and follow-up text goes out separately', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })
      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      const xlsxFile = join(mediaTempDir, 'data.xlsx')
      writeFileSync(xlsxFile, 'xlsx-bytes')

      await channel.sendMedia('wecom:user123', '这是数据表', xlsxFile)

      const uploadCall = calls.find(c => c.url.includes('media/upload'))
      expect(uploadCall!.url).toContain('type=file')

      const sendCalls = calls.filter(c => c.url.includes('message/send'))
      expect(sendCalls.length).toBe(2)
      const mediaBody = JSON.parse(sendCalls[0]!.init?.body as string)
      expect(mediaBody.msgtype).toBe('file')
      expect(mediaBody.file.media_id).toBe('MEDIA_ID_1')
      const textBody = JSON.parse(sendCalls[1]!.init?.body as string)
      expect(textBody.msgtype).toBe('text')
      expect(textBody.text.content).toBe('这是数据表')
    })

    test('nonexistent local file is rejected without any API call', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })
      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      await expect(
        channel.sendMedia('wecom:user123', '', join(mediaTempDir, 'missing.pdf')),
      ).rejects.toThrow('媒体文件不存在')
      const uploadCalls = calls.filter(c => c.url.includes('media/upload'))
      expect(uploadCalls.length).toBe(0)
    })

    test('remote image is downloaded via the injected fetch (redirect:error) then uploaded', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })
      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      await channel.sendMedia('wecom:user123', '', 'https://files.example.com/pic.png')

      const dl = calls.find(c => c.url.includes('files.example.com'))
      expect(dl).toBeDefined()
      expect((dl!.init as any)?.redirect).toBe('error')

      const uploadCall = calls.find(c => c.url.includes('media/upload'))
      expect(uploadCall!.url).toContain('type=image')
      const sendCall = calls.find(c => c.url.includes('message/send'))
      const body = JSON.parse(sendCall!.init?.body as string)
      expect(body.msgtype).toBe('image')
      expect(body.image.media_id).toBe('MEDIA_ID_1')
    })

    test('remote media targeting an internal/metadata address is rejected before any download/upload', async () => {
      const { fetch: mockFetch, calls } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'token', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })
      ;(channel as any).accessToken = { access_token: 'test_token', expires_in: 7200, fetchedAt: Date.now() }

      await expect(
        channel.sendMedia('wecom:user1', '', 'http://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow()
      expect(calls.some(c => c.url.includes('169.254'))).toBe(false)
      expect(calls.some(c => c.url.includes('media/upload'))).toBe(false)
    })
  })

  describe('handleWebhookVerification', () => {
    test('valid signature returns decrypted echostr', async () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'testtoken', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      // generate echostr using encryptMessage
      const { encryptMessage: enc } = await import('../src/channel/wecom.ts')
      const echostr = enc(encodingAESKey, 'corp1', 'echo_test_123')

      const timestamp = '1234567890'
      const nonce = 'nonce1'
      const sig = generateSignature('testtoken', timestamp, nonce, echostr)

      const result = channel.handleWebhookVerification({
        msg_signature: sig,
        timestamp,
        nonce,
        echostr,
      })

      expect(result.success).toBe(true)
      expect(result.echostr).toBe('echo_test_123')
    })

    test('invalid signature is rejected', () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'testtoken', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      const result = channel.handleWebhookVerification({
        msg_signature: 'invalid_sig',
        timestamp: '123',
        nonce: 'n',
        echostr: 'enc',
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Signature')
    })
  })

  describe('handleWebhookMessage', () => {
    test('decrypts and routes text message to onMessage', () => {
      const { fetch: mockFetch } = createMockFetch()
      const messages: any[] = []
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'testtoken', encodingAESKey, {
        onMessage: (msg) => messages.push(msg),
        _fetchFn: mockFetch,
      })

      // construct encrypted message XML
      const innerXml = `<xml>
        <MsgType><![CDATA[text]]></MsgType>
        <Content><![CDATA[test message]]></Content>
        <FromUserName><![CDATA[user456]]></FromUserName>
        <AgentID>1000001</AgentID>
        <MsgId>msg001</MsgId>
      </xml>`

      const encrypted = encryptMessage(encodingAESKey, 'corp1', innerXml)
      const timestamp = '1234567890'
      const nonce = 'nonce1'
      const sig = generateSignature('testtoken', timestamp, nonce, encrypted)

      const outerXml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`

      const result = channel.handleWebhookMessage(
        { msg_signature: sig, timestamp, nonce },
        outerXml,
      )

      expect(result.success).toBe(true)
      expect(messages.length).toBe(1)
      expect(messages[0].chatId).toBe('wecom:user456')
      expect(messages[0].content).toBe('test message')
      expect(messages[0].channel).toBe('wecom')
    })

    test('ignores non-text messages', () => {
      const { fetch: mockFetch } = createMockFetch()
      const messages: any[] = []
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'testtoken', encodingAESKey, {
        onMessage: (msg) => messages.push(msg),
        _fetchFn: mockFetch,
      })

      const innerXml = `<xml><MsgType><![CDATA[image]]></MsgType><Content></Content><FromUserName><![CDATA[user1]]></FromUserName></xml>`
      const encrypted = encryptMessage(encodingAESKey, 'corp1', innerXml)
      const timestamp = '123'
      const nonce = 'n1'
      const sig = generateSignature('testtoken', timestamp, nonce, encrypted)

      const outerXml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`

      const result = channel.handleWebhookMessage(
        { msg_signature: sig, timestamp, nonce },
        outerXml,
      )

      expect(result.success).toBe(true)
      expect(messages.length).toBe(0)
    })

    test('rejects on signature verification failure', () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('corp1', 'secret1', '1000001', 'testtoken', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      const encrypted = encryptMessage(encodingAESKey, 'corp1', '<xml><MsgType><![CDATA[text]]></MsgType></xml>')
      const outerXml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`

      const result = channel.handleWebhookMessage(
        { msg_signature: 'wrong_sig', timestamp: '123', nonce: 'n' },
        outerXml,
      )

      expect(result.success).toBe(false)
      expect(result.error).toContain('Signature')
    })
  })

  describe('ownsChatId', () => {
    test('wecom: prefix returns true', () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('c', 's', 'a', 't', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      expect(channel.ownsChatId('wecom:user1')).toBe(true)
    })

    test('non-wecom: prefix returns false', () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('c', 's', 'a', 't', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      expect(channel.ownsChatId('tg:123')).toBe(false)
      expect(channel.ownsChatId('feishu:chat1')).toBe(false)
      expect(channel.ownsChatId('dingtalk:user:1')).toBe(false)
    })
  })

  describe('isConnected', () => {
    test('initial state is false', () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('c', 's', 'a', 't', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      expect(channel.isConnected()).toBe(false)
    })
  })

  describe('disconnect', () => {
    test('clears timer and sets connected to false', async () => {
      const { fetch: mockFetch } = createMockFetch()
      const channel = new WeComChannel('c', 's', 'a', 't', encodingAESKey, {
        onMessage: mock(() => {}),
        _fetchFn: mockFetch,
      })

      // manually set some state
      ;(channel as any)._connected = true
      ;(channel as any).tokenRefreshTimer = setTimeout(() => {}, 100000)

      await channel.disconnect()

      expect(channel.isConnected()).toBe(false)
      expect((channel as any).tokenRefreshTimer).toBeNull()
    })
  })
})
