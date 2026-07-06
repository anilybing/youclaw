import { Hono } from 'hono'
import { getAuthToken, saveAuthToken, clearAuthToken } from './auth.ts'
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/index.ts'

/**
 * Commercial auth extension — overrides login flow for MVP.
 * When XiaoJuClaw_API_URL points to our MVP cloud service, login is handled
 * via mobile/email instead of website OAuth redirect.
 *
 * This route file is part of the commercial isolation layer.
 * It mounts BEFORE the upstream auth routes so it takes priority.
 */
export function createCommercialAuthRoutes() {
  const app = new Hono()

  // POST /auth/login — MVP login (mobile/email + displayName)
  // This overrides the upstream GET /auth/login (OAuth redirect)
  app.post('/auth/login', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)

    try {
      const body = await c.req.json() as { mobile?: string; email?: string; displayName?: string }
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ errorMessage: '' })) as { errorMessage?: string }
        return c.json({ error: errorData.errorMessage || 'Login failed' }, res.status as any)
      }

      const data = await res.json() as { success?: boolean; data?: { token?: string; user?: any } }
      if (!data.data?.token) {
        return c.json({ error: 'No token received' }, 500)
      }

      // Save token locally so other routes can use it
      saveAuthToken(data.data.token)

      return c.json({
        token: data.data.token,
        user: data.data.user,
      })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial-auth' }, 'Login failed')
      return c.json({ error: 'Login failed' }, 500)
    }
  })

  // GET /auth/user — proxy to MVP cloud (override upstream to use our API format)
  app.get('/auth/user', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) return c.json({ error: 'Cloud service not configured' }, 501)
    const token = getAuthToken()
    if (!token) return c.json({ error: 'Not logged in' }, 401)

    try {
      const res = await fetch(`${apiUrl}/api/auth/user`, {
        headers: { rdxtoken: token },
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        if (res.status === 401) {
          clearAuthToken()
          return c.json({ error: 'Token expired' }, 401)
        }
        return c.json({ error: 'Failed to fetch user info' }, 500)
      }

      const data = await res.json() as { success?: boolean; data?: any }
      if (!data.data) {
        clearAuthToken()
        return c.json({ error: 'Token expired' }, 401)
      }

      const u = data.data
      return c.json({
        id: u.id ?? '',
        name: u.name ?? '',
        avatar: u.avatar ?? '',
        email: u.email ?? '',
        mobile: u.mobile ?? '',
        activated: u.activated ?? false,
        availableCredit: u.availableCredit ?? 0,
      })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial-auth' }, 'Failed to fetch user info')
      return c.json({ error: 'Failed to fetch user info' }, 500)
    }
  })

  return app
}
