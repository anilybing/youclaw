import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getAuthToken } from './auth.ts'
import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/index.ts'
import { getPaths } from '../config/paths.ts'
import {
  generateUserKeyChat,
  readUserAiConfig,
  userAiConfigStatus,
} from './user-ai.ts'
import { isModelHint, type ModelHint } from '../agent/model-hints.ts'
import type { AgentManager } from '../agent/index.ts'
import type { RegistryManager } from '../skills/index.ts'

// ─── 远程配置（T-C5）───────────────────────────────────────────────
// 离线默认值与 MVP remote_configs 种子保持一致；拉取成功缓存到数据目录，
// 断网时用缓存，无缓存用默认值 —— 客户端永远能拿到一份配置。
const REMOTE_CONFIG_DEFAULTS: Record<string, unknown> = {
  'features.channels_enabled': false,
  'features.browser_enabled': false,
  'features.skill_market_enabled': true,
  'skills.thirdparty_enabled': false,
  'skills.blacklist': [],
  'announcement': { text: '', link: '', until: '' },
  'ai.model_routing': { primary: '', fallback: [] },
}

function remoteConfigCachePath(): string {
  return resolve(getPaths().data, 'remote-config-cache.json')
}

function readRemoteConfigCache(): { configs: Record<string, unknown>; version: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(remoteConfigCachePath(), 'utf8')) as {
      configs?: Record<string, unknown>
      version?: number
    }
    if (parsed && typeof parsed.configs === 'object' && parsed.configs) {
      return { configs: parsed.configs, version: Number(parsed.version) || 0 }
    }
  } catch { /* 缓存不存在或损坏，走默认 */ }
  return null
}

// ─── 工作台任务卡下发（能力与时俱进 · 阶段一）─────────────────────────
// 服务端下发的任务卡；客户端与内置卡合并（远程同 id 覆盖、新 id 追加）。
// 云端 → 缓存 → 空（空 = 仅用内置卡，离线兜底）三级降级。
function workbenchCachePath(): string {
  return resolve(getPaths().data, 'workbench-cards-cache.json')
}

function readWorkbenchCache(): { cards: unknown[]; version: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(workbenchCachePath(), 'utf8')) as {
      cards?: unknown[]
      version?: number
    }
    if (parsed && Array.isArray(parsed.cards)) {
      return { cards: parsed.cards, version: Number(parsed.version) || 0 }
    }
  } catch { /* 缓存不存在或损坏，回落内置 */ }
  return null
}

// ─── 遥测设备标识（T-C4）────────────────────────────────────────────
// 与设备绑定指纹解耦的匿名上报 id，持久化在 kv_state。
const TELEMETRY_DEVICE_KEY = 'telemetry_device_id'

function getTelemetryDeviceId(): string {
  const db = getDatabase()
  const row = db.query('SELECT value FROM kv_state WHERE key = ?').get(TELEMETRY_DEVICE_KEY) as { value: string } | null
  if (row?.value) return row.value
  const id = `tdev_${randomUUID()}`
  db.run('INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)', [TELEMETRY_DEVICE_KEY, id])
  return id
}

let cachedSidecarVersion = ''
function getSidecarVersion(): string {
  if (cachedSidecarVersion) return cachedSidecarVersion
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
    cachedSidecarVersion = pkg.version || ''
  } catch {
    cachedSidecarVersion = ''
  }
  return cachedSidecarVersion
}

/**
 * Commercial routes — proxy layer for MVP cloud API.
 * Routes: device, templates, chat
 * These are NOT part of upstream XiaoJuClaw; they live in the commercial isolation layer.
 */
export interface CommercialRouteDeps {
  agentManager?: AgentManager
  registryManager?: RegistryManager
}

export function createCommercialRoutes(deps: CommercialRouteDeps = {}) {
  const app = new Hono()

  const PROXY_TIMEOUT = 15000

  // Helper: get cloud API URL or return null
  function getApiUrl(): string | null {
    return getEnv().XiaoJuClaw_API_URL || null
  }

  // Helper: proxy GET request to cloud API
  async function proxyGet(apiUrl: string, path: string, token: string) {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: { rdxtoken: token },
      signal: AbortSignal.timeout(PROXY_TIMEOUT),
    })
    return res
  }

  // Helper: proxy POST request to cloud API
  async function proxyPost(apiUrl: string, path: string, token: string, body: unknown) {
    const res = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: {
        rdxtoken: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROXY_TIMEOUT),
    })
    return res
  }

  // Helper: forward MVP error response (preserves errorCode + errorMessage)
  async function forwardError(
    c: Context,
    res: Response,
    fallbackError: string,
  ) {
    const errorData = (await res.json().catch(() => ({}))) as {
      errorCode?: string
      errorMessage?: string
      error?: string
    }
    return c.json(
      {
        error: errorData.errorMessage || errorData.error || fallbackError,
        errorCode: errorData.errorCode || '',
      },
      res.status as any,
    )
  }

  // ─── Remote Config（T-C5）─────────────────────────────────────────

  // GET /config — 远程配置（云端 → 缓存 → 默认值 三级降级）
  app.get('/config', async (c) => {
    const apiUrl = getApiUrl()
    const token = getAuthToken()

    if (apiUrl && token) {
      try {
        const res = await proxyGet(apiUrl, '/api/client/config', token)
        if (res.ok) {
          const data = await res.json() as { success?: boolean; data?: { configs?: Record<string, unknown>; version?: number } }
          const merged = data.data
          if (merged && merged.configs) {
            const payload = {
              configs: { ...REMOTE_CONFIG_DEFAULTS, ...merged.configs },
              version: Number(merged.version) || 0,
              source: 'cloud' as const,
            }
            try {
              writeFileSync(remoteConfigCachePath(), JSON.stringify(payload), 'utf8')
            } catch { /* 缓存写失败不影响下发 */ }
            return c.json(payload)
          }
        }
      } catch (err) {
        getLogger().warn({ error: String(err), category: 'commercial' }, 'Remote config fetch failed, fallback to cache')
      }
    }

    const cached = readRemoteConfigCache()
    if (cached) {
      return c.json({ configs: { ...REMOTE_CONFIG_DEFAULTS, ...cached.configs }, version: cached.version, source: 'cache' })
    }
    return c.json({ configs: REMOTE_CONFIG_DEFAULTS, version: 0, source: 'default' })
  })

  // GET /cloud-reachable — 探测 MVP 云端是否可达（不依赖登录态，命中 MVP 公共 /api/health）。
  // 供客户端「连不上远程服务器就降级为离线可用」用：未配置云端 → configured:false；
  // 配置了但短超时内不可达 → reachable:false。绝不阻塞（异常一律当不可达）。
  app.get('/cloud-reachable', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ configured: false, reachable: false })
    try {
      const res = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(5000) })
      return c.json({ configured: true, reachable: res.ok })
    } catch {
      return c.json({ configured: true, reachable: false })
    }
  })

  // GET /workbench — 服务端下发的工作台任务卡（云端 → 缓存 → 空 三级降级）。
  // 返回空数组时客户端只用内置卡；离线版无 apiUrl，天然回落内置。
  app.get('/workbench', async (c) => {
    const apiUrl = getApiUrl()
    const token = getAuthToken()

    if (apiUrl && token) {
      try {
        const res = await proxyGet(apiUrl, '/api/client/workbench.json', token)
        if (res.ok) {
          const data = await res.json() as { success?: boolean; data?: { cards?: unknown[]; version?: number } }
          const merged = data.data
          if (merged && Array.isArray(merged.cards)) {
            const payload = { cards: merged.cards, version: Number(merged.version) || 0, source: 'cloud' as const }
            try {
              writeFileSync(workbenchCachePath(), JSON.stringify(payload), 'utf8')
            } catch { /* 缓存写失败不影响下发 */ }
            return c.json(payload)
          }
        }
      } catch (err) {
        getLogger().warn({ error: String(err), category: 'commercial' }, 'Workbench cards fetch failed, fallback to cache')
      }
    }

    const cached = readWorkbenchCache()
    if (cached) {
      return c.json({ cards: cached.cards, version: cached.version, source: 'cache' })
    }
    return c.json({ cards: [], version: 0, source: 'default' })
  })

  // POST /staff/sync — 拉取服务端下发的数字员工定义并按哨兵种子落地（能力与时俱进 · 阶段三）。
  // 需登录 + 具备 agent/registry 管理器；离线（无 apiUrl/token）时静默跳过，只用内置员工。
  app.post('/staff/sync', async (c) => {
    const apiUrl = getApiUrl()
    const token = getAuthToken()
    if (!apiUrl || !token || !deps.agentManager) {
      return c.json({ seeded: [], skipped: 0, source: 'offline' })
    }
    try {
      const res = await proxyGet(apiUrl, '/api/client/staff.json', token)
      if (!res.ok) return c.json({ seeded: [], skipped: 0, source: 'error' })
      const data = await res.json() as { success?: boolean; data?: { agents?: unknown[] } }
      const agents = data.data && Array.isArray(data.data.agents) ? data.data.agents : []
      const registryManager = deps.registryManager
      const installSkill = registryManager
        ? (slug: string) => registryManager.installSkill(slug, 'xiaojuclaw')
        : undefined
      const result = await deps.agentManager.seedRemoteStaff(agents, installSkill)
      if (result.seeded.length > 0) {
        getLogger().info({ seeded: result.seeded, category: 'commercial' }, 'Remote digital staff seeded')
      }
      return c.json({ ...result, source: 'cloud' })
    } catch (err) {
      getLogger().warn({ error: String(err), category: 'commercial' }, 'Remote staff sync failed')
      return c.json({ seeded: [], skipped: 0, source: 'error' })
    }
  })

  // ─── Telemetry（T-C4 桌面端）──────────────────────────────────────

  // POST /telemetry — 遥测上报代理（补全设备 id / 版本 / 平台，失败静默）
  app.post('/telemetry', async (c) => {
    const apiUrl = getApiUrl()
    const token = getAuthToken()
    if (!apiUrl || !token) return c.json({ accepted: false, reason: 'OFFLINE' })

    try {
      const body = await c.req.json() as { eventType?: string; payload?: unknown }
      const res = await proxyPost(apiUrl, '/api/client/telemetry', token, {
        eventType: body.eventType,
        payload: body.payload,
        deviceId: getTelemetryDeviceId(),
        appVersion: getSidecarVersion(),
        platform: process.platform,
      })
      if (!res.ok) return c.json({ accepted: false, reason: `HTTP_${res.status}` })
      const data = await res.json() as { success?: boolean; data?: unknown }
      return c.json(data.data ?? { accepted: true })
    } catch (err) {
      getLogger().warn({ error: String(err), category: 'commercial' }, 'Telemetry report failed')
      return c.json({ accepted: false, reason: 'NETWORK' })
    }
  })

  // ─── Device Routes ───────────────────────────────────────────────

  // GET /device/list — list user's bound devices
  app.get('/device/list', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const res = await proxyGet(apiUrl, '/api/device/list', token)
      if (!res.ok) return forwardError(c, res, 'Failed to fetch devices')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? { items: [] })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch devices')
      return c.json({ error: 'Failed to fetch devices' }, 500)
    }
  })

  // POST /device/unbind — unbind a device
  app.post('/device/unbind', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const body = await c.req.json() as { deviceId?: string }
      const res = await proxyPost(apiUrl, '/api/device/unbind', token, body)
      if (!res.ok) return forwardError(c, res, 'Failed to unbind device')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? { ok: true })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to unbind device')
      return c.json({ error: 'Failed to unbind device' }, 500)
    }
  })

  // ─── Template Routes ─────────────────────────────────────────────

  // GET /templates/list — list available templates
  app.get('/templates/list', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const category = c.req.query('category')
      const path = category
        ? `/api/templates/list?category=${encodeURIComponent(category)}`
        : '/api/templates/list'
      const res = await proxyGet(apiUrl, path, token)
      if (!res.ok) return forwardError(c, res, 'Failed to fetch templates')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? { items: [] })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch templates')
      return c.json({ error: 'Failed to fetch templates' }, 500)
    }
  })

  // GET /templates/detail — get template detail
  app.get('/templates/detail', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const templateKey = c.req.query('templateKey')
      if (!templateKey) return c.json({ error: 'templateKey is required' }, 400)
      const res = await proxyGet(apiUrl, `/api/templates/detail?templateKey=${encodeURIComponent(templateKey)}`, token)
      if (!res.ok) return forwardError(c, res, 'Failed to fetch template detail')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch template detail')
      return c.json({ error: 'Failed to fetch template detail' }, 500)
    }
  })

  // POST /templates/run — execute a template
  app.post('/templates/run', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const body = await c.req.json()
      const res = await proxyPost(apiUrl, '/api/templates/run', token, body)
      if (!res.ok) return forwardError(c, res, 'Failed to run template')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to run template')
      return c.json({ error: 'Failed to run template' }, 500)
    }
  })

  // GET /templates/run-detail — get template run detail
  app.get('/templates/run-detail', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const runId = c.req.query('runId')
      if (!runId) return c.json({ error: 'runId is required' }, 400)
      const res = await proxyGet(apiUrl, `/api/templates/run-detail?runId=${encodeURIComponent(runId)}`, token)
      if (!res.ok) return forwardError(c, res, 'Failed to fetch run detail')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch run detail')
      return c.json({ error: 'Failed to fetch run detail' }, 500)
    }
  })

  // ─── AI Preferences Proxy ────────────────────────────────────────

  // GET /ai/preferences — read AI mode (platform / user_key)
  app.get('/ai/preferences', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const res = await proxyGet(apiUrl, '/api/ai/preferences', token)
      if (!res.ok) return forwardError(c, res, 'Failed to read AI preferences')
      const data = await res.json() as { success?: boolean; data?: { aiMode?: string; userKeyEnabled?: boolean; updatedAt?: string } }
      return c.json({
        ...(data.data ?? { aiMode: 'platform', userKeyEnabled: false }),
        userKeyConfigStatus: userAiConfigStatus(),
      })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to read AI preferences')
      return c.json({ error: 'Failed to read AI preferences' }, 500)
    }
  })

  // POST /ai/preferences — update AI mode
  app.post('/ai/preferences', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const body = await c.req.json() as { aiMode?: string; userKeyEnabled?: boolean }
      // 切换到 user_key 之前先校验本地是否已配置完整
      if (body.aiMode === 'user_key') {
        const status = userAiConfigStatus()
        if (!status.baseUrlConfigured || !status.modelConfigured || !status.apiKeyConfigured) {
          return c.json(
            {
              error: '尚未配置完整的本地 AI Key（需要 BaseURL、Model、Key），请先在「个人中心 - 用户自带 Key」中填写',
              errorCode: 'USER_AI_NOT_CONFIGURED',
            },
            400,
          )
        }
      }
      const res = await proxyPost(apiUrl, '/api/ai/preferences', token, body)
      if (!res.ok) return forwardError(c, res, 'Failed to update AI preferences')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json({
        ...(data.data ?? null),
        userKeyConfigStatus: userAiConfigStatus(),
      })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to update AI preferences')
      return c.json({ error: 'Failed to update AI preferences' }, 500)
    }
  })

  // GET /ai/user-key/status — only reports whether local user-key config is complete (no values)
  app.get('/ai/user-key/status', async (c) => {
    return c.json(userAiConfigStatus())
  })

  // ─── Chat Route ──────────────────────────────────────────────────

  // POST /chat/run — free chat (dispatch by ai_mode: platform → MVP, user_key → local)
  app.post('/chat/run', async (c) => {
    const apiUrl = getApiUrl()
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    let body: { message?: string; deviceId?: string; hint?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    // T-G3：可选路由 hint（chat/reasoning/memory/fast/vision），非法值静默忽略
    const hint: ModelHint | undefined = isModelHint(body.hint) ? body.hint : undefined
    if (body.hint !== undefined && !hint) delete body.hint

    // 读取用户 AI 模式偏好（容错：失败时按 platform 处理）
    let aiMode = 'platform'
    try {
      const prefRes = await proxyGet(apiUrl, '/api/ai/preferences', token)
      if (prefRes.ok) {
        const prefData = await prefRes.json() as { success?: boolean; data?: { aiMode?: string } }
        aiMode = prefData.data?.aiMode || 'platform'
      }
    } catch (err) {
      getLogger().warn({ error: String(err), category: 'commercial' }, 'Failed to read AI preferences, fallback to platform')
    }

    if (aiMode === 'user_key') {
      const userConfig = readUserAiConfig()
      if (!userConfig) {
        return c.json(
          {
            error: '当前为「自带 Key」模式，但本地未配置完整 AI Key，请到个人中心填写或切回平台模式',
            errorCode: 'USER_AI_NOT_CONFIGURED',
          },
          400,
        )
      }
      const message = String(body.message || '').trim()
      if (!message) return c.json({ error: '请输入聊天内容', errorCode: 'CHAT_INPUT_INVALID' }, 400)

      try {
        const result = await generateUserKeyChat(message, userConfig, hint)
        return c.json({
          runId: '',
          runStatus: 'success',
          creditCost: 0,
          outputContent: result.outputContent,
          balanceAfter: null,
          aiMode: 'user_key',
          providerName: result.providerName,
          modelName: result.modelName,
        })
      } catch (err) {
        const code = (err as Error & { errorCode?: string }).errorCode || 'USER_AI_GENERATION_FAILED'
        const message = err instanceof Error ? err.message : 'User AI 调用失败'
        getLogger().error({ error: message, category: 'commercial' }, 'User-key chat failed')
        return c.json({ error: message, errorCode: code }, 502)
      }
    }

    // platform 模式：原有代理 + MVP 扣费链路
    try {
      const res = await proxyPost(apiUrl, '/api/chat/run', token, body)
      if (!res.ok) return forwardError(c, res, 'Failed to run chat')
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json({ ...(data.data ?? null), aiMode: 'platform' })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to run chat')
      return c.json({ error: 'Failed to run chat' }, 500)
    }
  })

  return app
}
