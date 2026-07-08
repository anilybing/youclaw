// [XJC] 语音能力类型（通用能力对齐 · T-A2 底座）
// ASR：语音转文字；TTS：文字转语音。配置存 settings.voice（见 settings/schema.ts）。

export interface VoiceStatus {
  /** ASR 是否已配置可用 */
  asrConfigured: boolean
  /** TTS 是否已配置可用 */
  ttsConfigured: boolean
}

export interface TranscribeResult {
  text: string
}

export interface SpeakResult {
  /** 音频二进制（如 mp3） */
  audio: Uint8Array
  /** 音频 MIME 类型，如 audio/mpeg */
  mimeType: string
}

/** 语音服务错误码：未配置（前端引导去设置页） */
export const VOICE_NOT_CONFIGURED = 'VOICE_NOT_CONFIGURED'
/** 语音服务错误码：供应商调用失败（网络/鉴权/额度） */
export const VOICE_PROVIDER_ERROR = 'VOICE_PROVIDER_ERROR'

export class VoiceError extends Error {
  code: typeof VOICE_NOT_CONFIGURED | typeof VOICE_PROVIDER_ERROR

  constructor(code: typeof VOICE_NOT_CONFIGURED | typeof VOICE_PROVIDER_ERROR, message: string) {
    super(message)
    this.code = code
  }
}
