// [XJC] T-A2 语音服务 HTTP 逻辑测试：本地 Bun.serve 假服务端断言请求形状
// （路径/鉴权头/FormData 字段/JSON 体）与错误路径（非 2xx / 网络错 → VOICE_PROVIDER_ERROR）。
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables, getDatabase } from './setup.ts'
import { VoiceService } from '../src/voice/service.ts'
import { VOICE_NOT_CONFIGURED, VOICE_PROVIDER_ERROR, VoiceError } from '../src/voice/types.ts'

interface CapturedRequest {
  method: string
  pathname: string
  authorization: string | null
  contentType: string | null
  formFile?: { name: string; type: string; bytes: number[] }
  formModel?: string
  jsonBody?: Record<string, unknown>
}

let captured: CapturedRequest | null = null
let respond: () => Response = () => Response.json({ text: 'ok' })

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const entry: CapturedRequest = {
      method: req.method,
      pathname: new URL(req.url).pathname,
      authorization: req.headers.get('authorization'),
      contentType: req.headers.get('content-type'),
    }
    if (entry.contentType?.includes('multipart/form-data')) {
      const fd = await req.formData()
      const file = fd.get('file')
      if (file instanceof File) {
        entry.formFile = {
          name: file.name,
          type: file.type,
          bytes: [...new Uint8Array(await file.arrayBuffer())],
        }
      }
      const model = fd.get('model')
      if (typeof model === 'string') entry.formModel = model
    } else if (entry.contentType?.includes('application/json')) {
      entry.jsonBody = await req.json() as Record<string, unknown>
    }
    captured = entry
    return respond()
  },
})

afterAll(() => {
  server.stop(true)
})

/** 一个确定无监听者的端口：起一个临时 server 记下端口再关掉 */
const deadServer = Bun.serve({ port: 0, fetch: () => new Response('') })
const deadPort = deadServer.port
deadServer.stop(true)

function liveBaseUrl(suffix = '/v1'): string {
  return `http://127.0.0.1:${server.port}${suffix}`
}

function writeVoiceSettings(voice: {
  asr?: Partial<{ provider: string; baseUrl: string; apiKey: string; model: string }>
  tts?: Partial<{ provider: string; baseUrl: string; apiKey: string; model: string; voice: string }>
}) {
  getDatabase().run(
    'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
    ['settings', JSON.stringify({ voice })],
  )
}

function configuredAsr(baseUrl: string) {
  writeVoiceSettings({
    asr: { provider: 'openai-compatible', baseUrl, apiKey: 'sk-test-asr', model: 'asr-model-1' },
  })
}

function configuredTts(baseUrl: string, voice = '') {
  writeVoiceSettings({
    tts: { provider: 'openai-compatible', baseUrl, apiKey: 'sk-test-tts', model: 'tts-model-1', voice },
  })
}

async function expectVoiceError(promise: Promise<unknown>, code: string): Promise<VoiceError> {
  let thrown: unknown
  try {
    await promise
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeInstanceOf(VoiceError)
  expect((thrown as VoiceError).code).toBe(code)
  return thrown as VoiceError
}

beforeEach(() => {
  cleanTables('kv_state')
  captured = null
  respond = () => Response.json({ text: 'ok' })
})

const service = new VoiceService()

describe('VoiceService.status', () => {
  test('reflects the configured state of each endpoint', () => {
    expect(service.status()).toEqual({ asrConfigured: false, ttsConfigured: false })
    configuredAsr(liveBaseUrl())
    expect(service.status()).toEqual({ asrConfigured: true, ttsConfigured: false })
  })
})

describe('VoiceService.transcribe', () => {
  test('throws VOICE_NOT_CONFIGURED when ASR is off', async () => {
    await expectVoiceError(service.transcribe(new Uint8Array([1]), 'audio/webm'), VOICE_NOT_CONFIGURED)
    expect(captured).toBeNull()
  })

  test('posts multipart form to /audio/transcriptions with Bearer auth and returns { text }', async () => {
    configuredAsr(liveBaseUrl())
    respond = () => Response.json({ text: '你好世界' })

    const audio = new Uint8Array([10, 20, 30, 40])
    const result = await service.transcribe(audio, 'audio/webm')

    expect(result).toEqual({ text: '你好世界' })
    expect(captured?.method).toBe('POST')
    expect(captured?.pathname).toBe('/v1/audio/transcriptions')
    expect(captured?.authorization).toBe('Bearer sk-test-asr')
    expect(captured?.formModel).toBe('asr-model-1')
    expect(captured?.formFile?.name).toBe('audio.webm')
    // Bun 的 multipart 序列化会按 .webm 扩展名改写分部 Content-Type（audio/webm → video/webm），
    // 这里只断言 webm 家族类型确实随文件名传给了服务端。
    expect(captured?.formFile?.type).toContain('webm')
    expect(captured?.formFile?.bytes).toEqual([10, 20, 30, 40])
  })

  test('strips trailing slashes from baseUrl before joining the path', async () => {
    configuredAsr(liveBaseUrl('/v1/'))
    await service.transcribe(new Uint8Array([1]), 'audio/webm')
    expect(captured?.pathname).toBe('/v1/audio/transcriptions')
  })

  test('throws VOICE_PROVIDER_ERROR with status code and body snippet on non-2xx', async () => {
    configuredAsr(liveBaseUrl())
    respond = () => new Response('{"error":"invalid api key"}', { status: 401 })

    const err = await expectVoiceError(
      service.transcribe(new Uint8Array([1]), 'audio/webm'),
      VOICE_PROVIDER_ERROR,
    )
    expect(err.message).toContain('401')
    expect(err.message).toContain('invalid api key')
  })

  test('throws VOICE_PROVIDER_ERROR when the response has no text field', async () => {
    configuredAsr(liveBaseUrl())
    respond = () => Response.json({ result: 'nope' })
    await expectVoiceError(service.transcribe(new Uint8Array([1]), 'audio/webm'), VOICE_PROVIDER_ERROR)
  })

  test('throws VOICE_PROVIDER_ERROR on network failure (connection refused)', async () => {
    configuredAsr(`http://127.0.0.1:${deadPort}/v1`)
    await expectVoiceError(service.transcribe(new Uint8Array([1]), 'audio/webm'), VOICE_PROVIDER_ERROR)
  })
})

describe('VoiceService.speak', () => {
  test('throws VOICE_NOT_CONFIGURED when TTS is off', async () => {
    await expectVoiceError(service.speak('hello'), VOICE_NOT_CONFIGURED)
    expect(captured).toBeNull()
  })

  test('posts JSON to /audio/speech with Bearer auth and returns audio bytes + mime', async () => {
    configuredTts(liveBaseUrl(), 'voice-alex')
    const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04])
    respond = () => new Response(mp3Bytes, { headers: { 'Content-Type': 'audio/mpeg' } })

    const result = await service.speak('你好，世界')

    expect(captured?.method).toBe('POST')
    expect(captured?.pathname).toBe('/v1/audio/speech')
    expect(captured?.authorization).toBe('Bearer sk-test-tts')
    expect(captured?.jsonBody).toEqual({
      model: 'tts-model-1',
      voice: 'voice-alex',
      input: '你好，世界',
      response_format: 'mp3',
    })
    expect(result.mimeType).toBe('audio/mpeg')
    expect([...result.audio]).toEqual([...mp3Bytes])
  })

  test('omits the voice field when not configured', async () => {
    configuredTts(liveBaseUrl())
    respond = () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'audio/mpeg' } })

    await service.speak('hi')

    expect(captured?.jsonBody).toBeDefined()
    expect('voice' in (captured!.jsonBody as object)).toBe(false)
  })

  test('passes through the provider content-type as mimeType', async () => {
    configuredTts(liveBaseUrl())
    respond = () => new Response(new Uint8Array([9]), { headers: { 'Content-Type': 'audio/wav' } })
    const result = await service.speak('hi')
    expect(result.mimeType).toBe('audio/wav')
  })

  test('throws VOICE_PROVIDER_ERROR with status code on non-2xx', async () => {
    configuredTts(liveBaseUrl())
    respond = () => new Response('quota exceeded', { status: 429 })

    const err = await expectVoiceError(service.speak('hi'), VOICE_PROVIDER_ERROR)
    expect(err.message).toContain('429')
    expect(err.message).toContain('quota exceeded')
  })

  test('throws VOICE_PROVIDER_ERROR on network failure (connection refused)', async () => {
    configuredTts(`http://127.0.0.1:${deadPort}/v1`)
    await expectVoiceError(service.speak('hi'), VOICE_PROVIDER_ERROR)
  })
})
