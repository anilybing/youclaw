// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { Hono } from 'hono'
import { getAuthToken } from './auth.ts'
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/index.ts'

export function createCreditRoutes() {
  const app = new Hono()

  // GET /credit/balance — query credit balance
  app.get('/credit/balance', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) {
      return c.json({ error: 'Cloud service not configured' }, 501)
    }
    const token = getAuthToken()
    if (!token) {
      return c.json({ error: 'Not logged in' }, 401)
    }

    try {
      const res = await fetch(`${apiUrl}/api/credit/balance`, {
        headers: { rdxtoken: token },
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        return c.json({ error: 'Failed to fetch balance' }, 500)
      }

      const data = await res.json() as { success?: boolean; data?: { balance?: number } }
      const balance = data.data?.balance ?? 0
      return c.json({ balance })
    } catch (err) {
      const logger = getLogger()
      logger.error({ error: String(err), category: 'credit' }, 'Failed to fetch credit balance')
      return c.json({ error: 'Failed to fetch balance' }, 500)
    }
  })

  // GET /credit/transactions — query credit transactions
  app.get('/credit/transactions', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) {
      return c.json({ error: 'Cloud service not configured' }, 501)
    }
    const token = getAuthToken()
    if (!token) {
      return c.json({ error: 'Not logged in' }, 401)
    }

    try {
      const url = new URL(`${apiUrl}/api/credit/transactions`)
      const limit = c.req.query('limit')
      if (limit) url.searchParams.set('limit', limit)

      const res = await fetch(url.toString(), {
        headers: { rdxtoken: token },
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        return c.json({ error: 'Failed to fetch transactions' }, 500)
      }

      const data = await res.json() as { success?: boolean; data?: unknown }
      return c.json(data.data ?? [])
    } catch (err) {
      const logger = getLogger()
      logger.error({ error: String(err), category: 'credit' }, 'Failed to fetch credit transactions')
      return c.json({ error: 'Failed to fetch transactions' }, 500)
    }
  })

  // POST /invitation/redeem — redeem invitation/activation code
  app.post('/invitation/redeem', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) {
      return c.json({ error: 'Cloud service not configured' }, 501)
    }
    const token = getAuthToken()
    if (!token) {
      return c.json({ error: 'Not logged in' }, 401)
    }

    try {
      const body = await c.req.json() as { code?: string; deviceName?: string; deviceFingerprint?: string; osName?: string; clientVersion?: string }
      const code = body.code
      if (!code) {
        return c.json({ error: 'Code is required' }, 400)
      }

      const url = new URL(`${apiUrl}/api/invitation/redeem`)
      url.searchParams.set('code', code)

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          rdxtoken: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        const text = await res.text()
        const logger = getLogger()
        logger.error({ status: res.status, body: text, category: 'invitation' }, 'Failed to redeem code')
        return c.json({ error: 'Failed to redeem code' }, res.status as any)
      }

      const data = await res.json() as { success?: boolean; errorCode?: string; errorMessage?: string }
      // Java backend may return 200 with success: false
      if (data.success === false) {
        return c.json({ error: data.errorCode || data.errorMessage || 'Failed to redeem code' }, 400)
      }
      return c.json((data as any).data ?? data)
    } catch (err) {
      const logger = getLogger()
      logger.error({ error: String(err), category: 'invitation' }, 'Failed to redeem invitation code')
      return c.json({ error: 'Failed to redeem code' }, 500)
    }
  })

  // Referral code routes removed — not applicable for USB activation model

  return app
}
