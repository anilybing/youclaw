import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { downloadRemoteImageToTemp } from '../src/openclaw-plugins/openclaw-weixin/src/cdn/upload.ts'

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
      expect(init?.redirect).toBe('error')
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    }) as typeof fetch

    await expect(
      downloadRemoteImageToTemp('https://public.example/image.png', resolve(tmpdir(), 'unused'), {
        fetchFn,
      }),
    ).rejects.toThrow(/302/)
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
      expect(init?.redirect).toBe('error')
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
})
