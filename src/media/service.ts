// [XJC] 媒体生成服务（T-B7 图像生成/对话式改图/视频生成）
//
// provider='openai-compatible'（硅基流动等 OpenAI 风格网关）：
//   生图/改图: POST {baseUrl}/images/generations  JSON {model, prompt[, image: base64 dataURI]}
//              响应兼容 { images:[{url}] }（硅基流动）与 { data:[{url|b64_json}] }（OpenAI 标准）
//   视频:      POST {baseUrl}/video/submit → {requestId} → 轮询 POST {baseUrl}/video/status
//              状态 Succeed/Failed（兼容大小写），结果 URL 仅约 10 分钟有效 → 立即下载落盘
//
// provider='dashscope'（阿里百炼原生，qwen-image / 通义万相；仅图像组）：
//   生图/改图: POST {baseUrl}/services/aigc/multimodal-generation/generation
//              JSON {model, input:{messages:[{role,content:[{text}|{image}]}]}, parameters}
//              响应 output.choices[0].message.content[].image 为临时 URL → 立即下载落盘
//
// 产物统一落盘到 agent 工作区「媒体产出」目录（与办公/创作产出约定一致），
// 渠道场景可经既有 sendMedia/[[attach]] 推送。红线：不硬编码任何厂商域名。

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { fetchRemoteMediaToFile } from '../channel/media-fetch.ts'
import { getPaths } from '../config/paths.ts'
import { getLogger } from '../logger/index.ts'
import { getStoredSettings } from '../settings/manager.ts'
import type { MediaImageConfig, MediaVideoConfig } from '../settings/schema.ts'
import {
  MediaError,
  MEDIA_INVALID_INPUT,
  MEDIA_NOT_CONFIGURED,
  MEDIA_PROVIDER_ERROR,
  type MediaFileResult,
  type MediaStatus,
} from './types.ts'

const IMAGE_TIMEOUT_MS = 120_000
const VIDEO_SUBMIT_TIMEOUT_MS = 30_000
const VIDEO_POLL_INTERVAL_MS = 5_000
const VIDEO_POLL_MAX_MS = 10 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 120_000
const ERROR_BODY_SNIPPET_MAX = 200
/** 供应商生成图片下载上限；同时约束 URL 产物与 base64 产物。 */
export const GENERATED_IMAGE_MAX_BYTES = 25 * 1024 * 1024
/** 供应商生成视频下载上限；下载过程流式落盘，不会把整段视频一次性读入内存。 */
export const GENERATED_VIDEO_MAX_BYTES = 512 * 1024 * 1024
/** 改图输入图上限（base64 后约 x1.37，10MB 原图足够常见场景） */
const EDIT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const EDIT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

function imageConfig(): MediaImageConfig {
  return getStoredSettings().media.image
}

function videoConfig(): MediaVideoConfig {
  return getStoredSettings().media.video
}

/** 图像生成支持的两种服务风格：OpenAI 兼容（硅基流动等）与阿里百炼原生 */
function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function hasValue(value: string): boolean {
  return value.trim().length > 0
}

function isImageProviderReady(cfg: MediaImageConfig): boolean {
  return (
    (cfg.provider === 'openai-compatible' || cfg.provider === 'dashscope')
    && isHttpEndpoint(cfg.baseUrl)
    && hasValue(cfg.apiKey)
  )
}

function isImageConfigured(cfg: MediaImageConfig): boolean {
  return isImageProviderReady(cfg) && hasValue(cfg.model)
}

function isImageEditConfigured(cfg: MediaImageConfig): boolean {
  return isImageProviderReady(cfg) && hasValue(cfg.editModel)
}

function isVideoConfigured(cfg: MediaVideoConfig): boolean {
  return (
    cfg.provider === 'openai-compatible'
    && isHttpEndpoint(cfg.baseUrl)
    && hasValue(cfg.apiKey)
    && hasValue(cfg.model)
  )
}

/** 把 HTTP 状态码翻译成可操作的中文提示（空串表示无特定提示，仅报状态码） */
function httpStatusHint(status: number): string {
  if (status === 401 || status === 403) return 'API Key 无效或无权限，请到 设置 → 语音与媒体 检查密钥'
  if (status === 402) return '账户余额不足，请充值后再试'
  if (status === 429) return '请求过于频繁或额度不足，请稍后再试'
  if (status === 404) return '接口地址或模型不存在，请到 设置 → 语音与媒体 检查接口地址与模型名'
  if (status >= 500) return '服务商暂时不可用，请稍后再试'
  return ''
}

async function providerErrorFromResponse(action: string, res: Response): Promise<MediaError> {
  let snippet = ''
  try {
    snippet = (await res.text()).slice(0, ERROR_BODY_SNIPPET_MAX).trim()
  } catch { /* 响应体不可读只报状态码 */ }
  // 保留 HTTP 状态码与响应片段（便于排查），前面加可操作的中文提示
  const hint = httpStatusHint(res.status)
  const base = hint ? `${action}失败：${hint}（HTTP ${res.status}）` : `${action}失败（HTTP ${res.status}）`
  return new MediaError(MEDIA_PROVIDER_ERROR, `${base}${snippet ? `：${snippet}` : ''}`)
}

function providerErrorFromNetwork(action: string, err: unknown): MediaError {
  const name = err instanceof Error ? err.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new MediaError(MEDIA_PROVIDER_ERROR, `${action}请求超时，请检查网络后重试`)
  }
  const detail = err instanceof Error ? err.message : String(err)
  return new MediaError(MEDIA_PROVIDER_ERROR, `${action}网络连接失败：${detail}`)
}

function timestampName(prefix: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}_${ts}_${rand}${ext}`
}

/** 媒体产出目录保留上限：超出后删除最旧产物，避免便携版磁盘被无限占用 */
const MEDIA_OUTPUT_MAX_FILES = 200

/** 保留最近 maxFiles 个产物，删除更旧的（尽力而为，任何异常都不影响生成主流程） */
function pruneOutputDir(dir: string, maxFiles: number): void {
  try {
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = resolve(dir, entry.name)
        try { return { full, mtime: statSync(full).mtimeMs } } catch { return null }
      })
      .filter((item): item is { full: string; mtime: number } => item !== null)
    if (files.length <= maxFiles) return
    files.sort((a, b) => a.mtime - b.mtime)
    for (const item of files.slice(0, files.length - maxFiles)) {
      try { rmSync(item.full, { force: true }) } catch { /* 尽力 */ }
    }
  } catch { /* 目录不可读则跳过清理 */ }
}

/** 产物目录：agent 工作区「媒体产出」；无 agentId 时落全局工作区 media-output */
function outputDir(agentId?: string): string {
  const dir = agentId
    ? resolve(getPaths().agents, agentId, '媒体产出')
    : resolve(getPaths().workspace, 'media-output')
  mkdirSync(dir, { recursive: true })
  pruneOutputDir(dir, MEDIA_OUTPUT_MAX_FILES)
  return dir
}

/** 解析 OpenAI 兼容生图响应：兼容 { images:[{url}] } 与 { data:[{url|b64_json}] } */
function extractImagePayload(body: unknown): { url?: string; b64?: string } {
  const obj = (body ?? {}) as Record<string, unknown>
  const first = (arr: unknown): Record<string, unknown> | null =>
    Array.isArray(arr) && arr.length > 0 && arr[0] && typeof arr[0] === 'object' ? arr[0] as Record<string, unknown> : null
  const item = first(obj.images) ?? first(obj.data)
  if (!item) return {}
  return {
    url: typeof item.url === 'string' ? item.url : undefined,
    b64: typeof item.b64_json === 'string' ? item.b64_json : undefined,
  }
}

/**
 * 解析阿里百炼原生同步生图响应：output.choices[0].message.content[] 中带 image 字段的元素。
 * 百炼仅返回临时 URL（约 24h 有效），无 base64。
 */
function extractDashscopeImageUrl(body: unknown): string | undefined {
  const output = (body as { output?: unknown })?.output as Record<string, unknown> | undefined
  const choices = output?.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: unknown })?.message as Record<string, unknown> | undefined
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).image === 'string') {
      return (part as Record<string, string>).image
    }
  }
  return undefined
}

async function downloadToFile(
  url: string,
  destPath: string,
  maxBytes: number,
  fetchFn?: typeof fetch,
): Promise<void> {
  try {
    const result = await fetchRemoteMediaToFile(url, destPath, {
      maxBytes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      fetchFn,
    })
    if (result.bytesWritten === 0) {
      rmSync(destPath, { force: true })
      throw new MediaError(MEDIA_PROVIDER_ERROR, '产物下载为空')
    }
  } catch (err) {
    rmSync(destPath, { force: true })
    if (err instanceof MediaError) throw err
    throw providerErrorFromNetwork('产物下载', err)
  }
}

export interface MediaServiceOptions {
  /** 仅用于供应商返回的产物 URL 下载；请求生成/轮询端点仍使用全局 fetch。 */
  artifactFetchFn?: typeof fetch
}

/** 视频生成可选项：取消信号（轮询时检查）与轮询进度回调（供 UI 显示「生成中」） */
export interface VideoGenerateOptions {
  signal?: AbortSignal
  onProgress?: (info: { elapsedMs: number; status: string }) => void
}

export class MediaService {
  private readonly artifactFetchFn?: typeof fetch

  constructor(options: MediaServiceOptions = {}) {
    this.artifactFetchFn = options.artifactFetchFn
  }

  status(): MediaStatus {
    const img = imageConfig()
    return {
      imageConfigured: isImageConfigured(img),
      imageEditConfigured: isImageEditConfigured(img),
      videoConfigured: isVideoConfigured(videoConfig()),
    }
  }

  /** 文生图：prompt → 产物落盘。opts.imageSize（如 "720x1280" 竖屏）仅 openai-compatible 生效。 */
  async generateImage(prompt: string, agentId?: string, opts?: { imageSize?: string }): Promise<MediaFileResult> {
    const cfg = imageConfig()
    if (!isImageConfigured(cfg)) {
      throw new MediaError(MEDIA_NOT_CONFIGURED, '图像生成未配置，请到 设置 → 语音与媒体 填写服务信息')
    }
    if (cfg.provider === 'dashscope') {
      return this.callDashscopeImageApi('图像生成', cfg, cfg.model, [{ text: prompt }], agentId)
    }
    const payload: Record<string, unknown> = { model: cfg.model, prompt }
    if (opts?.imageSize?.trim()) payload.image_size = opts.imageSize.trim()
    return this.callImageApi('图像生成', cfg, payload, agentId)
  }

  /**
   * 对话式改图：本地图片 → base64 → 指令编辑模型 → 产物落盘。
   * imagePath 须先经 assertEditableImagePath 校验（media-mcp 层负责）。
   */
  async editImage(imagePath: string, prompt: string, agentId?: string): Promise<MediaFileResult> {
    const cfg = imageConfig()
    if (!isImageEditConfigured(cfg)) {
      throw new MediaError(MEDIA_NOT_CONFIGURED, '改图未配置（缺改图模型），请到 设置 → 语音与媒体 填写')
    }
    const ext = extname(imagePath).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    let dataUri: string
    try {
      const bytes = readFileSync(imagePath)
      if (bytes.byteLength > EDIT_IMAGE_MAX_BYTES) {
        throw new MediaError(MEDIA_INVALID_INPUT, `输入图片超过 ${EDIT_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`)
      }
      dataUri = `data:${mime};base64,${bytes.toString('base64')}`
    } catch (err) {
      if (err instanceof MediaError) throw err
      throw new MediaError(MEDIA_INVALID_INPUT, `无法读取输入图片：${err instanceof Error ? err.message : String(err)}`)
    }
    if (cfg.provider === 'dashscope') {
      // 百炼原生改图：content 数组内先图后文（qwen-image-edit 系列）
      return this.callDashscopeImageApi('改图', cfg, cfg.editModel, [{ image: dataUri }, { text: prompt }], agentId)
    }
    return this.callImageApi('改图', cfg, { model: cfg.editModel, prompt, image: dataUri }, agentId)
  }

  private async callImageApi(
    action: string,
    cfg: MediaImageConfig,
    payload: Record<string, unknown>,
    agentId?: string,
  ): Promise<MediaFileResult> {
    let res: Response
    try {
      res = await fetch(endpointUrl(cfg.baseUrl, '/images/generations'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      })
    } catch (err) {
      throw providerErrorFromNetwork(action, err)
    }
    if (!res.ok) throw await providerErrorFromResponse(action, res)

    const body = await res.json().catch(() => null)
    const { url, b64 } = extractImagePayload(body)
    const filename = timestampName('img', '.png')
    const filePath = resolve(outputDir(agentId), filename)
    if (b64) {
      const estimatedBytes = Math.floor((b64.length * 3) / 4)
      if (estimatedBytes > GENERATED_IMAGE_MAX_BYTES) {
        throw new MediaError(
          MEDIA_PROVIDER_ERROR,
          `图像产物超过 ${GENERATED_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`,
        )
      }
      const bytes = Buffer.from(b64, 'base64')
      if (bytes.byteLength === 0) {
        throw new MediaError(MEDIA_PROVIDER_ERROR, '图像产物为空')
      }
      if (bytes.byteLength > GENERATED_IMAGE_MAX_BYTES) {
        throw new MediaError(
          MEDIA_PROVIDER_ERROR,
          `图像产物超过 ${GENERATED_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`,
        )
      }
      writeFileSync(filePath, bytes)
    } else if (url) {
      await downloadToFile(url, filePath, GENERATED_IMAGE_MAX_BYTES, this.artifactFetchFn)
    } else {
      throw new MediaError(MEDIA_PROVIDER_ERROR, `${action}返回格式异常（缺少图片 URL/base64）`)
    }
    getLogger().info({ action, filePath, agentId, category: 'media' }, 'Media image saved')
    return { filePath, filename }
  }

  /**
   * 阿里百炼原生生图/改图（同步，multimodal-generation 端点，qwen-image / 万相）。
   * 与 OpenAI 端点请求/响应结构均不同：请求体走 input.messages[].content，
   * 响应从 output.choices[0].message.content[].image 取临时 URL 后立即下载落盘。
   */
  private async callDashscopeImageApi(
    action: string,
    cfg: MediaImageConfig,
    model: string,
    content: Array<Record<string, string>>,
    agentId?: string,
  ): Promise<MediaFileResult> {
    const payload = {
      model,
      input: { messages: [{ role: 'user', content }] },
      parameters: { n: 1, watermark: false },
    }
    let res: Response
    try {
      res = await fetch(endpointUrl(cfg.baseUrl, '/services/aigc/multimodal-generation/generation'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      })
    } catch (err) {
      throw providerErrorFromNetwork(action, err)
    }
    if (!res.ok) throw await providerErrorFromResponse(action, res)

    const body = await res.json().catch(() => null)
    const url = extractDashscopeImageUrl(body)
    if (!url) throw new MediaError(MEDIA_PROVIDER_ERROR, `${action}返回格式异常（缺少图片 URL）`)
    const filename = timestampName('img', '.png')
    const filePath = resolve(outputDir(agentId), filename)
    await downloadToFile(url, filePath, GENERATED_IMAGE_MAX_BYTES, this.artifactFetchFn)
    getLogger().info({ action, filePath, agentId, provider: 'dashscope', category: 'media' }, 'Media image saved')
    return { filePath, filename }
  }

  /** 视频生成：submit → 轮询 status → 结果 URL 立即下载落盘（URL 短时效） */
  async generateVideo(prompt: string, agentId?: string, imagePath?: string, options?: VideoGenerateOptions): Promise<MediaFileResult> {
    const cfg = videoConfig()
    if (!isVideoConfigured(cfg)) {
      throw new MediaError(MEDIA_NOT_CONFIGURED, '视频生成未配置，请到 设置 → 语音与媒体 填写服务信息')
    }
    const throwIfCancelled = () => {
      if (options?.signal?.aborted) throw new MediaError(MEDIA_PROVIDER_ERROR, '视频生成已取消')
    }
    throwIfCancelled()

    const payload: Record<string, unknown> = { model: cfg.model, prompt }
    if (imagePath) {
      // 图生视频：输入图转 base64（限制同改图）
      const ext = extname(imagePath).toLowerCase()
      if (!EDIT_IMAGE_EXTENSIONS.has(ext)) {
        throw new MediaError(MEDIA_INVALID_INPUT, '图生视频仅支持 png/jpg/jpeg/webp 输入')
      }
      const bytes = readFileSync(imagePath)
      if (bytes.byteLength > EDIT_IMAGE_MAX_BYTES) {
        throw new MediaError(MEDIA_INVALID_INPUT, '输入图片超过大小上限')
      }
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
      payload.image = `data:${mime};base64,${bytes.toString('base64')}`
    }

    // 1) submit
    let submitRes: Response
    try {
      submitRes = await fetch(endpointUrl(cfg.baseUrl, '/video/submit'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(VIDEO_SUBMIT_TIMEOUT_MS),
      })
    } catch (err) {
      throw providerErrorFromNetwork('视频生成提交', err)
    }
    if (!submitRes.ok) throw await providerErrorFromResponse('视频生成提交', submitRes)
    const submitBody = await submitRes.json().catch(() => null) as { requestId?: string } | null
    const requestId = submitBody?.requestId
    if (!requestId) throw new MediaError(MEDIA_PROVIDER_ERROR, '视频生成提交返回格式异常（缺少 requestId）')

    // 2) poll
    const startedAt = Date.now()
    const deadline = startedAt + VIDEO_POLL_MAX_MS
    let videoUrl = ''
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS))
      throwIfCancelled()
      let statusRes: Response
      try {
        statusRes = await fetch(endpointUrl(cfg.baseUrl, '/video/status'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(VIDEO_SUBMIT_TIMEOUT_MS),
        })
      } catch {
        continue // 单次轮询失败继续（网络抖动）
      }
      if (!statusRes.ok) continue
      const statusBody = await statusRes.json().catch(() => null) as {
        status?: string
        reason?: string
        results?: { videos?: Array<{ url?: string }> }
      } | null
      const status = String(statusBody?.status ?? '').toLowerCase()
      if (status === 'succeed' || status === 'succeeded' || status === 'success') {
        videoUrl = statusBody?.results?.videos?.[0]?.url ?? ''
        break
      }
      if (status === 'failed' || status === 'fail') {
        throw new MediaError(MEDIA_PROVIDER_ERROR, `视频生成失败：${statusBody?.reason ?? '供应商未给出原因'}`)
      }
      // InQueue / InProgress → 上报进度后继续轮询
      options?.onProgress?.({ elapsedMs: Date.now() - startedAt, status: statusBody?.status ?? 'InProgress' })
    }
    if (!videoUrl) {
      throw new MediaError(MEDIA_PROVIDER_ERROR, '视频生成超时或未返回结果 URL（上限 10 分钟）')
    }

    // 3) 立即下载（结果 URL 短时效）
    const filename = timestampName('video', '.mp4')
    const filePath = resolve(outputDir(agentId), filename)
    await downloadToFile(videoUrl, filePath, GENERATED_VIDEO_MAX_BYTES, this.artifactFetchFn)
    getLogger().info({ filePath, agentId, category: 'media' }, 'Media video saved')
    return { filePath, filename }
  }
}

export interface LocalMediaInputScope {
  workspaceDir: string
  attachmentPaths?: string[]
}

/**
 * 本地输入文件安全校验：仅允许当前员工工作区内文件，或当前消息明确拥有的附件。
 * 双侧 realpath 防 symlink/junction 逃逸；附件按 realpath 精确匹配，禁止跨会话读取。
 */
export function assertSafeLocalInputPath(
  rawPath: string,
  allowedExtensions: ReadonlySet<string>,
  kindLabel: string,
  scope: LocalMediaInputScope,
): string {
  const ext = extname(rawPath).toLowerCase()
  if (!allowedExtensions.has(ext)) {
    throw new MediaError(MEDIA_INVALID_INPUT, `仅支持 ${[...allowedExtensions].map((e) => e.slice(1)).join('/')} 格式的${kindLabel}`)
  }
  let real: string
  try {
    real = realpathSync(resolve(rawPath)) // 解析 symlink/junction + 存在性
  } catch {
    throw new MediaError(MEDIA_INVALID_INPUT, `输入${kindLabel}不存在或不可读`)
  }
  let workspaceRoot: string
  try {
    workspaceRoot = realpathSync(resolve(scope.workspaceDir))
  } catch {
    workspaceRoot = resolve(scope.workspaceDir)
  }
  const exactAttachments = new Set(
    (scope.attachmentPaths ?? []).flatMap((path) => {
      try { return [realpathSync(resolve(path))] } catch { return [] }
    }).map((path) => process.platform === 'win32' ? path.toLowerCase() : path),
  )
  const normalized = process.platform === 'win32' ? real.toLowerCase() : real
  const normalizedWorkspace = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot
  const insideWorkspace =
    normalized === normalizedWorkspace
    || normalized.startsWith(`${normalizedWorkspace}\\`)
    || normalized.startsWith(`${normalizedWorkspace}/`)
  const allowed = insideWorkspace || exactAttachments.has(normalized)
  if (!allowed) {
    throw new MediaError(MEDIA_INVALID_INPUT, `输入${kindLabel}必须位于当前员工工作区或当前消息附件中`)
  }
  return real
}

/** 改图/图生视频输入路径安全校验（assertSafeLocalInputPath 的图片特化） */
export function assertEditableImagePath(rawPath: string, scope: LocalMediaInputScope): string {
  return assertSafeLocalInputPath(rawPath, EDIT_IMAGE_EXTENSIONS, '图片', scope)
}

let singleton: MediaService | null = null

export function getMediaService(): MediaService {
  if (!singleton) singleton = new MediaService()
  return singleton
}
