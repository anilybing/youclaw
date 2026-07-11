// @ts-nocheck
// [XJC-PATCH] standalone DNS-safe remote fetch for the bundled Weixin plugin.
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { checkServerIdentity } from 'node:tls'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3

export function assertSafeWeixinRemoteUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid remote media URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Remote media URL must use http or https')
  }
  if (url.username || url.password) {
    throw new Error('Remote media URL must not include credentials')
  }

  const hostname = normalizeHost(url.hostname)
  if (!hostname) throw new Error('Remote media URL has no hostname')
  if (isIP(hostname)) {
    assertPublicAddress(hostname)
  } else if (
    !hostname.includes('.')
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home')
    || hostname.endsWith('.corp')
    || hostname === 'metadata.google.internal'
  ) {
    throw new Error('Remote media URL points to a local or internal host')
  }
  return url
}

export async function safeWeixinRemoteRequest(
  rawUrl: string,
  options: {
    signal: AbortSignal
    fetchFn?: typeof fetch
    lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
    requestFn?: (
      url: URL,
      address: { address: string; family: 4 | 6 },
      signal: AbortSignal,
      init?: { method: string; headers: Headers; body?: Uint8Array },
    ) => Promise<Response>
    method?: string
    headers?: HeadersInit
    body?: Uint8Array
    maxRedirects?: number
  },
): Promise<Response> {
  const requestInit = {
    method: options.method ?? "GET",
    headers: new Headers(options.headers),
    body: options.body,
  };
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  if (options.fetchFn) {
    return fetchInjected(rawUrl, options.fetchFn, options.signal, requestInit, maxRedirects)
  }

  let current = assertSafeWeixinRemoteUrl(rawUrl)
  for (let redirectCount = 0; ; redirectCount += 1) {
    const addresses = await resolveAllPublic(current, options)
    let response: Response | null = null
    let lastError: unknown = null
    for (const address of addresses) {
      try {
        response = await (options.requestFn ?? requestPinned)(current, address, options.signal, requestInit)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!response) throw lastError ?? new Error('No reachable public address')
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    await response.body?.cancel().catch(() => {})
    if (redirectCount >= maxRedirects) throw new Error('Too many remote media redirects')
    const next = assertSafeWeixinRemoteUrl(new URL(location, current).href)
    if (next.origin !== current.origin) {
      for (const name of ["authorization", "cookie", "x-api-key"]) requestInit.headers.delete(name)
    }
    current = next
  }
}

async function fetchInjected(
  rawUrl: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
  init: { method: string; headers: Headers; body?: Uint8Array },
  maxRedirects: number,
): Promise<Response> {
  let current = assertSafeWeixinRemoteUrl(rawUrl)
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetchFn(current.href, {
      signal,
      redirect: 'manual',
      method: init.method,
      headers: init.headers,
      body: init.body,
    })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    await response.body?.cancel().catch(() => {})
    if (redirectCount >= maxRedirects) throw new Error('Too many remote media redirects')
    const next = assertSafeWeixinRemoteUrl(new URL(location, current).href)
    if (next.origin !== current.origin) {
      for (const name of ["authorization", "cookie", "x-api-key"]) init.headers.delete(name)
    }
    current = next
  }
}

async function resolveAllPublic(
  url: URL,
  options: {
    signal: AbortSignal
    lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
  },
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const hostname = normalizeHost(url.hostname)
  const family = isIP(hostname)
  const lookupFn = options.lookupFn ?? (async (host: string) =>
    dnsLookup(host, { all: true, verbatim: true }))
  const records = family
    ? [{ address: hostname, family }]
    : await withAbort(lookupFn(hostname), options.signal)
  if (!records.length) throw new Error('Remote host DNS returned no A/AAAA address')

  const unique = new Map()
  for (const record of records) {
    if ((record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family) {
      throw new Error('Remote host DNS returned an invalid address')
    }
    // Reject the hostname as a whole if even one A/AAAA answer is private.
    assertPublicAddress(record.address)
    unique.set(`${record.family}:${record.address}`, record)
  }
  return [...unique.values()]
}

function requestPinned(
  url: URL,
  target: { address: string; family: 4 | 6 },
  signal: AbortSignal,
  init: { method: string; headers: Headers; body?: Uint8Array } = {
    method: "GET",
    headers: new Headers(),
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const isHttps = url.protocol === 'https:'
    const originalHostname = normalizeHost(url.hostname)
    const headers = new Headers(init.headers);
    for (const name of ["host", "connection", "transfer-encoding", "content-length"]) {
      headers.delete(name);
    }
    headers.set("Host", url.host);
    if (!headers.has("Accept")) headers.set("Accept", "*/*");
    if (!headers.has("User-Agent")) headers.set("User-Agent", "XiaoJuClaw-Weixin-SafeFetch/1.0");
    if (init.body) headers.set("Content-Length", String(init.body.byteLength));
    const request = (isHttps ? requestHttps : requestHttp)({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      method: init.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      ...(isHttps
        ? {
            servername: isIP(originalHostname) ? undefined : originalHostname,
            checkServerIdentity: (_hostname, certificate) =>
              checkServerIdentity(originalHostname, certificate),
          }
        : {}),
    })

    const onAbort = () => request.destroy(
      signal.reason instanceof Error ? signal.reason : new Error('Request aborted'),
    )
    signal.addEventListener('abort', onAbort, { once: true })
    request.once('response', (incoming) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
        else if (value !== undefined) headers.set(name, String(value))
      }
      const status = incoming.statusCode ?? 502
      const body = status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming)
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
    request.end(init.body)
  })
}

function assertPublicAddress(rawAddress: string): void {
  const address = normalizeHost(rawAddress)
  const family = isIP(address)
  if (family === 4) {
    const parts = address.split('.').map(Number)
    const [a, b] = parts
    const blocked = a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51)
      || (a === 203 && b === 0)
      || a >= 224
    if (blocked) throw new Error('Remote host resolved to a private or reserved address')
    return
  }
  if (family === 6) {
    const groups = expandIpv6(address)
    const first = groups[0]
    const second = groups[1]
    const embedded = extractEmbeddedIpv4(groups)
    if (embedded) {
      assertPublicAddress(embedded.join('.'))
      return
    }
    const allZeroPrefix = groups.slice(0, 6).every((value) => value === 0)
    if (
      allZeroPrefix
      || (first & 0xfe00) === 0xfc00
      || (first & 0xfe00) === 0xfe00
      || (first & 0xff00) === 0xff00
    ) {
      throw new Error('Remote host resolved to a private or reserved address')
    }
    if (first === 0x2002) {
      assertPublicAddress([
        (second >> 8) & 0xff,
        second & 0xff,
        (groups[2] >> 8) & 0xff,
        groups[2] & 0xff,
      ].join('.'))
      return
    }
    if (
      (first & 0xe000) !== 0x2000
      || (first === 0x2001 && second === 0x0000)
      || (first === 0x2001 && second === 0x0002)
      || (first === 0x2001 && second === 0x0db8)
      || (first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020))
      || (first === 0x3fff && (second & 0xf000) === 0)
    ) {
      throw new Error('Remote host resolved to a private or reserved address')
    }
    return
  }
  throw new Error('Remote host DNS returned an invalid address')
}

function extractEmbeddedIpv4(groups: number[]): number[] | null {
  const mapped = groups.slice(0, 5).every((value) => value === 0) && groups[5] === 0xffff
  const translated = groups.slice(0, 4).every((value) => value === 0)
    && groups[4] === 0xffff
    && groups[5] === 0
  const nat64 = groups[0] === 0x0064
    && groups[1] === 0xff9b
    && groups.slice(2, 6).every((value) => value === 0)
  if (!mapped && !translated && !nat64) return null
  return [(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff]
}

function expandIpv6(rawAddress: string): number[] {
  const address = rawAddress.split('%')[0]
  const [leftRaw, rightRaw = ''] = address.split('::')
  const parseSide = (side: string): number[] => {
    if (!side) return []
    const output: number[] = []
    for (const part of side.split(':')) {
      if (part.includes('.')) {
        const octets = part.split('.').map(Number)
        output.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      } else {
        output.push(parseInt(part, 16))
      }
    }
    return output
  }
  const left = parseSide(leftRaw)
  const right = parseSide(rightRaw)
  return address.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right]
    : left
}

function normalizeHost(hostname: string): string {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
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
