// [XJC] 媒体生成路由（T-B7）
//   GET  /api/media/status          — 图像/改图/视频配置状态（设置页展示）
//   POST /api/media/apply-provider  — 服务商一键分发：一次填 baseUrl+key，按勾选能力写入
//                                     asr/tts/image/video 各组（apiKey 传 '****' 表示复用
//                                     已配置组的明文 key——打码值只在后端可还原，前端拿不到明文）

import { Hono } from 'hono'
import { getMediaService } from '../media/service.ts'
import { getStoredSettings, updateSettings } from '../settings/manager.ts'
import type { Settings } from '../settings/schema.ts'
import { getLogger } from '../logger/index.ts'

const CAPABILITIES = ['asr', 'tts', 'image', 'video'] as const
type Capability = typeof CAPABILITIES[number]

interface ApplyProviderBody {
  baseUrl?: string
  apiKey?: string
  capabilities?: string[]
  /** 各能力的模型名（前端传入，如硅基流动推荐模型；后端不内置任何厂商值） */
  models?: Partial<Record<Capability, string>>
  /** tts 音色（可选） */
  ttsVoice?: string
  /** image 的改图模型（可选） */
  imageEditModel?: string
  /**
   * 图像组的服务风格：'openai-compatible'（默认，硅基流动等）或 'dashscope'（阿里百炼原生）。
   * 仅作用于 image 组；asr/tts/video 恒为 openai-compatible（百炼原生这几项不走同一端点）。
   */
  imageProviderStyle?: 'openai-compatible' | 'dashscope'
}

/** 从已配置组里找一份可复用的明文 key（按 baseUrl 匹配优先，其次任一非空） */
function findReusableKey(settings: Settings, baseUrl: string): string {
  const groups: Array<{ baseUrl: string; apiKey: string }> = [
    settings.voice.asr,
    settings.voice.tts,
    settings.media.image,
    settings.media.video,
  ]
  const norm = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase()
  const target = norm(baseUrl)
  const sameBase = groups.find((g) => g.apiKey && norm(g.baseUrl) === target)
  if (sameBase) return sameBase.apiKey
  const anyKey = groups.find((g) => g.apiKey)
  return anyKey ? anyKey.apiKey : ''
}

export function createMediaRoutes() {
  const app = new Hono()

  app.get('/media/status', (c) => {
    return c.json(getMediaService().status())
  })

  app.post('/media/apply-provider', async (c) => {
    let body: ApplyProviderBody
    try {
      body = await c.req.json() as ApplyProviderBody
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const baseUrl = String(body.baseUrl ?? '').trim()
    if (!baseUrl) return c.json({ error: 'baseUrl is required' }, 400)
    const caps = (body.capabilities ?? []).filter((x): x is Capability => (CAPABILITIES as readonly string[]).includes(x))
    if (caps.length === 0) return c.json({ error: 'capabilities is required' }, 400)

    const current = getStoredSettings()
    let apiKey = String(body.apiKey ?? '').trim()
    if (!apiKey || apiKey.startsWith('****')) {
      // 复用已有明文 key（前端只有打码值）
      apiKey = findReusableKey(current, baseUrl)
      if (!apiKey) return c.json({ error: 'No reusable API key found; provide apiKey', errorCode: 'NO_REUSABLE_KEY' }, 400)
    }

    const models = body.models ?? {}
    const partial: Partial<Settings> = {}
    const voicePartial: Partial<Settings['voice']> = {}
    const mediaPartial: Partial<Settings['media']> = {}

    if (caps.includes('asr')) {
      voicePartial.asr = {
        provider: 'openai-compatible',
        baseUrl,
        apiKey,
        model: models.asr ?? current.voice.asr.model,
      }
    }
    if (caps.includes('tts')) {
      voicePartial.tts = {
        provider: 'openai-compatible',
        baseUrl,
        apiKey,
        model: models.tts ?? current.voice.tts.model,
        voice: body.ttsVoice ?? current.voice.tts.voice,
      }
    }
    if (caps.includes('image')) {
      const imageProvider = body.imageProviderStyle === 'dashscope' ? 'dashscope' : 'openai-compatible'
      mediaPartial.image = {
        provider: imageProvider,
        baseUrl,
        apiKey,
        model: models.image ?? current.media.image.model,
        editModel: body.imageEditModel ?? current.media.image.editModel,
      }
    }
    if (caps.includes('video')) {
      mediaPartial.video = {
        provider: 'openai-compatible',
        baseUrl,
        apiKey,
        model: models.video ?? current.media.video.model,
      }
    }
    if (Object.keys(voicePartial).length > 0) partial.voice = voicePartial as Settings['voice']
    if (Object.keys(mediaPartial).length > 0) partial.media = mediaPartial as Settings['media']

    updateSettings(partial)
    getLogger().info({ capabilities: caps, category: 'media' }, 'Provider credentials applied to capabilities')
    return c.json({ ok: true, applied: caps })
  })

  return app
}
