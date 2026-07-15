// [XJC] 漫剧工作室·关键帧图像 provider（跨镜角色一致；根治角色/画风漂移）。
//
// settings.studio.image.kind 路由：nano-banana(Gemini2.5 Flash Image，编辑式一致、多参考图) /
// flux-kontext / qwen-image / kolors。统一走 OpenAI 兼容 /images/generations（带参考图 = 角色一致），
// 适配聚合器(302.ai 等)或直连；baseUrl/apiKey/model 走 settings.studio.image。
// 安全：本模块只在真出片链路被调用；HTTP 层全 mock 可单测（不联网不烧钱）。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { getStoredSettings } from '../settings/manager.ts'
import { fetchRemoteMediaToFile } from '../channel/media-fetch.ts'

const IMG_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const IMG_MAX_BYTES = 10 * 1024 * 1024
// 编辑式模型（如 Qwen-Image-Edit-2509）在高分辨率下较慢，默认 180s；env 可覆盖。
const GEN_TIMEOUT_MS = Number(process.env.XJC_IMAGE_GEN_TIMEOUT_MS) > 0 ? Number(process.env.XJC_IMAGE_GEN_TIMEOUT_MS) : 180_000

/** 关键帧图像的名义成本（¥）：Nano Banana $0.03≈¥0.21；取 ¥0.3 保守口径与视频档对齐。 */
export const KEYFRAME_COST_CNY = 0.3

export interface KeyframeGenParams {
  prompt: string
  /** 角色一致性参考图（角色设定图 / 上镜关键帧）；本机路径。 */
  referenceImagePaths?: string[]
  aspectRatio?: string | null
  outputPath: string
  /** 仅供确定性测试注入产物下载 fetch；生产留空走 pinned-http。 */
  artifactFetchFn?: typeof fetch
}

export interface KeyframeResult {
  filePath: string
  providerId: string
  model: string
  costCny: number
  dryRun: boolean
}

export interface KeyframeProvider {
  id: string
  /** 是否支持参考图（跨镜角色一致）。 */
  supportsReference: boolean
  isConfigured(): boolean
  generate(params: KeyframeGenParams): Promise<KeyframeResult>
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

function toDataUri(path: string): string {
  const ext = extname(path).toLowerCase()
  if (!IMG_EXTS.has(ext)) throw new Error('关键帧参考图仅支持 png/jpg/jpeg/webp')
  if (!existsSync(path) || statSync(path).size > IMG_MAX_BYTES) throw new Error('关键帧参考图缺失或过大（>10MB）')
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

const IMAGE_SIZE_MAP: Record<string, string> = { '9:16': '720x1280', '16:9': '1280x720', '1:1': '1024x1024', '3:4': '768x1024' }

/**
 * OpenAI 兼容关键帧 provider（Nano Banana / FLUX.1 Kontext / Qwen-Image 等，model 区分）。
 * 传参考图 → 编辑式跨镜角色一致；响应容错 images[].url / data[].url / data[].b64_json。
 */
export class OpenAiCompatibleKeyframeProvider implements KeyframeProvider {
  readonly supportsReference = true
  constructor(
    readonly id: string,
    private readonly cfg: { baseUrl: string; apiKey: string; model: string },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.apiKey && this.cfg.model)
  }

  async generate(params: KeyframeGenParams): Promise<KeyframeResult> {
    if (!this.isConfigured()) {
      throw new Error(`关键帧 provider「${this.id}」未配置：需 settings.studio.image.{baseUrl,apiKey,model}`)
    }
    const payload: Record<string, unknown> = {
      model: this.cfg.model,
      prompt: params.prompt,
      image_size: (params.aspectRatio && IMAGE_SIZE_MAP[params.aspectRatio]) || '720x1280',
    }
    const refs = (params.referenceImagePaths ?? []).filter((p) => p && p.trim()).map(toDataUri)
    if (refs.length === 1) payload.image = refs[0]
    else if (refs.length > 1) payload.image = refs // 多参考图（Nano Banana 支持角色一致融合）

    let res: Response
    try {
      res = await fetch(endpointUrl(this.cfg.baseUrl, '/images/generations'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`关键帧生成失败：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(`关键帧生成失败（HTTP ${res.status}）`)
    const body = (await res.json().catch(() => null)) as
      | { images?: Array<{ url?: string }>; data?: Array<{ url?: string; b64_json?: string }> }
      | null
    const url = body?.images?.[0]?.url || body?.data?.[0]?.url || ''
    const b64 = body?.data?.[0]?.b64_json || ''
    mkdirSync(resolve(params.outputPath, '..'), { recursive: true })
    if (url) {
      const dl = await fetchRemoteMediaToFile(url, params.outputPath, { maxBytes: IMG_MAX_BYTES, timeoutMs: GEN_TIMEOUT_MS, fetchFn: params.artifactFetchFn })
      if (!dl || dl.bytesWritten === 0) throw new Error('关键帧产物下载为空')
    } else if (b64) {
      writeFileSync(params.outputPath, Buffer.from(b64, 'base64'))
    } else {
      throw new Error('关键帧响应缺 url/b64_json')
    }
    return { filePath: params.outputPath, providerId: this.id, model: this.cfg.model, costCny: KEYFRAME_COST_CNY, dryRun: false }
  }
}

/** 按 settings.studio.image.kind 解析关键帧 provider。baseUrl/apiKey 留空回退 env(SILICONFLOW_*)。 */
export function resolveKeyframeProvider(): KeyframeProvider {
  const img = getStoredSettings().studio.image
  const cfg = {
    baseUrl: img.baseUrl?.trim() || process.env.SILICONFLOW_BASE_URL?.trim() || '',
    apiKey: img.apiKey?.trim() || process.env.SILICONFLOW_API_KEY?.trim() || '',
    model: img.model?.trim() || '',
  }
  // 全部走 OpenAI 兼容 /images/generations（model 区分供应商）；kind 仅作 provider id 标注。
  return new OpenAiCompatibleKeyframeProvider(img.kind || 'kolors', cfg)
}
