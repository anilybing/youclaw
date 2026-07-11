import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { downloadRemoteImageToTemp } from '../src/openclaw-plugins/openclaw-weixin/src/cdn/upload.ts'
import { safeWeixinRemoteRequest } from '../src/openclaw-plugins/openclaw-weixin/src/security/remote-fetch.ts'

function streamResponse(
  chunks: Uint8Array[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }),
    init,
  )
}

describe('Weixin remote media download security', () => {
  test('rejects private, metadata and non-http URLs before fetch', async () => {
    const fetchFn = mock(async () => streamResponse([new Uint8Array([1])])) as typeof fetch
    const unsafeUrls = [
      'http://127.0.0.1/image.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/image.png',
      'http://metadata.google.internal/computeMetadata/v1/',
      'file:///etc/passwd',
      'data:image/png;base64,AA==',
    ]

    for (const url of unsafeUrls) {
      await expect(
        downloadRemoteImageToTemp(url, resolve(tmpdir(), 'unused'), { fetchFn }),
      ).rejects.toThrow()
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('does not follow a 302 redirect to the metadata service', async () => {
    const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    }) as typeof fetch

    await expect(
      downloadRemoteImageToTemp('https://public.example/image.png', resolve(tmpdir(), 'unused'), {
        fetchFn,
      }),
    ).rejects.toThrow(/private|reserved/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  test('aborts an oversized streaming response without writing a file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'xjc-weixin-media-'))
    const fetchFn = mock(async () =>
      streamResponse([new Uint8Array(6), new Uint8Array(6)], {
        headers: { 'content-type': 'image/png' },
      }),
    ) as typeof fetch
    try {
      await expect(
        downloadRemoteImageToTemp('https://public.example/image.png', dir, {
          maxBytes: 10,
          fetchFn,
        }),
      ).rejects.toThrow(/exceeds/)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('downloads a bounded response and supplies timeout plus redirect controls', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'xjc-weixin-media-'))
    const fetchFn = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return streamResponse([new Uint8Array([1, 2, 3])], {
        headers: { 'content-type': 'image/png' },
      })
    }) as typeof fetch
    try {
      const filePath = await downloadRemoteImageToTemp('https://public.example/image.png', dir, {
        maxBytes: 10,
        timeoutMs: 1_000,
        fetchFn,
      })
      expect(filePath.endsWith('.png')).toBe(true)
      expect(Array.from(readFileSync(filePath))).toEqual([1, 2, 3])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects mixed public/private DNS before opening a Weixin media socket', async () => {
    const requestFn = mock(async () =>
      streamResponse([new Uint8Array([1])], { headers: { 'content-type': 'image/png' } }),
    )
    await expect(downloadRemoteImageToTemp(
      'https://mixed.example/image.png',
      resolve(tmpdir(), 'unused'),
      {
        lookupFn: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.8', family: 4 },
        ],
        requestFn,
      },
    )).rejects.toThrow(/private|reserved/)
    expect(requestFn).not.toHaveBeenCalled()
  })

  test('pins the Weixin media request to the validated public address', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'xjc-weixin-media-'))
    const targets: string[] = []
    try {
      const filePath = await downloadRemoteImageToTemp(
        'https://cdn.example/image.png',
        dir,
        {
          maxBytes: 10,
          lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
          requestFn: async (url, target) => {
            targets.push(`${url.hostname}=>${target.address}`)
            return streamResponse(
              [new Uint8Array([1, 2, 3])],
              { headers: { 'content-type': 'image/png' } },
            )
          },
        },
      )
      expect(targets).toEqual(['cdn.example=>93.184.216.34'])
      expect(Array.from(readFileSync(filePath))).toEqual([1, 2, 3])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pins an encrypted CDN POST and preserves its method and body', async () => {
    const payload = new Uint8Array([7, 8, 9])
    const seen: Array<{ address: string; method: string; body: number[] }> = []
    const response = await safeWeixinRemoteRequest('https://cdn.example/upload', {
      signal: new AbortController().signal,
      method: 'POST',
      body: payload,
      maxRedirects: 0,
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      requestFn: async (_url, target, _signal, init) => {
        seen.push({
          address: target.address,
          method: init?.method ?? '',
          body: Array.from(init?.body ?? []),
        })
        return new Response(null, { status: 200 })
      },
    })
    expect(response.status).toBe(200)
    expect(seen).toEqual([{
      address: '93.184.216.34',
      method: 'POST',
      body: [7, 8, 9],
    }])
  })
})
