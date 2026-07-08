// [XJC] TTS 配置状态缓存（通用能力对齐 · T-A2）
// 独立于组件文件：TtsPlayButton 消费、VoicePanel 保存后失效。
// 模块级缓存避免每条消息都打一次 /voice/status。
import { getVoiceStatus } from '@/api/client'

let ttsConfiguredCache: boolean | null = null
let ttsStatusPromise: Promise<boolean> | null = null

export async function isTtsConfigured(): Promise<boolean> {
  if (ttsConfiguredCache !== null) return ttsConfiguredCache
  if (!ttsStatusPromise) {
    ttsStatusPromise = getVoiceStatus()
      .then((s) => { ttsConfiguredCache = s.ttsConfigured; return s.ttsConfigured })
      .catch(() => false)
      .finally(() => { ttsStatusPromise = null })
  }
  return ttsStatusPromise
}

/** 语音设置变化后由 VoicePanel 调用，下次渲染重新探测 */
export function invalidateTtsStatusCache() {
  ttsConfiguredCache = null
}
