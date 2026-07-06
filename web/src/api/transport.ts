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

// Cache backend baseUrl to avoid repeated store reads
let _cachedBaseUrl: string | null = null

export function updateCachedBaseUrl(url: string): void {
  _cachedBaseUrl = url
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

export async function getPortableSecret(key: string): Promise<string | null> {
  if (!isTauri) return null
  const value = await getTauriInvoke()('portable_secret_get', { key })
  return typeof value === 'string' ? value : null
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
 * Get baseUrl synchronously (for EventSource and other non-async scenarios)
 * Must call initBaseUrl() first
 */
export function getBaseUrlSync(): string {
  if (!isTauri) return ''
  return _cachedBaseUrl ?? 'http://localhost:62601'
}

export function getWebSocketUrlSync(path = '/api/ws'): string {
  if (typeof window === 'undefined') return path

  const base = isTauri
    ? (getBaseUrlSync() || 'http://localhost:62601')
    : window.location.origin

  const url = new URL(path, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
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

  // Quick-read port from store first
  await getBackendBaseUrl()

  // Poll backend health endpoint directly — no Rust IPC middleman
  const maxWait = 30000
  const interval = 300
  for (let elapsed = 0; elapsed < maxWait; elapsed += interval) {
    try {
      const res = await fetch(`${_cachedBaseUrl}/api/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) return true
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, interval))
  }
  return false
}
