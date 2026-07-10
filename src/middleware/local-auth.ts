// [XJC] Sidecar loopback API authentication. Release builds receive a per-app
// token from Tauri; standalone/web development remains compatible when unset.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import type { Context, MiddlewareHandler } from 'hono'

export const LOCAL_API_TOKEN_HEADER = 'X-XiaoJuClaw-Local-Token'
export const LOCAL_API_TICKET_QUERY = 'xjc_local_ticket'
export const LOCAL_API_TICKET_ENDPOINT = '/api/local-auth/realtime-ticket'

const DEFAULT_TICKET_TTL_MS = 30_000
const MAX_PENDING_TICKETS = 256

const REALTIME_PATHS = {
  websocket: '/api/ws',
  'event-source': '/api/logs/stream',
} as const

export type LocalRealtimeTransport = keyof typeof REALTIME_PATHS

// These are called by the separately packaged browser extension as part of a
// bridge established through a short-lived pairing code. Keep the exemption
// exact so profile management and extension package download stay protected.
const BROWSER_EXTENSION_EXEMPT_PATHS = new Set([
  '/api/browser/main-bridge/extension-attach',
  '/api/browser/main-bridge/extension-switch',
  '/api/browser/main-bridge/extension-detach',
  '/api/browser/main-bridge/extension-poll',
  '/api/browser/main-bridge/extension-result',
  '/api/browser/main-bridge/extension-sync',
])

type TicketEntry = {
  path: string
  expiresAt: number
}

type LocalApiAuthOptions = {
  now?: () => number
  createTicket?: () => string
  ticketTtlMs?: number
  allowUnauthenticatedWhenTokenMissing?: boolean
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function localApiTokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  // Hash both values to fixed-length buffers before constant-time comparison.
  return timingSafeEqual(digest(provided), digest(expected))
}

export function isLocalApiAuthExempt(method: string, pathname: string): boolean {
  if (method === 'OPTIONS') return true
  if ((method === 'GET' || method === 'HEAD') && pathname === '/api/health') return true
  return (method === 'POST' || method === 'OPTIONS') && BROWSER_EXTENSION_EXEMPT_PATHS.has(pathname)
}

export function isStandaloneLocalApiDevelopmentRuntime(
  executable = process.execPath,
): boolean {
  const name = basename(executable).toLowerCase()
  return name === 'bun' || name === 'bun.exe'
}

export function createLocalApiAuth(
  expectedToken: string | undefined,
  options: LocalApiAuthOptions = {},
) {
  const now = options.now ?? Date.now
  const createTicket = options.createTicket ?? (() => randomBytes(24).toString('base64url'))
  const ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS
  const pendingTickets = new Map<string, TicketEntry>()
  const enabled = Boolean(expectedToken)
  const developmentBypass =
    !enabled && options.allowUnauthenticatedWhenTokenMissing === true

  function pruneExpiredTickets(): void {
    const current = now()
    for (const [key, entry] of pendingTickets) {
      if (entry.expiresAt <= current) pendingTickets.delete(key)
    }
    while (pendingTickets.size >= MAX_PENDING_TICKETS) {
      const oldest = pendingTickets.keys().next().value
      if (typeof oldest !== 'string') break
      pendingTickets.delete(oldest)
    }
  }

  function consumeRealtimeTicket(ticket: string, pathname: string): boolean {
    if (!ticket) return false
    const key = digest(ticket).toString('hex')
    const entry = pendingTickets.get(key)
    // Tickets are one-use even when invalid for this path, limiting replay and
    // preventing a leaked ticket from being retried against another transport.
    if (entry) pendingTickets.delete(key)
    return Boolean(entry && entry.expiresAt > now() && entry.path === pathname)
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    if (developmentBypass) return next()

    const pathname = new URL(c.req.url).pathname
    if (isLocalApiAuthExempt(c.req.method, pathname)) return next()

    const provided = c.req.header(LOCAL_API_TOKEN_HEADER) ?? ''
    if (expectedToken && localApiTokenMatches(provided, expectedToken)) return next()

    if (
      (pathname === REALTIME_PATHS.websocket || pathname === REALTIME_PATHS['event-source'])
      && consumeRealtimeTicket(c.req.query(LOCAL_API_TICKET_QUERY) ?? '', pathname)
    ) {
      return next()
    }

    return c.json({ error: 'Unauthorized: invalid or missing local API token.' }, 401)
  }

  async function issueRealtimeTicket(c: Context) {
    // Defense in depth: this endpoint is normally behind middleware, but must
    // never mint a ticket when mounted incorrectly or when dev auth is disabled.
    const provided = c.req.header(LOCAL_API_TOKEN_HEADER) ?? ''
    if (!expectedToken || !localApiTokenMatches(provided, expectedToken)) {
      return c.json({ error: 'Unauthorized: invalid or missing local API token.' }, 401)
    }

    const body = await c.req.json().catch(() => null) as { transport?: unknown } | null
    const transport = body?.transport
    if (transport !== 'websocket' && transport !== 'event-source') {
      return c.json({ error: 'Invalid realtime transport.' }, 400)
    }

    pruneExpiredTickets()
    const ticket = createTicket()
    const expiresAt = now() + ticketTtlMs
    pendingTickets.set(digest(ticket).toString('hex'), {
      path: REALTIME_PATHS[transport],
      expiresAt,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
    })
  }

  return {
    enabled,
    developmentBypass,
    middleware,
    issueRealtimeTicket,
  }
}
