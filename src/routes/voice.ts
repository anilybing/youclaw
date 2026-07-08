// [XJC] 语音路由（通用能力对齐 · T-A2 底座）
//   GET  /api/voice/status      — ASR/TTS 配置状态（前端据此显隐按钮/引导设置）
//   POST /api/voice/transcribe  — multipart(file) 语音转文字
//   POST /api/voice/speak       — json({text}) 文字转语音，返回音频流
// 服务实现见 src/voice/service.ts（T-A2 补全 provider HTTP 调用）。

import { Hono } from 'hono'
import type { Context } from 'hono'
import { getVoiceService } from '../voice/service.ts'
import { VoiceError } from '../voice/types.ts'
import { getLogger } from '../logger/index.ts'

const AUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024 // 60s opus 远小于此；防滥用上限
const SPEAK_TEXT_MAX_CHARS = 2000

function voiceErrorResponse(c: Context, err: unknown) {
  if (err instanceof VoiceError) {
    return c.json({ error: err.message, errorCode: err.code }, 400)
  }
  getLogger().error({ error: String(err), category: 'voice' }, 'Voice route failed')
  return c.json({ error: 'Voice service failed' }, 500)
}

export function createVoiceRoutes() {
  const app = new Hono()

  app.get('/voice/status', (c) => {
    return c.json(getVoiceService().status())
  })

  app.post('/voice/transcribe', async (c) => {
    try {
      const formData = await c.req.formData()
      const rawFile = formData.get('file')
      if (!(rawFile instanceof File)) {
        return c.json({ error: 'File is required' }, 400)
      }
      if (rawFile.size > AUDIO_UPLOAD_MAX_BYTES) {
        return c.json({ error: 'Audio exceeds the 25MB limit' }, 400)
      }
      const buffer = new Uint8Array(await rawFile.arrayBuffer())
      const mimeType = rawFile.type || 'audio/webm'
      const result = await getVoiceService().transcribe(buffer, mimeType)
      return c.json(result)
    } catch (err) {
      return voiceErrorResponse(c, err)
    }
  })

  app.post('/voice/speak', async (c) => {
    try {
      const body = await c.req.json() as { text?: string }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return c.json({ error: 'text is required' }, 400)
      if (text.length > SPEAK_TEXT_MAX_CHARS) {
        return c.json({ error: `Text exceeds the ${SPEAK_TEXT_MAX_CHARS} character limit` }, 400)
      }
      const result = await getVoiceService().speak(text)
      return c.body(result.audio.buffer as ArrayBuffer, 200, { 'Content-Type': result.mimeType })
    } catch (err) {
      return voiceErrorResponse(c, err)
    }
  })

  return app
}
