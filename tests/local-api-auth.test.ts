import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  createLocalApiAuth,
  LOCAL_API_TICKET_ENDPOINT,
  LOCAL_API_TICKET_QUERY,
  LOCAL_API_TOKEN_HEADER,
  isStandaloneLocalApiDevelopmentRuntime,
  localApiTokenMatches,
} from '../src/middleware/local-auth.ts'

const TOKEN = 'local-api-token-'.padEnd(64, 'a')
const REPO_ROOT = process.cwd()

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

function sourceFiles(dir: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...sourceFiles(path))
    else if (/\.[jt]sx?$/.test(entry.name)) result.push(path)
  }
  return result
}

function createTestApp(
  token: string | undefined,
  options?: Parameters<typeof createLocalApiAuth>[1],
) {
  const auth = createLocalApiAuth(token, options)
  const app = new Hono()
  app.use('/api/*', auth.middleware)
  app.post(LOCAL_API_TICKET_ENDPOINT, auth.issueRealtimeTicket)
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/api/private', (c) => c.json({ secret: true }))
  app.get('/api/ws', (c) => c.text('websocket accepted'))
  app.get('/api/logs/stream', (c) => c.text('sse accepted'))
  app.post('/api/browser/main-bridge/extension-attach', (c) => c.json({ paired: true }))
  app.get('/api/browser/main-bridge/extension-download', (c) => c.text('bundle'))
  app.post('/mcp', (c) => c.text('independent mcp auth'))
  return app
}

function withToken(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      [LOCAL_API_TOKEN_HEADER]: TOKEN,
    },
  }
}

async function issueTicket(
  app: ReturnType<typeof createTestApp>,
  transport: 'websocket' | 'event-source',
) {
  const response = await app.request(LOCAL_API_TICKET_ENDPOINT, withToken({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transport }),
  }))
  expect(response.status).toBe(200)
  return response.json() as Promise<{ ticket: string; expiresAt: string }>
}

describe('local sidecar API authentication', () => {
  test('compares fixed-length token digests and rejects missing values', () => {
    expect(localApiTokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(localApiTokenMatches(`${TOKEN}x`, TOKEN)).toBe(false)
    expect(localApiTokenMatches('', TOKEN)).toBe(false)
    expect(localApiTokenMatches(TOKEN, '')).toBe(false)
  })

  test('protects /api by default without echoing the token', async () => {
    const app = createTestApp(TOKEN)
    const missing = await app.request('/api/private')
    const wrong = await app.request('/api/private', {
      headers: { [LOCAL_API_TOKEN_HEADER]: `${TOKEN}-wrong` },
    })
    const accepted = await app.request('/api/private', withToken())

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).not.toContain(TOKEN)
    expect(accepted.status).toBe(200)
  })

  test('fails closed without a token unless standalone development is explicit', async () => {
    const app = createTestApp(undefined)
    expect((await app.request('/api/private')).status).toBe(401)

    const developmentApp = createTestApp(undefined, {
      allowUnauthenticatedWhenTokenMissing: true,
    })
    expect((await developmentApp.request('/api/private')).status).toBe(200)
    expect(isStandaloneLocalApiDevelopmentRuntime('C:\\tools\\bun.exe')).toBe(true)
    expect(isStandaloneLocalApiDevelopmentRuntime('C:\\app\\XiaoJuClaw-server.exe')).toBe(false)
  })

  test('keeps exemptions exact and leaves root MCP on its independent gate', async () => {
    const app = createTestApp(TOKEN)
    expect((await app.request('/api/health')).status).toBe(200)
    expect((await app.request('/api/browser/main-bridge/extension-attach', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/api/browser/main-bridge/extension-download')).status).toBe(401)
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(200)
  })

  test('mints scoped, short-lived, one-use realtime tickets', async () => {
    let now = 1_000
    let sequence = 0
    const app = createTestApp(TOKEN, {
      now: () => now,
      ticketTtlMs: 50,
      createTicket: () => `ticket-${++sequence}`,
    })

    const websocket = await issueTicket(app, 'websocket')
    const websocketUrl = `/api/ws?${LOCAL_API_TICKET_QUERY}=${encodeURIComponent(websocket.ticket)}`
    expect((await app.request(websocketUrl)).status).toBe(200)
    expect((await app.request(websocketUrl)).status).toBe(401)

    const wrongScope = await issueTicket(app, 'websocket')
    const wrongScopeUrl = `/api/logs/stream?${LOCAL_API_TICKET_QUERY}=${encodeURIComponent(wrongScope.ticket)}`
    expect((await app.request(wrongScopeUrl)).status).toBe(401)
    expect((await app.request(`/api/ws?${LOCAL_API_TICKET_QUERY}=${wrongScope.ticket}`)).status).toBe(401)

    const expired = await issueTicket(app, 'event-source')
    now += 51
    expect((await app.request(
      `/api/logs/stream?${LOCAL_API_TICKET_QUERY}=${expired.ticket}`,
    )).status).toBe(401)
  })

  test('ticket endpoint itself requires the long-lived local token', async () => {
    const app = createTestApp(TOKEN)
    const response = await app.request(LOCAL_API_TICKET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transport: 'websocket' }),
    })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(TOKEN)
  })
})

describe('local API authentication wiring', () => {
  test('all Web fetch calls go through the authenticated transport', () => {
    const webRoot = join(REPO_ROOT, 'web', 'src')
    const directFetchFiles = sourceFiles(webRoot)
      .filter((path) => /\bfetch\s*\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO_ROOT, path).replaceAll('\\', '/'))
      .sort()

    expect(directFetchFiles).toEqual(['web/src/api/transport.ts'])
    expect(read('web/src/api/client.ts')).not.toMatch(/\bfetch\s*\(/)
  })

  test('WebSocket and EventSource obtain scoped tickets before connecting', () => {
    expect(read('web/src/lib/socket-manager.ts')).toContain('getAuthenticatedWebSocketUrl')
    expect(read('web/src/floating/useFloatingResults.ts')).toContain('getAuthenticatedWebSocketUrl')
    expect(read('web/src/hooks/useLogSSE.ts')).toContain('getAuthenticatedEventSourceUrl')
    expect(read('web/src/hooks/useLogSSE.ts')).toContain('next.close()')
  })

  test('Rust injects a random token and limits the retrieval command to trusted windows', () => {
    const rust = read('src-tauri/src/lib.rs')
    expect(rust).toContain('getrandom::fill(&mut bytes)')
    expect(rust).toContain('"XiaoJuClaw_LOCAL_API_TOKEN".into()')
    expect(rust).toContain('fn get_local_api_token(')
    expect(rust).toContain('window.label() != "main" && window.label() != "floating"')
    expect(rust).toContain('.manage(LocalApiToken(local_api_token))')
  })

  test('CORS permits the local header while MCP remains outside /api middleware', () => {
    const routes = read('src/routes/index.ts')
    const middleware = read('src/middleware/local-auth.ts')
    const transport = read('web/src/api/transport.ts')
    expect(routes).toContain("app.use('/api/*', localApiAuth.middleware)")
    expect(routes).toContain("allowHeaders: ['Content-Type', LOCAL_API_TOKEN_HEADER]")
    expect(routes).toContain("app.route('/', createMcpServerRoutes({")
    expect(middleware).toContain("LOCAL_API_TOKEN_HEADER = 'X-XiaoJuClaw-Local-Token'")
    expect(transport).toContain("LOCAL_API_TOKEN_HEADER = 'X-XiaoJuClaw-Local-Token'")
  })
})
