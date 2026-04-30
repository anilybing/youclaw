import { Hono } from 'hono'
import { getAuthToken } from './auth.ts'
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/index.ts'

/**
 * Commercial routes — proxy layer for MVP cloud API.
 * Routes: device, templates, chat
 * These are NOT part of upstream YouClaw; they live in the commercial isolation layer.
 */
export function createCommercialRoutes() {
  const app = new Hono()

  // Helper: get cloud API URL or return error
  function getApiUrl(c: any): string | null {
    const apiUrl = getEnv().YOUCLAW_API_URL
    if (!apiUrl) {
      return null
    }
    return apiUrl
  }

  // Helper: proxy GET request to cloud API
  async function proxyGet(path: string, token: string) {
    const apiUrl = getEnv().YOUCLAW_API_URL
    const res = await fetch(`${apiUrl}${path}`, {
      headers: { rdxtoken: token },
    })
    return res
  }

  // Helper: proxy POST request to cloud API
  async function proxyPost(path: string, token: string, body: unknown) {
    const apiUrl = getEnv().YOUCLAW_API_URL
    const res = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: {
        rdxtoken: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return res
  }

  // ─── Device Routes ───────────────────────────────────────────────

  // GET /device/list — list user's bound devices
  app.get('/device/list', async (c) => {
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const res = await proxyGet('/api/device/list', token)
      if (!res.ok) return c.json({ error: 'Failed to fetch devices' }, res.status as any)
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? { items: [] })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch devices')
      return c.json({ error: 'Failed to fetch devices' }, 500)
    }
  })

  // POST /device/unbind — unbind a device
  app.post('/device/unbind', async (c) => {
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const body = await c.req.json() as { deviceId?: string }
      const res = await proxyPost('/api/device/unbind', token, body)
      if (!res.ok) return c.json({ error: 'Failed to unbind device' }, res.status as any)
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
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const category = c.req.query('category')
      const path = category
        ? `/api/templates/list?category=${encodeURIComponent(category)}`
        : '/api/templates/list'
      const res = await proxyGet(path, token)
      if (!res.ok) return c.json({ error: 'Failed to fetch templates' }, res.status as any)
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? { items: [] })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch templates')
      return c.json({ error: 'Failed to fetch templates' }, 500)
    }
  })

  // GET /templates/detail — get template detail
  app.get('/templates/detail', async (c) => {
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const templateKey = c.req.query('templateKey')
      if (!templateKey) return c.json({ error: 'templateKey is required' }, 400)
      const res = await proxyGet(`/api/templates/detail?templateKey=${encodeURIComponent(templateKey)}`, token)
      if (!res.ok) return c.json({ error: 'Failed to fetch template detail' }, res.status as any)
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch template detail')
      return c.json({ error: 'Failed to fetch template detail' }, 500)
    }
  })

  // POST /templates/run — execute a template
  app.post('/templates/run', async (c) => {
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const body = await c.req.json()
      const res = await proxyPost('/api/templates/run', token, body)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        return c.json({ error: errorData.errorMessage || 'Failed to run template' }, res.status as any)
      }
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to run template')
      return c.json({ error: 'Failed to run template' }, 500)
    }
  })

  // GET /templates/run-detail — get template run detail
  app.get('/templates/run-detail', async (c) => {
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const runId = c.req.query('runId')
      if (!runId) return c.json({ error: 'runId is required' }, 400)
      const res = await proxyGet(`/api/templates/run-detail?runId=${encodeURIComponent(runId)}`, token)
      if (!res.ok) return c.json({ error: 'Failed to fetch run detail' }, res.status as any)
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to fetch run detail')
      return c.json({ error: 'Failed to fetch run detail' }, 500)
    }
  })

  // ─── Chat Route ──────────────────────────────────────────────────

  // POST /chat/run — free chat
  app.post('/chat/run', async (c) => {
    const apiUrl = getApiUrl(c)
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const body = await c.req.json()
      const res = await proxyPost('/api/chat/run', token, body)
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}))
        return c.json({ error: errorData.errorMessage || 'Failed to run chat' }, res.status as any)
      }
      const data = await res.json() as { success?: boolean; data?: any }
      return c.json(data.data ?? null)
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial' }, 'Failed to run chat')
      return c.json({ error: 'Failed to run chat' }, 500)
    }
  })

  return app
}
