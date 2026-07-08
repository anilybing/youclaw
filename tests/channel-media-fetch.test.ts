import { describe, test, expect, mock } from 'bun:test'
import {
  assertSafeRemoteUrl,
  fetchRemoteMediaToBuffer,
  inferMediaFileNameFromUrl,
} from '../src/channel/media-fetch.ts'

// ---------------------------------------------------------------------------
// assertSafeRemoteUrl — SSRF guard
// ---------------------------------------------------------------------------

describe('assertSafeRemoteUrl', () => {
  const ALLOWED = [
    'https://example.com/a.png',
    'http://example.com/a.png',
    'https://sub.domain.example.com/files/report.pdf?sig=abc',
    'http://8.8.8.8/x',
    'https://93.184.216.34/x',
    'http://172.15.0.1/x', // just below 172.16/12
    'http://172.32.0.1/x', // just above 172.16/12
    'http://[2001:4860:4860::8888]/x', // public IPv6
    'http://[::ffff:8.8.8.8]/x', // public IPv4-mapped
    'http://[64:ff9b::8.8.8.8]/x', // NAT64 wrapping a public IPv4
  ]

  const BLOCKED = [
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://127.0.0.2:9000/', 'loopback range'],
    ['http://10.1.2.3/', '10/8'],
    ['http://172.16.0.1/', '172.16/12 low'],
    ['http://172.31.255.254/', '172.16/12 high'],
    ['http://192.168.1.1/', '192.168/16'],
    ['http://100.64.0.1/', 'CGNAT 100.64/10'],
    ['http://0.0.0.0/', '0/8'],
    ['http://255.255.255.255/', 'broadcast'],
    ['http://224.0.0.1/', 'multicast'],
    ['http://localhost/', 'localhost'],
    ['http://foo.localhost/', '*.localhost'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fc00::1]/', 'IPv6 ULA fc00'],
    ['http://[fd12:3456:789a::1]/', 'IPv6 ULA fd'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped metadata'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[::ffff:0:169.254.169.254]/', 'IPv4-translated metadata'],
    ['http://[64:ff9b::169.254.169.254]/', 'NAT64-embedded metadata'],
    ['http://[64:ff9b::10.0.0.1]/', 'NAT64-embedded private'],
    ['http://2852039166/', 'decimal-encoded metadata (169.254.169.254)'],
    ['http://0x7f000001/', 'hex-encoded loopback (127.0.0.1)'],
  ] as const

  const NON_HTTP = [
    'ftp://example.com/a.zip',
    'file:///etc/passwd',
    'gopher://example.com/',
    'data:text/plain;base64,AAAA',
  ]

  for (const url of ALLOWED) {
    test(`allows public URL: ${url}`, () => {
      expect(() => assertSafeRemoteUrl(url)).not.toThrow()
      expect(assertSafeRemoteUrl(url)).toBeInstanceOf(URL)
    })
  }

  for (const [url, label] of BLOCKED) {
    test(`blocks ${label}: ${url}`, () => {
      expect(() => assertSafeRemoteUrl(url)).toThrow()
    })
  }

  for (const url of NON_HTTP) {
    test(`rejects non-http(s) protocol: ${url}`, () => {
      expect(() => assertSafeRemoteUrl(url)).toThrow('协议')
    })
  }

  test('rejects a malformed URL', () => {
    expect(() => assertSafeRemoteUrl('not a url')).toThrow('无效的媒体 URL')
  })

  test('metadata rejection carries a Chinese, non-leaking message', () => {
    expect(() => assertSafeRemoteUrl('http://169.254.169.254/latest/meta-data/')).toThrow('内网/保留地址')
  })
})

// ---------------------------------------------------------------------------
// inferMediaFileNameFromUrl
// ---------------------------------------------------------------------------

describe('inferMediaFileNameFromUrl', () => {
  test('decodes percent-encoded file name from the path', () => {
    expect(inferMediaFileNameFromUrl('https://example.com/files/%E6%8A%A5%E5%91%8A.pdf?x=1')).toBe('报告.pdf')
  })

  test('falls back to a generated name when the path has no basename', () => {
    expect(inferMediaFileNameFromUrl('https://example.com/')).toMatch(/^media-\d+$/)
  })
})

// ---------------------------------------------------------------------------
// fetchRemoteMediaToBuffer — download with size cap + timeout
// ---------------------------------------------------------------------------

/** Minimal Response-like object so tests fully control headers/body (Bun's Response auto-sets content-length). */
function makeResponse(opts: {
  ok?: boolean
  status?: number
  contentLength?: string | null
  chunks?: Uint8Array[]
  noBody?: boolean
}): Response {
  const { ok = true, status = 200, contentLength = null, chunks = [], noBody = false } = opts
  const headerMap = new Map<string, string>()
  if (contentLength !== null) headerMap.set('content-length', contentLength)

  const body = noBody
    ? null
    : new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c)
          controller.close()
        },
        cancel() {},
      })

  return {
    ok,
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    body,
    arrayBuffer: async () => {
      const total = chunks.reduce((a, c) => a + c.byteLength, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        out.set(c, offset)
        offset += c.byteLength
      }
      return out.buffer
    },
  } as unknown as Response
}

describe('fetchRemoteMediaToBuffer', () => {
  test('downloads within the size cap and returns buffer + inferred file name', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => makeResponse({ chunks: [bytes] })) as any

    const res = await fetchRemoteMediaToBuffer('https://example.com/files/pic.png', {
      maxBytes: 1024,
      fetchFn,
    })

    expect(res.buffer).toBeInstanceOf(Buffer)
    expect(Array.from(res.buffer)).toEqual([1, 2, 3, 4, 5])
    expect(res.fileName).toBe('pic.png')
  })

  test('calls fetch with the safe URL, an abort signal and redirect:error', async () => {
    const fetchFn = mock(async (_url: string, _init?: RequestInit) => makeResponse({ chunks: [new Uint8Array([9])] })) as any
    await fetchRemoteMediaToBuffer('https://example.com/a.bin', { maxBytes: 1024, fetchFn })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, any]
    expect(url).toBe('https://example.com/a.bin')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('rejects an unsafe URL before making any request', async () => {
    const fetchFn = mock(async () => makeResponse({ chunks: [new Uint8Array([1])] })) as any
    await expect(
      fetchRemoteMediaToBuffer('http://169.254.169.254/latest/meta-data/', { maxBytes: 1024, fetchFn }),
    ).rejects.toThrow('内网/保留地址')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('rejects when content-length header already exceeds the cap', async () => {
    const fetchFn = mock(async () => makeResponse({ contentLength: '999999', chunks: [new Uint8Array(10)] })) as any
    await expect(
      fetchRemoteMediaToBuffer('https://example.com/big.bin', { maxBytes: 100, fetchFn }),
    ).rejects.toThrow('超过上限')
  })

  test('aborts mid-stream when accumulated bytes exceed the cap (no content-length)', async () => {
    const fetchFn = mock(async () =>
      makeResponse({ chunks: [new Uint8Array(60), new Uint8Array(60)] }),
    ) as any
    await expect(
      fetchRemoteMediaToBuffer('https://example.com/stream.bin', { maxBytes: 100, fetchFn }),
    ).rejects.toThrow('超过上限')
  })

  test('rejects on non-ok HTTP status', async () => {
    const fetchFn = mock(async () => makeResponse({ ok: false, status: 404, noBody: true })) as any
    await expect(
      fetchRemoteMediaToBuffer('https://example.com/missing.png', { maxBytes: 1024, fetchFn }),
    ).rejects.toThrow('HTTP 404')
  })

  test('maps an abort/timeout (TimeoutError) to a clear Chinese timeout error', async () => {
    // Real fetch aborts via the passed AbortSignal.timeout; here we synthesize the same
    // TimeoutError the runtime would surface, so the test stays fast and deterministic.
    const fetchFn = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    }) as any
    await expect(
      fetchRemoteMediaToBuffer('https://example.com/slow.bin', { maxBytes: 1024, timeoutMs: 20, fetchFn }),
    ).rejects.toThrow('超时')
  })

  test('maps a mid-stream abort to the timeout error', async () => {
    const fetchFn = mock(async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream<Uint8Array>({
          pull() {
            throw new DOMException('aborted', 'AbortError')
          },
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response,
    ) as any
    await expect(
      fetchRemoteMediaToBuffer('https://example.com/slow.bin', { maxBytes: 1024, timeoutMs: 20, fetchFn }),
    ).rejects.toThrow('超时')
  })

  test('rejects a non-positive maxBytes', async () => {
    const fetchFn = mock(async () => makeResponse({ chunks: [] })) as any
    await expect(
      fetchRemoteMediaToBuffer('https://example.com/a.bin', { maxBytes: 0, fetchFn }),
    ).rejects.toThrow('maxBytes')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
