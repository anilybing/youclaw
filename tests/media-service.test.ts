// [XJC] T-B7 媒体服务测试：本地 Bun.serve 假服务端断言请求形状与全链路
// （生图落盘 / 改图 base64 请求体 / 视频 submit→轮询→下载 / 错误与未配置 / 输入路径安全）。
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../src/config/paths.ts'
import {
  GENERATED_IMAGE_MAX_BYTES,
  MediaService,
  assertEditableImagePath,
} from '../src/media/service.ts'
import { MEDIA_INVALID_INPUT, MEDIA_NOT_CONFIGURED, MEDIA_PROVIDER_ERROR, MediaError } from '../src/media/types.ts'

interface Captured {
  pathname: string
  authorization: string | null
  body: Record<string, unknown> | null
}

const requests: Captured[] = []
let videoPollsUntilSucceed = 0
let videoPollCount = 0

const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const FAKE_MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
const PUBLIC_MEDIA_ORIGIN = 'https://media.example.test'
const artifactRequests: Array<{ url: string; redirect?: RequestRedirect }> = []

const artifactFetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  artifactRequests.push({ url: url.href, redirect: init?.redirect })
  if (url.pathname === '/files/out.png') {
    return new Response(FAKE_PNG, { headers: { 'Content-Type': 'image/png' } })
  }
  if (url.pathname === '/files/out.mp4') {
    return new Response(FAKE_MP4, { headers: { 'Content-Type': 'video/mp4' } })
  }
  if (url.pathname === '/redirect-private.png') {
    return new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    })
  }
  if (url.pathname === '/oversized.png') {
    return new Response(new Uint8Array([1]), {
      headers: { 'Content-Length': String(GENERATED_IMAGE_MAX_BYTES + 1) },
    })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const entry: Captured = {
      pathname: url.pathname,
      authorization: req.headers.get('authorization'),
      body: req.method === 'POST' ? await req.json().catch(() => null) as Record<string, unknown> | null : null,
    }
    requests.push(entry)

    if (url.pathname === '/v1/images/generations') {
      const model = String(entry.body?.model ?? '')
      if (model === 'error-model') return new Response('quota exceeded', { status: 429 })
      // 生图回 URL 形态（硅基流动风格），改图回 b64 形态（覆盖两种解析路径）
      if (typeof entry.body?.image === 'string') {
        return Response.json({ data: [{ b64_json: Buffer.from(FAKE_PNG).toString('base64') }] })
      }
      const outputUrl = model === 'private-output'
        ? 'http://169.254.169.254/latest/meta-data/'
        : model === 'redirect-output'
          ? `${PUBLIC_MEDIA_ORIGIN}/redirect-private.png`
          : model === 'oversized-output'
            ? `${PUBLIC_MEDIA_ORIGIN}/oversized.png`
            : `${PUBLIC_MEDIA_ORIGIN}/files/out.png`
      return Response.json({ images: [{ url: outputUrl }] })
    }
    // 阿里百炼原生生图/改图端点：返回 output.choices[0].message.content[].image（URL 形态）
    if (url.pathname === '/v1/services/aigc/multimodal-generation/generation') {
      const model = String(entry.body?.model ?? '')
      if (model === 'error-model') return new Response('InvalidApiKey', { status: 401 })
      return Response.json({
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `${PUBLIC_MEDIA_ORIGIN}/files/out.png` }] } }] },
      })
    }
    if (url.pathname === '/files/out.png') {
      return new Response(FAKE_PNG, { headers: { 'Content-Type': 'image/png' } })
    }
    if (url.pathname === '/v1/video/submit') {
      videoPollCount = 0
      return Response.json({ requestId: 'req-123' })
    }
    if (url.pathname === '/v1/video/status') {
      videoPollCount++
      if (videoPollCount <= videoPollsUntilSucceed) {
        return Response.json({ status: 'InProgress' })
      }
      return Response.json({ status: 'Succeed', results: { videos: [{ url: `${PUBLIC_MEDIA_ORIGIN}/files/out.mp4` }] } })
    }
    if (url.pathname === '/files/out.mp4') {
      return new Response(FAKE_MP4, { headers: { 'Content-Type': 'video/mp4' } })
    }
    return new Response('not found', { status: 404 })
  },
})

afterAll(() => {
  server.stop(true)
  try { rmSync(resolve(getPaths().workspace, 'agents', 'media-test-agent'), { recursive: true, force: true }) } catch { /* 尽力 */ }
})

function baseUrl(): string {
  return `http://127.0.0.1:${server.port}/v1`
}

function writeMediaSettings(overrides: { image?: Record<string, unknown>; video?: Record<string, unknown> }) {
  getDatabase().run(
    'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
    ['settings', JSON.stringify({ media: overrides })],
  )
}

function configuredAll() {
  writeMediaSettings({
    image: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-media-test', model: 'fake-image', editModel: 'fake-edit' },
    video: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-media-test', model: 'fake-video' },
  })
}

function configuredDashscope() {
  writeMediaSettings({
    image: { provider: 'dashscope', baseUrl: baseUrl(), apiKey: 'sk-ali-test', model: 'qwen-image-2.0-pro', editModel: 'qwen-image-edit-plus' },
  })
}

const service = new MediaService({ artifactFetchFn })
const AGENT = 'media-test-agent'

beforeEach(() => {
  requests.length = 0
  artifactRequests.length = 0
  videoPollsUntilSucceed = 0
})

describe('MediaService.status', () => {
  test('未配置时全为 false；配置后按组生效', () => {
    writeMediaSettings({})
    expect(service.status()).toEqual({ imageConfigured: false, imageEditConfigured: false, videoConfigured: false })
    configuredAll()
    expect(service.status()).toEqual({ imageConfigured: true, imageEditConfigured: true, videoConfigured: true })
  })
})

describe('MediaService.generateImage', () => {
  test('未配置抛 MEDIA_NOT_CONFIGURED 且不发请求', async () => {
    writeMediaSettings({})
    await expect(service.generateImage('a cat', AGENT)).rejects.toMatchObject({ code: MEDIA_NOT_CONFIGURED })
    expect(requests.length).toBe(0)
  })

  test('生图：Bearer 鉴权、URL 产物下载落盘到 agent 媒体产出', async () => {
    configuredAll()
    const result = await service.generateImage('a cat on the moon', AGENT)
    const gen = requests.find((r) => r.pathname === '/v1/images/generations')!
    expect(gen.authorization).toBe('Bearer sk-media-test')
    expect(gen.body?.model).toBe('fake-image')
    expect(gen.body?.prompt).toBe('a cat on the moon')
    expect(gen.body?.image).toBeUndefined()
    expect(result.filePath).toContain('媒体产出')
    expect(existsSync(result.filePath)).toBe(true)
    expect(new Uint8Array(readFileSync(result.filePath))).toEqual(FAKE_PNG)
    expect(artifactRequests).toEqual([{
      url: `${PUBLIC_MEDIA_ORIGIN}/files/out.png`,
      redirect: 'manual',
    }])
  })

  test('拒绝供应商返回的私网/元数据图片 URL，且校验前不发下载请求', async () => {
    writeMediaSettings({
      image: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-x', model: 'private-output', editModel: '' },
    })
    const err = await service.generateImage('x', AGENT).catch((e) => e as MediaError)
    expect(err).toBeInstanceOf(MediaError)
    expect(err.code).toBe(MEDIA_PROVIDER_ERROR)
    expect(err.message).toMatch(/内网|保留地址/)
    expect(artifactRequests).toHaveLength(0)
  })

  test('拒绝供应商图片 URL 的 302 私网跳转', async () => {
    writeMediaSettings({
      image: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-x', model: 'redirect-output', editModel: '' },
    })
    const err = await service.generateImage('x', AGENT).catch((e) => e as MediaError)
    expect(err).toBeInstanceOf(MediaError)
    expect(err.code).toBe(MEDIA_PROVIDER_ERROR)
    expect(err.message).toContain('内网/保留地址')
    expect(artifactRequests).toHaveLength(1)
  })

  test('按响应头拒绝超过图片产物上限的下载', async () => {
    writeMediaSettings({
      image: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-x', model: 'oversized-output', editModel: '' },
    })
    const err = await service.generateImage('x', AGENT).catch((e) => e as MediaError)
    expect(err).toBeInstanceOf(MediaError)
    expect(err.code).toBe(MEDIA_PROVIDER_ERROR)
    expect(err.message).toContain('超过上限')
  })

  test('供应商非 2xx 抛 MEDIA_PROVIDER_ERROR 带状态码与片段', async () => {
    writeMediaSettings({
      image: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-x', model: 'error-model', editModel: '' },
    })
    const err = await service.generateImage('x', AGENT).catch((e) => e as MediaError)
    expect(err).toBeInstanceOf(MediaError)
    expect((err as MediaError).code).toBe(MEDIA_PROVIDER_ERROR)
    expect((err as MediaError).message).toContain('429')
    expect((err as MediaError).message).toContain('quota exceeded')
    // 友好提示：额度/频繁相关，同时保留状态码与响应片段
    expect((err as MediaError).message).toContain('额度')
  })
})

describe('MediaService dashscope 原生（阿里百炼 qwen-image / 万相）', () => {
  test('status：dashscope 图像/改图配置齐全即生效', () => {
    configuredDashscope()
    const s = service.status()
    expect(s.imageConfigured).toBe(true)
    expect(s.imageEditConfigured).toBe(true)
  })

  test('生图：走 multimodal-generation 端点，content 仅 text，解析 output.choices 图片 URL 下载落盘', async () => {
    configuredDashscope()
    const result = await service.generateImage('一只橘猫', AGENT)
    const gen = requests.find((r) => r.pathname === '/v1/services/aigc/multimodal-generation/generation')!
    expect(gen).toBeDefined()
    expect(gen.authorization).toBe('Bearer sk-ali-test')
    expect(gen.body?.model).toBe('qwen-image-2.0-pro')
    const messages = (gen.body?.input as { messages?: Array<{ content?: Array<Record<string, unknown>> }> })?.messages
    expect(messages?.[0]?.content).toEqual([{ text: '一只橘猫' }])
    // 不应命中 OpenAI 兼容端点
    expect(requests.some((r) => r.pathname === '/v1/images/generations')).toBe(false)
    expect(existsSync(result.filePath)).toBe(true)
    expect(new Uint8Array(readFileSync(result.filePath))).toEqual(FAKE_PNG)
  })

  test('改图：content 先图后文（image dataURI + text），用 editModel', async () => {
    configuredDashscope()
    const srcDir = resolve(getPaths().data, 'attachments')
    mkdirSync(srcDir, { recursive: true })
    const srcPath = resolve(srcDir, 'src-ali.png')
    writeFileSync(srcPath, FAKE_PNG)

    const result = await service.editImage(srcPath, '换成雪山背景', AGENT)
    const gen = requests.find((r) => r.pathname === '/v1/services/aigc/multimodal-generation/generation')!
    expect(gen.body?.model).toBe('qwen-image-edit-plus')
    const content = (gen.body?.input as { messages?: Array<{ content?: Array<Record<string, unknown>> }> })?.messages?.[0]?.content
    expect(String(content?.[0]?.image)).toStartWith('data:image/png;base64,')
    expect(content?.[1]).toEqual({ text: '换成雪山背景' })
    expect(existsSync(result.filePath)).toBe(true)
  })

  test('dashscope 供应商错误抛 MEDIA_PROVIDER_ERROR 带状态码', async () => {
    writeMediaSettings({
      image: { provider: 'dashscope', baseUrl: baseUrl(), apiKey: 'sk-x', model: 'error-model', editModel: '' },
    })
    const err = await service.generateImage('x', AGENT).catch((e) => e as MediaError)
    expect(err).toBeInstanceOf(MediaError)
    expect((err as MediaError).code).toBe(MEDIA_PROVIDER_ERROR)
    expect((err as MediaError).message).toContain('401')
    // 友好提示：Key 相关，同时保留状态码
    expect((err as MediaError).message).toContain('API Key')
  })
})

describe('MediaService.editImage', () => {
  test('改图：本地图转 base64 dataURI 进 image 字段，用 editModel；b64 产物直接落盘', async () => {
    configuredAll()
    const srcDir = resolve(getPaths().data, 'attachments')
    mkdirSync(srcDir, { recursive: true })
    const srcPath = resolve(srcDir, 'src-image.png')
    writeFileSync(srcPath, FAKE_PNG)

    const result = await service.editImage(srcPath, '把背景换成雪山', AGENT)
    const gen = requests.find((r) => r.pathname === '/v1/images/generations')!
    expect(gen.body?.model).toBe('fake-edit')
    expect(String(gen.body?.image)).toStartWith('data:image/png;base64,')
    expect(String(gen.body?.image)).toContain(Buffer.from(FAKE_PNG).toString('base64'))
    expect(existsSync(result.filePath)).toBe(true)
  })

  test('editModel 未配置时改图抛 MEDIA_NOT_CONFIGURED', async () => {
    writeMediaSettings({
      image: { provider: 'openai-compatible', baseUrl: baseUrl(), apiKey: 'sk-x', model: 'fake-image', editModel: '' },
    })
    await expect(service.editImage(resolve(getPaths().data, 'attachments', 'src-image.png'), 'x', AGENT))
      .rejects.toMatchObject({ code: MEDIA_NOT_CONFIGURED })
  })
})

describe('MediaService.generateVideo', () => {
  test('submit→轮询(InProgress→Succeed)→下载落盘 .mp4', async () => {
    configuredAll()
    videoPollsUntilSucceed = 2
    const result = await service.generateVideo('sunset timelapse', AGENT)
    const submit = requests.find((r) => r.pathname === '/v1/video/submit')!
    expect(submit.authorization).toBe('Bearer sk-media-test')
    expect(submit.body?.model).toBe('fake-video')
    const polls = requests.filter((r) => r.pathname === '/v1/video/status')
    expect(polls.length).toBeGreaterThanOrEqual(3)
    expect(polls[0]!.body?.requestId).toBe('req-123')
    expect(result.filePath.endsWith('.mp4')).toBe(true)
    expect(new Uint8Array(readFileSync(result.filePath))).toEqual(FAKE_MP4)
  }, 60_000)

  test('未配置抛 MEDIA_NOT_CONFIGURED', async () => {
    writeMediaSettings({})
    await expect(service.generateVideo('x', AGENT)).rejects.toMatchObject({ code: MEDIA_NOT_CONFIGURED })
  })
})

describe('assertEditableImagePath 输入安全', () => {
  const workspaceDir = resolve(getPaths().workspace, 'agents', 'media-scope-agent')
  const attachmentDir = resolve(getPaths().data, 'attachments')

  test('当前员工工作区与当前消息精确附件放行', () => {
    const workspaceImage = resolve(workspaceDir, 'workspace-image.png')
    const attachmentImage = resolve(attachmentDir, 'current-message.png')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(attachmentDir, { recursive: true })
    writeFileSync(workspaceImage, FAKE_PNG)
    writeFileSync(attachmentImage, FAKE_PNG)
    const scope = { workspaceDir, attachmentPaths: [attachmentImage] }
    expect(assertEditableImagePath(workspaceImage, scope)).toBe(resolve(workspaceImage))
    expect(assertEditableImagePath(attachmentImage, scope)).toBe(resolve(attachmentImage))
  })

  test('拒绝其他会话附件和其他员工工作区图片', () => {
    const otherAttachment = resolve(attachmentDir, 'other-message.png')
    const otherWorkspace = resolve(getPaths().workspace, 'agents', 'other-agent', 'private.png')
    mkdirSync(resolve(otherWorkspace, '..'), { recursive: true })
    writeFileSync(otherAttachment, FAKE_PNG)
    writeFileSync(otherWorkspace, FAKE_PNG)
    const scope = { workspaceDir, attachmentPaths: [] }
    expect(() => assertEditableImagePath(otherAttachment, scope)).toThrow(/当前消息附件/)
    expect(() => assertEditableImagePath(otherWorkspace, scope)).toThrow(/当前员工工作区/)
  })

  test('目录外文件拒绝（防 prompt 注入外泄本地文件）', () => {
    const outside = resolve(getPaths().data, '..', 'outside-secret.png')
    writeFileSync(outside, FAKE_PNG)
    try {
      const scope = { workspaceDir, attachmentPaths: [] }
      expect(() => assertEditableImagePath(outside, scope)).toThrow(MediaError)
      expect(() => assertEditableImagePath(outside, scope)).toThrow(/当前员工工作区/)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('非图片扩展名拒绝', () => {
    const bad = resolve(getPaths().data, 'attachments', 'notes.txt')
    writeFileSync(bad, 'text')
    const err = (() => {
      try {
        assertEditableImagePath(bad, { workspaceDir, attachmentPaths: [bad] })
        return null
      } catch (e) {
        return e as MediaError
      }
    })()
    expect(err?.code).toBe(MEDIA_INVALID_INPUT)
  })

  test('不存在的文件拒绝', () => {
    const ghost = resolve(getPaths().data, 'attachments', 'ghost.png')
    expect(() => assertEditableImagePath(ghost, { workspaceDir, attachmentPaths: [ghost] })).toThrow(MediaError)
  })
})
