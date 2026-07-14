// [XJC] 漫剧 M2·live 视频 provider 单测（HTTP 层全 mock，不联网不花钱）：
// submit→poll(Succeed)→下载 落 per-run 目录；失败/未配置/取消 分支。验证真调用体逻辑，真样片留给 green-light 后。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { OpenAiCompatibleVideoProvider } from '../src/media/video-provider.ts'

const OUT = resolve(process.env.DATA_DIR as string, 'live-provider-test')

const savedKey = process.env.SILICONFLOW_API_KEY
const savedBase = process.env.SILICONFLOW_BASE_URL
const savedFetch = globalThis.fetch

function setLiveEnv() {
  process.env.SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
  process.env.SILICONFLOW_API_KEY = 'sk-test-not-real'
  process.env.XJC_VIDEO_POLL_MS = '5'
}

function clearLiveEnv() {
  delete process.env.SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_BASE_URL
}

/** 假 HTTP：submit→requestId、status→Succeed(可配 Failed)、产物 URL→mp4 字节。全程不出网。 */
function makeFakeFetch(opts?: { status?: 'Succeed' | 'Failed'; onSubmit?: () => void }) {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/video/submit')) {
      opts?.onSubmit?.()
      return new Response(JSON.stringify({ requestId: 'req-1' }), { status: 200 })
    }
    if (url.endsWith('/video/status')) {
      if (opts?.status === 'Failed') return new Response(JSON.stringify({ status: 'Failed', reason: '内容审核未通过' }), { status: 200 })
      return new Response(JSON.stringify({ status: 'Succeed', results: { videos: [{ url: 'https://media.example.test/out.mp4' }] } }), { status: 200 })
    }
    if (url.includes('media.example.test')) {
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }
    return new Response('nf', { status: 404 })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = savedFetch
  delete process.env.XJC_VIDEO_POLL_MS
  if (savedKey === undefined) delete process.env.SILICONFLOW_API_KEY
  else process.env.SILICONFLOW_API_KEY = savedKey
  if (savedBase === undefined) delete process.env.SILICONFLOW_BASE_URL
  else process.env.SILICONFLOW_BASE_URL = savedBase
})

describe('OpenAiCompatibleVideoProvider live（HTTP 全 mock，不花钱）', () => {
  test('submit → poll(Succeed) → 下载落 per-run 目录 + 真实成本口径', async () => {
    setLiveEnv()
    let submits = 0
    const fake = makeFakeFetch({ onSubmit: () => { submits++ } })
    globalThis.fetch = fake
    const provider = new OpenAiCompatibleVideoProvider('wan', 'draft')
    expect(provider.isConfigured()).toBe(true)
    const res = await provider.generate(
      { prompt: '推镜特写', aspectRatio: '9:16' },
      { runId: 'run-live', shotId: 'S1', tier: 'draft', outputDir: OUT, artifactFetchFn: fake },
    )
    expect(submits).toBe(1)
    expect(res.dryRun).toBe(false)
    expect(res.providerId).toBe('wan')
    expect(res.model).toBe('Wan-AI/Wan2.2-I2V-A14B')
    expect(res.costCny).toBe(2)
    expect(res.costUsd).toBeCloseTo(0.29, 5)
    expect(existsSync(res.filePath)).toBe(true)
  }, 20_000)

  test('status=Failed → 抛错', async () => {
    setLiveEnv()
    const fake = makeFakeFetch({ status: 'Failed' })
    globalThis.fetch = fake
    const provider = new OpenAiCompatibleVideoProvider('wan', 'draft')
    await expect(
      provider.generate({ prompt: 'p' }, { runId: 'run-live', shotId: 'S2', tier: 'draft', outputDir: OUT, artifactFetchFn: fake }),
    ).rejects.toThrow(/失败|审核/)
  }, 20_000)

  test('未配置 → 抛错且不发提交请求', async () => {
    clearLiveEnv()
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('nf', { status: 404 }) }) as typeof fetch
    const provider = new OpenAiCompatibleVideoProvider('wan', 'draft')
    expect(provider.isConfigured()).toBe(false)
    await expect(
      provider.generate({ prompt: 'p' }, { runId: 'r', shotId: 'S', tier: 'draft', outputDir: OUT }),
    ).rejects.toThrow(/未配置/)
    expect(called).toBe(false)
  })

  test('已取消 signal → 不发提交请求', async () => {
    setLiveEnv()
    let submitCalled = false
    const fake = makeFakeFetch({ onSubmit: () => { submitCalled = true } })
    globalThis.fetch = fake
    const ac = new AbortController(); ac.abort()
    const provider = new OpenAiCompatibleVideoProvider('wan', 'draft')
    await expect(
      provider.generate({ prompt: 'p' }, { runId: 'r', shotId: 'S', tier: 'draft', outputDir: OUT, signal: ac.signal, artifactFetchFn: fake }),
    ).rejects.toThrow(/取消/)
    expect(submitCalled).toBe(false)
  })
})
