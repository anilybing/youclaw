import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import './setup.ts'
import { getEnv } from '../src/config/index.ts'
import { getAuthToken, saveAuthToken } from '../src/routes/auth.ts'
import { createCommercialAuthRoutes } from '../src/routes/commercial-auth.ts'
import { cleanTables } from './setup.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('commercial OTP auth proxy', () => {
  const originalFetch = globalThis.fetch
  const env = getEnv()
  const originalApiUrl = env.XiaoJuClaw_API_URL

  beforeEach(() => {
    cleanTables('kv_state')
    env.XiaoJuClaw_API_URL = 'https://cloud.example.test'
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    cleanTables('kv_state')
    env.XiaoJuClaw_API_URL = originalApiUrl
    globalThis.fetch = originalFetch
  })

  test('requests an OTP without persisting or logging the identity locally', async () => {
    let forwardedBody: Record<string, unknown> | null = null
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://cloud.example.test/api/auth/otp/request')
      expect(init?.method).toBe('POST')
      forwardedBody = JSON.parse(String(init?.body))
      return jsonResponse({
        success: true,
        data: {
          otpChallengeId: 'otp_test_challenge',
          expiresIn: 300,
          identityType: 'email',
          maskedIdentity: 'al***@example.com',
        },
      })
    }) as typeof fetch

    const response = await createCommercialAuthRoutes().request('/auth/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      otpChallengeId: 'otp_test_challenge',
      expiresIn: 300,
      identityType: 'email',
      maskedIdentity: 'al***@example.com',
    })
    expect(forwardedBody).toEqual({ email: 'alice@example.com' })
    expect(getAuthToken()).toBeNull()
  })

  test('forwards the verified challenge and persists only a successful token', async () => {
    let forwardedBody: Record<string, unknown> | null = null
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body))
      return jsonResponse({
        success: true,
        data: {
          token: 'verified-token',
          user: {
            id: 'usr_1',
            name: 'Alice',
            email: 'alice@example.com',
          },
        },
      })
    }) as typeof fetch

    const response = await createCommercialAuthRoutes().request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        displayName: 'Alice',
        otpChallengeId: 'otp_test_challenge',
        otpCode: '123456',
      }),
    })

    expect(response.status).toBe(200)
    expect(forwardedBody).toEqual({
      email: 'alice@example.com',
      displayName: 'Alice',
      otpChallengeId: 'otp_test_challenge',
      otpCode: '123456',
    })
    expect(getAuthToken()).toBe('verified-token')
  })

  test('preserves cloud OTP error codes and never saves a failed login token', async () => {
    globalThis.fetch = mock(async () => jsonResponse({
      success: false,
      errorCode: 'OTP_EXPIRED',
      errorMessage: '验证码已过期，请重新获取',
    }, 401)) as typeof fetch

    const response = await createCommercialAuthRoutes().request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mobile: '13800138000',
        otpChallengeId: 'otp_expired',
        otpCode: '123456',
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: '验证码已过期，请重新获取',
      errorCode: 'OTP_EXPIRED',
    })
    expect(getAuthToken()).toBeNull()
  })

  test('maps the effective plan from the authenticated cloud user', async () => {
    saveAuthToken('verified-token')
    globalThis.fetch = mock(async () => jsonResponse({
      success: true,
      data: {
        id: 'usr_1',
        name: 'Alice',
        avatar: '',
        email: 'alice@example.com',
        mobile: '',
        activated: true,
        availableCredit: 88,
        planTier: 'premium',
      },
    })) as typeof fetch

    const response = await createCommercialAuthRoutes().request('/auth/user')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: 'usr_1',
      activated: true,
      availableCredit: 88,
      planTier: 'premium',
    })
  })

  test('turns cloud transport failures into an offline-fallback signal', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused')
    }) as typeof fetch

    const response = await createCommercialAuthRoutes().request('/auth/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '13800138000' }),
    })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'Cloud service is temporarily unavailable',
      errorCode: 'CLOUD_UNREACHABLE',
    })
  })
})
