export type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error'

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return String(error)
}

export function maskToken(token?: string | null): string | null {
  if (!token) return null
  if (token.length <= 12) {
    return `${token.slice(0, 4)}...`
  }
  return `${token.slice(0, 8)}...${token.slice(-4)}`
}

export function sanitizeDeepLink(rawUrl?: string | null): string | null {
  if (!rawUrl) return null

  const start = rawUrl.indexOf('XiaoJuClaw://')
  const normalized = (start === -1 ? rawUrl : rawUrl.slice(start))
    .trim()
    .replace(/^['"]+/, '')
    .replace(/['"]+$/, '')

  try {
    const url = new URL(normalized)
    if (url.searchParams.has('token')) {
      url.searchParams.set('token', '<redacted>')
    }
    return url.toString()
  } catch {
    return normalized.replace(/token=[^&\s]+/gi, 'token=<redacted>')
  }
}

export async function logAuthClientEvent(
  level: AuthLogLevel,
  message: string,
  context: Record<string, unknown> = {},
) {
  console[level](`[auth-client] ${message}`, context)
}
