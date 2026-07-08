// [XJC] 语音服务（通用能力对齐 · T-A2）
// openai-compatible provider 的真实 HTTP 调用：
//   - transcribe: POST {baseUrl}/audio/transcriptions（multipart: file+model，Bearer apiKey，30s 超时）
//   - speak:      POST {baseUrl}/audio/speech（json: model/voice/input/response_format:'mp3'）
// 红线：不得在代码里硬编码任何厂商域名（示例域名只允许出现在前端 placeholder 文案里）。

import { getStoredSettings } from '../settings/manager.ts'
import type { VoiceAsrConfig, VoiceTtsConfig } from '../settings/schema.ts'
import {
  VoiceError,
  VOICE_NOT_CONFIGURED,
  VOICE_PROVIDER_ERROR,
  type SpeakResult,
  type TranscribeResult,
  type VoiceStatus,
} from './types.ts'

const REQUEST_TIMEOUT_MS = 30_000
/** 供应商错误响应体截断长度：足够定位问题，避免整页 HTML 刷进 toast/日志 */
const ERROR_BODY_SNIPPET_MAX = 200

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function providerErrorFromResponse(action: string, res: Response): Promise<VoiceError> {
  let snippet = ''
  try {
    snippet = (await res.text()).slice(0, ERROR_BODY_SNIPPET_MAX).trim()
  } catch {
    // 响应体不可读时只报状态码
  }
  return new VoiceError(
    VOICE_PROVIDER_ERROR,
    `${action}失败（HTTP ${res.status}）${snippet ? `：${snippet}` : ''}`,
  )
}

function providerErrorFromNetwork(action: string, err: unknown): VoiceError {
  const detail = err instanceof Error ? err.message : String(err)
  return new VoiceError(VOICE_PROVIDER_ERROR, `${action}请求失败：${detail}`)
}

function asrConfig(): VoiceAsrConfig {
  return getStoredSettings().voice.asr
}

function ttsConfig(): VoiceTtsConfig {
  return getStoredSettings().voice.tts
}

function isAsrConfigured(cfg: VoiceAsrConfig): boolean {
  return cfg.provider === 'openai-compatible' && !!cfg.baseUrl && !!cfg.apiKey && !!cfg.model
}

function isTtsConfigured(cfg: VoiceTtsConfig): boolean {
  return cfg.provider === 'openai-compatible' && !!cfg.baseUrl && !!cfg.apiKey && !!cfg.model
}

export class VoiceService {
  status(): VoiceStatus {
    return {
      asrConfigured: isAsrConfigured(asrConfig()),
      ttsConfigured: isTtsConfigured(ttsConfig()),
    }
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<TranscribeResult> {
    const cfg = asrConfig()
    if (!isAsrConfigured(cfg)) {
      throw new VoiceError(VOICE_NOT_CONFIGURED, '语音识别未配置，请到 设置 → 语音 填写服务信息')
    }

    const form = new FormData()
    form.append('file', new File([audio], 'audio.webm', { type: mimeType }))
    form.append('model', cfg.model)

    let res: Response
    try {
      res = await fetch(endpointUrl(cfg.baseUrl, '/audio/transcriptions'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw providerErrorFromNetwork('语音识别', err)
    }
    if (!res.ok) {
      throw await providerErrorFromResponse('语音识别', res)
    }

    const data = await res.json().catch(() => null) as { text?: unknown } | null
    if (!data || typeof data.text !== 'string') {
      throw new VoiceError(VOICE_PROVIDER_ERROR, '语音识别返回格式异常（缺少 text 字段）')
    }
    return { text: data.text }
  }

  async speak(text: string): Promise<SpeakResult> {
    const cfg = ttsConfig()
    if (!isTtsConfigured(cfg)) {
      throw new VoiceError(VOICE_NOT_CONFIGURED, '语音合成未配置，请到 设置 → 语音 填写服务信息')
    }

    let res: Response
    try {
      res = await fetch(endpointUrl(cfg.baseUrl, '/audio/speech'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.model,
          voice: cfg.voice || undefined,
          input: text,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw providerErrorFromNetwork('语音合成', err)
    }
    if (!res.ok) {
      throw await providerErrorFromResponse('语音合成', res)
    }

    return {
      audio: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') || 'audio/mpeg',
    }
  }
}

let singleton: VoiceService | null = null

export function getVoiceService(): VoiceService {
  if (!singleton) singleton = new VoiceService()
  return singleton
}
