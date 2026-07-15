// [XJC] 多供应商 provider 单测（HTTP 层全 mock，不联网不花钱）：
// Kling 原生首尾帧 video provider、Nano Banana 关键帧一致性 provider、VLM 质检打分、kind 路由。
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  KlingVideoProvider,
  OpenAiCompatibleVideoProvider,
  resolveVideoConfig,
  resolveVideoProvider,
} from '../src/media/video-provider.ts'
import { resolveKeyframeProvider } from '../src/studio/keyframeProvider.ts'
import { scoreShotConsistency } from '../src/studio/vlmQc.ts'

const OUT = resolve(process.env.DATA_DIR as string, 'multivendor-test')
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const REF = resolve(OUT, 'ref.png')
const START = resolve(OUT, 'start.png')
const END = resolve(OUT, 'end.png')
const savedFetch = globalThis.fetch

beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
  for (const p of [REF, START, END]) writeFileSync(p, FAKE_PNG)
})

function writeStudio(studio: Record<string, unknown>) {
  getDatabase().run('INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)', ['settings', JSON.stringify({ studio })])
}

afterEach(() => {
  globalThis.fetch = savedFetch
  delete process.env.XJC_STUDIO_VIDEO_MODE
  delete process.env.XJC_VIDEO_POLL_MS
})

describe('KlingVideoProvider 原生首尾帧（HTTP mock，不花钱）', () => {
  test('submit(start+end,mode=pro)→poll(Succeed)→download；supportsLastFrame + endPath=尾帧', async () => {
    writeStudio({ hq: { kind: 'kling', baseUrl: 'https://agg.example/v1', apiKey: 'sk-x', model: 'kling-2.1-pro' } })
    process.env.XJC_VIDEO_POLL_MS = '5'
    let submitBody: Record<string, unknown> = {}
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/video/submit')) {
        submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
      }
      if (url.endsWith('/video/status')) return new Response(JSON.stringify({ data: { status: 'Succeed', video_url: 'https://media.example.test/k.mp4' } }), { status: 200 })
      if (url.includes('media.example.test')) return new Response(new Uint8Array([0, 0, 0, 24]), { status: 200 })
      return new Response('nf', { status: 404 })
    }) as typeof fetch
    globalThis.fetch = fake
    const provider = new KlingVideoProvider('kling', 'hq')
    expect(provider.supportsLastFrame).toBe(true)
    expect(provider.isConfigured()).toBe(true)
    const res = await provider.generate(
      { prompt: '推镜', firstFramePath: START, lastFramePath: END, aspectRatio: '9:16', durationSec: 5 },
      { runId: 'r', shotId: 'S1', tier: 'hq', outputDir: OUT, artifactFetchFn: fake },
    )
    expect(res.dryRun).toBe(false)
    expect(res.providerId).toBe('kling')
    expect(res.endPath).toBe(END) // 原生首尾帧：镜末=传入尾帧
    expect(submitBody.mode).toBe('pro')
    expect(submitBody.start_image).toBeDefined()
    expect(submitBody.end_image).toBeDefined() // 首尾帧双控
    expect(existsSync(res.filePath)).toBe(true)
  }, 20_000)

  test('status=Failed → 抛错', async () => {
    writeStudio({ hq: { kind: 'kling', baseUrl: 'https://agg.example/v1', apiKey: 'sk-x', model: 'kling-2.1-pro' } })
    process.env.XJC_VIDEO_POLL_MS = '5'
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/video/submit')) return new Response(JSON.stringify({ task_id: 't1' }), { status: 200 })
      if (url.endsWith('/video/status')) return new Response(JSON.stringify({ status: 'Failed', message: '内容审核未通过' }), { status: 200 })
      return new Response('nf', { status: 404 })
    }) as typeof fetch
    await expect(
      new KlingVideoProvider('kling', 'hq').generate({ prompt: 'p', firstFramePath: START }, { runId: 'r', shotId: 'S2', tier: 'hq', outputDir: OUT }),
    ).rejects.toThrow(/失败|审核/)
  }, 20_000)

  test('未配置 → 抛错', async () => {
    writeStudio({ hq: { kind: 'kling', baseUrl: '', apiKey: '', model: '' } })
    const savedKey = process.env.SILICONFLOW_API_KEY
    const savedBase = process.env.SILICONFLOW_BASE_URL
    delete process.env.SILICONFLOW_API_KEY
    delete process.env.SILICONFLOW_BASE_URL
    try {
      const provider = new KlingVideoProvider('kling', 'hq')
      expect(provider.isConfigured()).toBe(false)
      await expect(provider.generate({ prompt: 'p' }, { runId: 'r', shotId: 'S', tier: 'hq', outputDir: OUT })).rejects.toThrow(/未配置/)
    } finally {
      if (savedKey !== undefined) process.env.SILICONFLOW_API_KEY = savedKey
      if (savedBase !== undefined) process.env.SILICONFLOW_BASE_URL = savedBase
    }
  })
})

describe('resolveVideoProvider 按 kind 路由（config 驱动）', () => {
  test('draft.kind=kling→Kling；hq.kind=wan→OpenAiCompatible', () => {
    process.env.XJC_STUDIO_VIDEO_MODE = 'live'
    writeStudio({
      draft: { kind: 'kling', baseUrl: 'b', apiKey: 'k', model: 'm' },
      hq: { kind: 'wan', baseUrl: 'b', apiKey: 'k', model: 'm' },
    })
    expect(resolveVideoConfig('draft').kind).toBe('kling')
    expect(resolveVideoProvider('draft')).toBeInstanceOf(KlingVideoProvider)
    expect(resolveVideoProvider('hq')).toBeInstanceOf(OpenAiCompatibleVideoProvider)
  })
})

describe('Nano Banana 关键帧一致性 provider（HTTP mock）', () => {
  test('images/generations（带参考图）→ 下载落盘 + 成本', async () => {
    writeStudio({ image: { kind: 'nano-banana', baseUrl: 'https://agg.example/v1', apiKey: 'sk-x', model: 'gemini-2.5-flash-image' } })
    let body: Record<string, unknown> = {}
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/images/generations')) {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ images: [{ url: 'https://media.example.test/kf.png' }] }), { status: 200 })
      }
      if (url.includes('media.example.test')) return new Response(FAKE_PNG, { status: 200 })
      return new Response('nf', { status: 404 })
    }) as typeof fetch
    globalThis.fetch = fake
    const provider = resolveKeyframeProvider()
    expect(provider.id).toBe('nano-banana')
    expect(provider.supportsReference).toBe(true)
    expect(provider.isConfigured()).toBe(true)
    const out = resolve(OUT, 'kf_out.png')
    const res = await provider.generate({ prompt: '橘猫角色', referenceImagePaths: [REF], aspectRatio: '9:16', outputPath: out, artifactFetchFn: fake })
    expect(res.costCny).toBe(0.3)
    expect(res.providerId).toBe('nano-banana')
    expect(body.image).toBeDefined() // 参考图（角色一致）
    expect(body.image_size).toBe('720x1280')
    expect(existsSync(out)).toBe(true)
  })

  test('b64_json 响应直接落盘', async () => {
    writeStudio({ image: { kind: 'nano-banana', baseUrl: 'https://agg.example/v1', apiKey: 'sk-x', model: 'gemini-2.5-flash-image' } })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(FAKE_PNG).toString('base64') }] }), { status: 200 })
      return new Response('nf', { status: 404 })
    }) as typeof fetch
    const out = resolve(OUT, 'kf_b64.png')
    const res = await resolveKeyframeProvider().generate({ prompt: 'p', outputPath: out })
    expect(existsSync(out)).toBe(true)
    expect(res.costCny).toBe(0.3)
  })
})

describe('VLM 质检打分（HTTP mock）', () => {
  test('enabled=false 直接放行(score=100)', async () => {
    writeStudio({ qc: { enabled: false } })
    const s = await scoreShotConsistency({ imagePaths: [REF] })
    expect(s.enabled).toBe(false)
    expect(s.pass).toBe(true)
    expect(s.score).toBe(100)
  })

  test('enabled：解析 JSON 打分 + 阈值判定', async () => {
    writeStudio({ qc: { enabled: true, baseUrl: 'https://agg.example/v1', apiKey: 'sk-x', model: 'qwen3-vl-plus', minScore: 70 } })
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: '这是评估结果：{"score":85,"issues":[]}' } }] }), { status: 200 })
      return new Response('nf', { status: 404 })
    }) as typeof fetch
    const s = await scoreShotConsistency({ imagePaths: [REF], prompt: '橘猫', referenceImagePaths: [REF] })
    expect(s.enabled).toBe(true)
    expect(s.score).toBe(85)
    expect(s.pass).toBe(true)
  })

  test('不过阈值 → pass=false + issues', async () => {
    writeStudio({ qc: { enabled: true, baseUrl: 'https://agg.example/v1', apiKey: 'sk-x', model: 'qwen3-vl-plus', minScore: 70 } })
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"score":40,"issues":["画风 3D 化","角色漂移"]}' } }] }), { status: 200 })) as typeof fetch
    const s = await scoreShotConsistency({ imagePaths: [REF] })
    expect(s.score).toBe(40)
    expect(s.pass).toBe(false)
    expect(s.issues).toContain('画风 3D 化')
  })
})
