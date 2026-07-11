// [XJC] DNS-safe HTTP GET transport for untrusted remote URLs.
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { checkServerIdentity } from 'node:tls'

export interface ResolvedRemoteAddress {
  address: string
  family: 4 | 6
}

export type RemoteHeaderInput = ConstructorParameters<typeof Headers>[0]

export type RemoteLookupFn = (hostname: string) => Promise<ResolvedRemoteAddress[]>
export type PinnedRequestFn = (
  url: URL,
  target: ResolvedRemoteAddress,
  signal: AbortSignal,
  headers?: RemoteHeaderInput,
) => Promise<Response>

export interface PinnedHttpGetOptions {
  signal: AbortSignal
  validateUrl: (rawUrl: string) => URL
  validateAddress: (address: string) => void
  lookupFn?: RemoteLookupFn
  requestFn?: PinnedRequestFn
  maxRedirects?: number
  headers?: RemoteHeaderInput
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_MAX_REDIRECTS = 3

export async function defaultRemoteLookup(hostname: string): Promise<ResolvedRemoteAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records
    .filter((record): record is { address: string; family: 4 | 6 } =>
      record.family === 4 || record.family === 6)
    .map((record) => ({ address: record.address, family: record.family }))
}

/**
 * Resolve all A/AAAA results, reject the entire hostname if any result is not
 * public, and return a de-duplicated set that can be pinned for connection.
 */
export async function resolveValidatedRemoteAddresses(
  url: URL,
  options: Pick<PinnedHttpGetOptions, 'signal' | 'validateAddress' | 'lookupFn'>,
): Promise<ResolvedRemoteAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  const literalFamily = isIP(hostname)
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await withAbort(
        (options.lookupFn ?? defaultRemoteLookup)(hostname),
        options.signal,
      )

  if (records.length === 0) {
    throw new Error(`远程主机 DNS 未返回 A/AAAA 地址：${hostname}`)
  }

  const unique = new Map<string, ResolvedRemoteAddress>()
  for (const record of records) {
    if ((record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family) {
      throw new Error(`远程主机 DNS 返回了无效地址：${hostname}`)
    }
    // Fail closed on mixed public/private answers. Checking only the selected
    // address would leave alternate A/AAAA rebinding paths available.
    options.validateAddress(record.address)
    unique.set(`${record.family}:${record.address}`, record)
  }
  return [...unique.values()]
}

/**
 * GET an untrusted URL through an IP-pinned socket. The original hostname is
 * retained for HTTP Host, TLS SNI, and certificate verification. Redirects are
 * resolved and validated from scratch before the next connection.
 */
export async function pinnedHttpGet(
  rawUrl: string,
  options: PinnedHttpGetOptions,
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error('安全远程请求：maxRedirects 必须是 0-10 的整数')
  }

  const requestFn = options.requestFn ?? requestPinnedAddress
  let current = options.validateUrl(rawUrl)
  let currentHeaders = sanitizeRequestHeaders(options.headers)

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (options.signal.aborted) throw options.signal.reason
    const addresses = await resolveValidatedRemoteAddresses(current, options)
    const response = await requestFirstReachable(
      current,
      addresses,
      options.signal,
      requestFn,
      currentHeaders,
    )

    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    await response.body?.cancel().catch(() => {})
    if (redirectCount >= maxRedirects) {
      throw new Error(`远程请求重定向次数超过上限 ${maxRedirects}`)
    }

    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new Error('远程请求返回了无效的重定向地址')
    }
    // The next loop performs a fresh full DNS lookup and pins that exact answer.
    const validatedNext = options.validateUrl(next.href)
    if (validatedNext.origin !== current.origin) {
      currentHeaders = stripSensitiveRedirectHeaders(currentHeaders)
    }
    current = validatedNext
  }
}

async function requestFirstReachable(
  url: URL,
  addresses: ResolvedRemoteAddress[],
  signal: AbortSignal,
  requestFn: PinnedRequestFn,
  headers: Headers,
): Promise<Response> {
  let lastError: unknown = null
  for (const address of addresses) {
    if (signal.aborted) throw signal.reason
    try {
      return await requestFn(url, address, signal, headers)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('远程主机没有可连接的公网地址')
}

export function requestPinnedAddress(
  url: URL,
  target: ResolvedRemoteAddress,
  signal: AbortSignal,
  requestHeaders?: RemoteHeaderInput,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const isHttps = url.protocol === 'https:'
    const originalHostname = url.hostname.replace(/^\[|\]$/g, '')
    const headers = sanitizeRequestHeaders(requestHeaders)
    headers.set('Host', url.host)
    if (!headers.has('Accept')) headers.set('Accept', '*/*')
    if (!headers.has('User-Agent')) headers.set('User-Agent', 'XiaoJuClaw-SafeFetch/1.0')
    const request = (isHttps ? requestHttps : requestHttp)({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      ...(isHttps
        ? {
            servername: isIP(originalHostname) ? undefined : originalHostname,
            checkServerIdentity: (_hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) =>
              checkServerIdentity(originalHostname, certificate),
          }
        : {}),
    })

    const onAbort = () => {
      request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Request aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    request.once('response', (incoming) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item)
        } else if (value !== undefined) {
          headers.set(name, String(value))
        }
      }

      const status = incoming.statusCode ?? 502
      const body = status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
      incoming.once('close', () => signal.removeEventListener('abort', onAbort))
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers,
      }))
    })
    request.once('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    request.end()
  })
}

function sanitizeRequestHeaders(input?: RemoteHeaderInput): Headers {
  const headers = new Headers(input)
  for (const name of ['host', 'connection', 'transfer-encoding', 'content-length']) {
    headers.delete(name)
  }
  return headers
}

function stripSensitiveRedirectHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'rdxtoken', 'x-api-key']) {
    headers.delete(name)
  }
  return headers
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
