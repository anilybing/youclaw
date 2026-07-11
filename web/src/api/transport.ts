// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// Transport abstraction layer: auto-detect Tauri / Web environment

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: TauriInternals
}

export type PortableDiskSpace = {
  data_dir: string
  total_bytes: number
  free_bytes: number
  used_bytes: number
  free_percent: number
  warning_level: 'ok' | 'low' | 'critical'
}

export type SidecarStatus = {
  status: 'pending' | 'ready' | 'error' | 'terminated' | 'port-conflict'
  message: string
}

export type ReadinessProbeResult = 'ready' | 'pending' | 'failed'

type ReadinessPollOptions = {
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// Rust allows the sidecar 90 seconds to become healthy. Keep the frontend
// window slightly wider so both layers agree in slow USB / antivirus setups.
export const SIDECAR_STARTUP_TIMEOUT_MS = 100_000
export const SIDECAR_READINESS_POLL_MS = 500
const SIDECAR_HEALTH_REQUEST_TIMEOUT_MS = 1_500
export const LOCAL_API_TOKEN_HEADER = 'X-XiaoJuClaw-Local-Token'
const LOCAL_API_TICKET_ENDPOINT = '/api/local-auth/realtime-ticket'
const LOCAL_API_TICKET_QUERY = 'xjc_local_ticket'

function getTauriInternals(): TauriInternals | undefined {
  return (window as TauriWindow).__TAURI_INTERNALS__
}

// Check multiple signals to handle edge cases where __TAURI_INTERNALS__ hasn't been injected yet
export const isTauri =
  typeof window !== "undefined" &&
  (!!getTauriInternals() ||
    window.location.hostname === "tauri.localhost" ||
    window.location.protocol === "tauri:")

/**
 * Convert a local file path to a URL loadable by the webview.
 * Uses Tauri's asset protocol when available, falls back to file:// URL.
 */
export function localAssetUrl(filePath: string): string {
  if (isTauri) {
    // Tauri 2 asset protocol: identical to convertFileSrc() from @tauri-apps/api/core
    const encoded = encodeURIComponent(filePath)
    return navigator.userAgent.includes('Windows')
      ? `http://asset.localhost/${encoded}`
      : `asset://localhost/${encoded}`
  }
  return `file://${filePath}`
}

export function getTauriInvoke(): (cmd: string, args?: Record<string, unknown>) => Promise<unknown> {
  if (!isTauri) throw new Error("Not in Tauri environment")
  return getTauriInternals()!.invoke
}

// Cache backend baseUrl and the runtime-only local token in memory. The token
// is deliberately never persisted to localStorage/Tauri Store or logged.
let _cachedBaseUrl: string | null = null
let _cachedLocalApiToken: string | null | undefined
let _localApiTokenPromise: Promise<string | null> | null = null

export function updateCachedBaseUrl(url: string): void {
  _cachedBaseUrl = url
}

export async function getLocalApiToken(): Promise<string | null> {
  if (!isTauri) return null
  if (_cachedLocalApiToken !== undefined) return _cachedLocalApiToken
  if (_localApiTokenPromise) return _localApiTokenPromise

  _localApiTokenPromise = getTauriInvoke()('get_local_api_token')
    .then((value) => {
      _cachedLocalApiToken = typeof value === 'string' && value.length > 0 ? value : null
      return _cachedLocalApiToken
    })
    .finally(() => {
      _localApiTokenPromise = null
    })

  return _localApiTokenPromise
}

export async function getPortableSetting(key: string): Promise<string | null> {
  if (!isTauri) return null
  try {
    const value = await getTauriInvoke()('portable_setting_get', { key })
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

export async function savePortableSetting(key: string, value: string): Promise<void> {
  if (!isTauri) return
  await getTauriInvoke()('portable_setting_set', { key, value })
}

export async function deletePortableSetting(key: string): Promise<void> {
  if (!isTauri) return
  await getTauriInvoke()('portable_setting_delete', { key })
}

export async function hasPortableSecret(key: string): Promise<boolean> {
  if (!isTauri) return false
  return Boolean(await getTauriInvoke()('portable_secret_exists', { key }))
}

export async function savePortableSecret(key: string, value: string): Promise<void> {
  if (!isTauri) return
  await getTauriInvoke()('portable_secret_set', { key, value })
}

export async function deletePortableSecret(key: string): Promise<void> {
  if (!isTauri) return
  await getTauriInvoke()('portable_secret_delete', { key })
}

export async function getPortableDiskSpace(): Promise<PortableDiskSpace | null> {
  if (!isTauri) return null
  const value = await getTauriInvoke()('get_portable_disk_space')
  if (!value || typeof value !== 'object') return null
  return value as PortableDiskSpace
}

/**
 * Persist preferred port to Tauri Store (JS instance only).
 * Must not go through the Rust app.store() to avoid cache divergence.
 */
export async function savePreferredPort(port: number): Promise<void> {
  if (port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535')
  await savePortableSetting('preferred_port', String(port))
}

/**
 * Get backend baseUrl
 * - Tauri mode: read port from store, default 62601
 * - Web mode: empty string (uses Vite proxy)
 */
export async function getBackendBaseUrl(): Promise<string> {
  if (!isTauri) return ''
  if (_cachedBaseUrl !== null) return _cachedBaseUrl

  try {
    const port = await getPortableSetting('preferred_port') || '62601'
    _cachedBaseUrl = `http://localhost:${port}`
  } catch {
    _cachedBaseUrl = 'http://localhost:62601'
  }
  return _cachedBaseUrl
}

/**
 * Fetch a sidecar /api path and attach the per-app token when Tauri supplied
 * one. Accepting only absolute-path /api URLs prevents accidental credential
 * forwarding to cloud or attacker-controlled origins.
 */
export async function sidecarFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (!path.startsWith('/api/') || path.startsWith('//')) {
    throw new Error('sidecarFetch only accepts local /api paths')
  }

  const [base, token] = await Promise.all([getBackendBaseUrl(), getLocalApiToken()])
  const headers = new Headers(options.headers)
  if (token) headers.set(LOCAL_API_TOKEN_HEADER, token)

  return fetch(`${base}${path}`, {
    ...options,
    headers,
  })
}

function buildSidecarUrl(path: string): URL {
  if (typeof window === 'undefined') {
    return new URL(path, 'http://localhost')
  }

  const base = isTauri
    ? (_cachedBaseUrl || 'http://localhost:62601')
    : window.location.origin
  return new URL(path, base)
}

async function issueRealtimeTicket(transport: 'websocket' | 'event-source'): Promise<string | null> {
  const token = await getLocalApiToken()
  if (!token) return null

  const response = await sidecarFetch(LOCAL_API_TICKET_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transport }),
  })
  if (!response.ok) {
    throw new Error(`Failed to authorize realtime connection: ${response.status}`)
  }
  const body = await response.json() as { ticket?: unknown }
  if (typeof body.ticket !== 'string' || !body.ticket) {
    throw new Error('Sidecar returned an invalid realtime ticket')
  }
  return body.ticket
}

async function buildAuthenticatedRealtimeUrl(
  path: string,
  transport: 'websocket' | 'event-source',
): Promise<URL> {
  const expectedPath = transport === 'websocket' ? '/api/ws' : '/api/logs/stream'
  if (path !== expectedPath) {
    throw new Error(`Unsupported local realtime path: ${path}`)
  }

  await getBackendBaseUrl()
  const [url, ticket] = await Promise.all([
    Promise.resolve(buildSidecarUrl(path)),
    issueRealtimeTicket(transport),
  ])
  if (ticket) url.searchParams.set(LOCAL_API_TICKET_QUERY, ticket)
  return url
}

/**
 * Browser WebSocket/EventSource APIs cannot attach the custom auth header.
 * Exchange the long-lived in-memory token for a 30-second, scoped, one-use
 * ticket. It briefly appears in the loopback request URL, but cannot be
 * replayed and is never stored in navigation history or application logs.
 */
export async function getAuthenticatedWebSocketUrl(path = '/api/ws'): Promise<string> {
  const url = await buildAuthenticatedRealtimeUrl(path, 'websocket')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export async function getAuthenticatedEventSourceUrl(path = '/api/logs/stream'): Promise<string> {
  return (await buildAuthenticatedRealtimeUrl(path, 'event-source')).toString()
}

export async function pollReadiness(
  probe: () => Promise<ReadinessProbeResult>,
  options: ReadinessPollOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? SIDECAR_STARTUP_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? SIDECAR_READINESS_POLL_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + Math.max(0, timeoutMs)

  while (true) {
    let result: ReadinessProbeResult = 'pending'
    try {
      result = await probe()
    } catch {
      // A transient IPC or fetch failure means the sidecar is not ready yet.
    }
    if (result === 'ready') return true
    if (result === 'failed') return false

    const remaining = deadline - now()
    if (remaining <= 0) return false
    await sleep(Math.min(Math.max(1, intervalMs), remaining))
  }
}

export async function getSidecarStatus(): Promise<SidecarStatus | null> {
  if (!isTauri) return null
  try {
    const value = await getTauriInvoke()('get_sidecar_status')
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<SidecarStatus>
    if (typeof candidate.status !== 'string' || typeof candidate.message !== 'string') return null
    return candidate as SidecarStatus
  } catch {
    return null
  }
}

async function probeBackendReadiness(): Promise<ReadinessProbeResult> {
  const status = await getSidecarStatus()
  if (status && ['error', 'terminated', 'port-conflict'].includes(status.status)) {
    return 'failed'
  }

  try {
    const res = await fetch(`${_cachedBaseUrl}/api/health`, {
      signal: AbortSignal.timeout(SIDECAR_HEALTH_REQUEST_TIMEOUT_MS),
    })
    if (res.ok && (!status || status.status === 'ready')) return 'ready'
  } catch {
    // The health endpoint is still starting.
  }
  return 'pending'
}

export async function waitForBackendReady(timeoutMs = SIDECAR_STARTUP_TIMEOUT_MS): Promise<boolean> {
  if (!isTauri) return true
  await getBackendBaseUrl()
  return pollReadiness(probeBackendReadiness, { timeoutMs })
}

/**
 * Open a URL in the system default browser.
 * Tauri mode: uses @tauri-apps/plugin-opener
 * Web mode: falls back to window.open
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** Called once at app startup, polls backend health until ready before rendering */
export async function initBaseUrl(): Promise<boolean> {
  if (!isTauri) return true

  try {
    // Resolve and cache both pieces before any protected API request. In dev,
    // the Rust command returns null because the Bun server is not its child.
    await Promise.all([getBackendBaseUrl(), getLocalApiToken()])
  } catch {
    return false
  }

  return waitForBackendReady()
}
