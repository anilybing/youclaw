// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { Hono } from 'hono'
import { randomBytes } from 'node:crypto'
import {
  getSettings,
  getStoredSettings,
  updateSettings,
  getActiveModelConfig,
  getBuiltinModelId,
  resolveCustomModelApiKey,
} from '../settings/manager.ts'
import { RegistrySourceSettingSchema, UpdateReleaseChannelSchema } from '../settings/schema.ts'
import { getDatabase } from '../db/index.ts'

const app = new Hono()

// [XJC] 语音配置 apiKey 打码（保留后 4 位），与 customModels 同款策略
function maskVoice(voice: ReturnType<typeof getSettings>['voice']) {
  return {
    asr: { ...voice.asr, apiKey: voice.asr.apiKey ? `****${voice.asr.apiKey.slice(-4)}` : '' },
    tts: { ...voice.tts, apiKey: voice.tts.apiKey ? `****${voice.tts.apiKey.slice(-4)}` : '' },
  }
}

// [XJC] 媒体配置 apiKey 打码（图像/视频组）
function maskMedia(media: ReturnType<typeof getSettings>['media']) {
  return {
    image: { ...media.image, apiKey: media.image.apiKey ? `****${media.image.apiKey.slice(-4)}` : '' },
    video: { ...media.video, apiKey: media.video.apiKey ? `****${media.video.apiKey.slice(-4)}` : '' },
  }
}

function maskCustomModels(models: ReturnType<typeof getStoredSettings>['customModels']) {
  return models.map((model) => {
    const apiKey = resolveCustomModelApiKey(model)
    return {
      ...model,
      apiKey: apiKey ? `****${apiKey.slice(-4)}` : '',
    }
  })
}

// GET /settings — return full settings (apiKey masked)
app.get('/settings', (c) => {
  const settings = getSettings()
  const storedSettings = getStoredSettings()

  // Get the actual modelId of the built-in model for frontend display
  const builtinModelId = getBuiltinModelId()

  // Mask apiKey: keep only last 4 characters
  const masked = {
    ...settings,
    builtinModelId,
    registrySources: {
      clawhub: {
        token: settings.registrySources.clawhub.token ? `****${settings.registrySources.clawhub.token.slice(-4)}` : '',
      },
      tencent: settings.registrySources.tencent,
    },
    customModels: maskCustomModels(storedSettings.customModels),
    voice: maskVoice(settings.voice),
    media: maskMedia(settings.media),
  }

  return c.json(masked)
})

// PATCH /settings — partial update
app.patch('/settings', async (c) => {
  const body = await c.req.json() as Record<string, unknown>

  // Only pick fields actually present in body to avoid Zod defaults overwriting existing data
  const current = getSettings()
  const partial: Record<string, unknown> = {}

  if ('activeModel' in body) {
    partial.activeModel = body.activeModel
  }

  if ('customModels' in body && Array.isArray(body.customModels)) {
    // Preserve original apiKey for masked values
    const existingMap = new Map(current.customModels.map((m) => [m.id, m.apiKey]))
    partial.customModels = (body.customModels as Array<Record<string, unknown>>).map((m) => {
      const apiKey = String(m.apiKey ?? '')
      if (apiKey.startsWith('****') && existingMap.has(String(m.id))) {
        return { ...m, apiKey: existingMap.get(String(m.id))! }
      }
      return m
    })
  }

  if ('defaultRegistrySource' in body) {
    const incoming = body.defaultRegistrySource
    if (incoming !== undefined && incoming !== null) {
      const parsed = RegistrySourceSettingSchema.safeParse(incoming)
      if (!parsed.success) {
        return c.json({ error: 'Invalid defaultRegistrySource' }, 400)
      }
      partial.defaultRegistrySource = parsed.data
    } else {
      partial.defaultRegistrySource = undefined
    }
  }

  // [XJC] 自主进化开关（进化引擎桥）
  if ('evolution' in body && body.evolution && typeof body.evolution === 'object') {
    const incoming = body.evolution as { enabled?: unknown }
    partial.evolution = { enabled: incoming.enabled === true }
  }

  // [XJC] Stable/beta canary preference. Reject unknown values rather than
  // silently opting a user into a pre-release channel.
  if ('update' in body) {
    if (!body.update || typeof body.update !== 'object') {
      return c.json({ error: 'Invalid update channel' }, 400)
    }
    const incoming = body.update as { channel?: unknown }
    const parsed = UpdateReleaseChannelSchema.safeParse(incoming.channel)
    if (!parsed.success) {
      return c.json({ error: 'Invalid update channel' }, 400)
    }
    partial.update = { channel: parsed.data }
  }

  // [XJC] 内置 MCP Server 开关：首次开启且无 token 时自动生成。
  // token 永不接受 PATCH 写入，只能由「重新生成」动作产生，见 POST /settings/mcp-server/regenerate-token。
  // 关闭主开关时一并关闭危险工具，确保下次开启仍需用户二次授权。
  if ('mcpServer' in body && body.mcpServer && typeof body.mcpServer === 'object') {
    const incoming = body.mcpServer as { enabled?: unknown; allowDangerousTools?: unknown }
    const enabled = typeof incoming.enabled === 'boolean' ? incoming.enabled : current.mcpServer.enabled
    const requestedDangerous = typeof incoming.allowDangerousTools === 'boolean'
      ? incoming.allowDangerousTools
      : current.mcpServer.allowDangerousTools
    const allowDangerousTools = enabled && requestedDangerous
    const token = enabled && !current.mcpServer.token ? randomBytes(24).toString('hex') : current.mcpServer.token
    partial.mcpServer = { enabled, allowDangerousTools, token }
  }

  // [XJC] 语音配置（T-A2）：apiKey 为 ****打码值时保留原值，其余透传
  if ('voice' in body && body.voice && typeof body.voice === 'object') {
    const incoming = body.voice as { asr?: Record<string, unknown>; tts?: Record<string, unknown> }
    const resolveKey = (kind: 'asr' | 'tts', group?: Record<string, unknown>) => {
      if (!group) return undefined
      const apiKey = typeof group.apiKey === 'string' ? group.apiKey : undefined
      if (apiKey !== undefined && apiKey.startsWith('****')) {
        return { ...group, apiKey: current.voice[kind].apiKey }
      }
      return group
    }
    partial.voice = {
      ...(incoming.asr ? { asr: resolveKey('asr', incoming.asr) } : {}),
      ...(incoming.tts ? { tts: resolveKey('tts', incoming.tts) } : {}),
    }
  }

  // [XJC] 媒体生成配置：同款 ****保留原值语义
  if ('media' in body && body.media && typeof body.media === 'object') {
    const incoming = body.media as { image?: Record<string, unknown>; video?: Record<string, unknown> }
    const resolveMediaKey = (kind: 'image' | 'video', group?: Record<string, unknown>) => {
      if (!group) return undefined
      const apiKey = typeof group.apiKey === 'string' ? group.apiKey : undefined
      if (apiKey !== undefined && apiKey.startsWith('****')) {
        return { ...group, apiKey: current.media[kind].apiKey }
      }
      return group
    }
    partial.media = {
      ...(incoming.image ? { image: resolveMediaKey('image', incoming.image) } : {}),
      ...(incoming.video ? { video: resolveMediaKey('video', incoming.video) } : {}),
    }
  }

  if ('registrySources' in body && body.registrySources && typeof body.registrySources === 'object') {
    const incoming = body.registrySources as Record<string, unknown>
    const partialSources: Record<string, unknown> = {}

    if ('clawhub' in incoming && incoming.clawhub && typeof incoming.clawhub === 'object') {
      const clawhub = incoming.clawhub as Record<string, unknown>
      partialSources.clawhub = {
        token: typeof clawhub.token === 'string' && clawhub.token.startsWith('****')
          ? current.registrySources.clawhub.token
          : typeof clawhub.token === 'string'
            ? clawhub.token
            : current.registrySources.clawhub.token,
      }
    }

    if ('tencent' in incoming && incoming.tencent && typeof incoming.tencent === 'object') {
      partialSources.tencent = incoming.tencent
    }

    partial.registrySources = partialSources
  }

  const updated = updateSettings(partial)
  const storedUpdated = getStoredSettings()

  // Return masked result
  const masked = {
    ...updated,
    registrySources: {
      clawhub: {
        token: updated.registrySources.clawhub.token ? `****${updated.registrySources.clawhub.token.slice(-4)}` : '',
      },
      tencent: updated.registrySources.tencent,
    },
    customModels: maskCustomModels(storedUpdated.customModels),
    voice: maskVoice(updated.voice),
    media: maskMedia(updated.media),
  }

  return c.json(masked)
})

// [XJC] POST /settings/mcp-server/regenerate-token — 轮换 MCP Server 鉴权 token（旧 token 立即失效）
app.post('/settings/mcp-server/regenerate-token', (c) => {
  const token = randomBytes(24).toString('hex')
  const updated = updateSettings({ mcpServer: { ...getSettings().mcpServer, token } })
  return c.json({ token: updated.mcpServer.token })
})

// GET /settings/active-model — diagnostics only; never expose the stored API key.
app.get('/settings/active-model', (c) => {
  const config = getActiveModelConfig()
  if (!config) {
    return c.json({ source: 'env' })
  }
  return c.json({
    source: 'settings',
    ...config,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : '',
  })
})

// GET /settings/port — get configured port (Web mode)
app.get('/settings/port', (c) => {
  const db = getDatabase()
  const row = db.query("SELECT value FROM kv_state WHERE key = 'preferred_port'").get() as { value: string } | null
  return c.json({ port: row?.value || null })
})

// PUT /settings/port — set port (Web mode)
app.put('/settings/port', async (c) => {
  const { port } = await c.req.json() as { port?: string | null }
  const db = getDatabase()
  if (port) {
    const num = parseInt(port)
    if (isNaN(num) || num < 1024 || num > 65535) {
      return c.json({ error: 'Port must be between 1024 and 65535' }, 400)
    }
    db.run("INSERT OR REPLACE INTO kv_state (key, value) VALUES ('preferred_port', ?)", [String(num)])
  } else {
    db.run("DELETE FROM kv_state WHERE key = 'preferred_port'")
  }
  return c.json({ ok: true })
})

export function createSettingsRoutes() {
  return app
}
