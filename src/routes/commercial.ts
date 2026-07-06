import { Hono } from 'hono'
import type { Context } from 'hono'
import { getAuthToken } from './auth.ts'
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/index.ts'
import {
  generateUserKeyChat,
  readUserAiConfig,
  userAiConfigStatus,
} from './user-ai.ts'

/**
 * Commercial routes — proxy layer for MVP cloud API.
 * Routes: device, templates, chat
 * These are NOT part of upstream XiaoJuClaw; they live in the commercial isolation layer.
 */
export function createCommercialRoutes() {
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

    let body: { message?: string; deviceId?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid request body' }, 400)
    }

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
        const result = await generateUserKeyChat(message, userConfig)
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
