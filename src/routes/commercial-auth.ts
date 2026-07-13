import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { getAuthToken, saveAuthToken, clearAuthToken } from './auth.ts'
import { getLogger } from '../logger/index.ts'
import { getEnv } from '../config/index.ts'

type CloudErrorBody = {
  error?: string
  errorCode?: string
  errorMessage?: string
}

async function forwardCloudError(
  response: Response,
  fallback: string,
): Promise<{ error: string; errorCode: string }> {
  const body = await response.json().catch(() => null) as CloudErrorBody | null
  return {
    error: body?.errorMessage || body?.error || fallback,
    errorCode: body?.errorCode || '',
  }
}

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

  // POST /auth/otp/request — ask MVP to deliver a one-time login code.
  // Identity values are forwarded only to the configured XiaoJuClaw API and are
  // never logged or persisted by the local sidecar.
  app.post('/auth/otp/request', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) {
      return c.json({
        error: 'Cloud service not configured',
        errorCode: 'CLOUD_NOT_CONFIGURED',
      }, 501)
    }

    try {
      const body = await c.req.json() as { mobile?: string; email?: string }
      const res = await fetch(`${apiUrl}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(body.mobile ? { mobile: body.mobile } : {}),
          ...(body.email ? { email: body.email } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        return c.json(
          await forwardCloudError(res, 'Failed to send verification code'),
          res.status as ContentfulStatusCode,
        )
      }

      const data = await res.json() as {
        data?: {
          otpChallengeId?: string
          expiresIn?: number
          identityType?: 'mobile' | 'email'
          maskedIdentity?: string
        }
      }
      if (!data.data?.otpChallengeId) {
        return c.json({
          error: 'Invalid verification response',
          errorCode: 'OTP_RESPONSE_INVALID',
        }, 502)
      }
      return c.json(data.data)
    } catch (err) {
      getLogger().error(
        { error: String(err), category: 'commercial-auth' },
        'OTP request failed',
      )
      return c.json({
        error: 'Cloud service is temporarily unavailable',
        errorCode: 'CLOUD_UNREACHABLE',
      }, 502)
    }
  })

  // POST /auth/login — MVP login (verified mobile/email + displayName)
  // This overrides the upstream GET /auth/login (OAuth redirect)
  app.post('/auth/login', async (c) => {
    const apiUrl = getEnv().XiaoJuClaw_API_URL
    if (!apiUrl) {
      return c.json({
        error: 'Cloud service not configured',
        errorCode: 'CLOUD_NOT_CONFIGURED',
      }, 501)
    }

    try {
      const body = await c.req.json() as {
        mobile?: string
        email?: string
        displayName?: string
        password?: string
        otpChallengeId?: string
        otpCode?: string
      }
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) {
        return c.json(
          await forwardCloudError(res, 'Login failed'),
          res.status as ContentfulStatusCode,
        )
      }

      const data = await res.json() as { success?: boolean; data?: { token?: string; user?: any } }
      if (!data.data?.token) {
        return c.json({
          error: 'No token received',
          errorCode: 'LOGIN_RESPONSE_INVALID',
        }, 502)
      }

      // Save token locally so other routes can use it
      saveAuthToken(data.data.token)

      return c.json({
        token: data.data.token,
        user: data.data.user,
      })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial-auth' }, 'Login failed')
      return c.json({
        error: 'Cloud service is temporarily unavailable',
        errorCode: 'CLOUD_UNREACHABLE',
      }, 502)
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
        planTier: u.planTier ?? null,
      })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'commercial-auth' }, 'Failed to fetch user info')
      return c.json({ error: 'Failed to fetch user info' }, 500)
    }
  })

  return app
}
