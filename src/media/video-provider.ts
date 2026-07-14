// [XJC] 漫剧工作室·视频渲染 Provider 抽象（架构师 G0 契约 Q1/Q5 落地）
//
// 契约：VideoProvider{id,supportsLastFrame,isConfigured,generate(params,ctx)}；路由表
// {draft:wan, hq:kling} + mock/live 开关 + baseUrl/apiKey/model = settings.studio；videoRenderMode
// 默认 mock（不联网不烧钱），env XJC_STUDIO_VIDEO_MODE 仅 CI/dry-run 覆盖；MockVideoProvider 零网络
// 出占位 mp4 为 M1 落点；产物落 per-run 专用目录（Q5：漫剧产出/<runId>/{frames,draft,hq}，不走
// 「媒体产出」的 200 文件自动清理）。
//
// M1（本里程碑）：mock/dry-run 全链路可跑并单测。live（OpenAiCompatibleVideoProvider）待 M2 极小
// 样片接入真出片——interface/路由/开关此处齐备，generate() 真调用体在 M2 打开（详见该类注释）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { getPaths } from '../config/paths.ts'
import { getStoredSettings } from '../settings/manager.ts'
import { fetchRemoteMediaToFile } from '../channel/media-fetch.ts'
import { getLogger } from '../logger/index.ts'

export type VideoTier = 'draft' | 'hq'

const VIDEO_SUBMIT_TIMEOUT_MS = 30_000
const VIDEO_POLL_INTERVAL_MS = 5_000
const VIDEO_POLL_MAX_MS = 10 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 120_000
const GENERATED_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const VIDEO_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const VIDEO_INPUT_IMAGE_EXTS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

/** 单镜渲染入参（provider 无关；首尾帧为「首尾帧连续」项2 的载体） */
export interface VideoGenParams {
  prompt: string
  /** 首帧（图生视频输入） */
  firstFramePath?: string | null
  /** 尾帧（FLF 首尾帧；SiliconFlow 无原生 FLF2V → 兼底走前向 I2V，见路线图） */
  lastFramePath?: string | null
  durationSec?: number | null
  aspectRatio?: string | null
  model?: string | null
  seed?: number | null
}

/** 渲染上下文：per-run 输出目录由调用方给定（Q5：与对话式「媒体产出」隔离、不清理） */
export interface VideoGenContext {
  runId: string
  agentId?: string | null
  shotId: string
  tier: VideoTier
  outputDir: string
  signal?: AbortSignal
  /** 仅供确定性测试注入产物下载 fetch；生产留空走 pinned-http（DNS pinning + SSRF）。 */
  artifactFetchFn?: typeof fetch
}

/** 渲染结果（含成本口径，供 studio_cost_ledger 归集）。costUsd 为契约字段，costCny 为 ¥ 预算硬闸口径。 */
export interface VideoGenResult {
  filePath: string
  providerId: string
  model: string
  costUsd: number
  costCny: number
  credits: number
  durationMs: number
  dryRun: boolean
  /** 尾帧产物路径（mock/前向 I2V 无独立尾帧 → null；真 FLF provider 可回传） */
  endPath: string | null
  meta: Record<string, unknown>
}

export interface VideoProvider {
  id: string
  supportsLastFrame: boolean
  isConfigured(): boolean
  generate(params: VideoGenParams, ctx: VideoGenContext): Promise<VideoGenResult>
}

/**
 * per-run 工作室输出目录：agents/<agentId>/漫剧产出/<runId>/<sub...>；无 agentId 时落
 * workspace/漫剧产出/<runId>。刻意独立于「媒体产出」——后者有 200 文件 mtime 自动清理，
 * 漫剧多镜×(draft+hq+重试)+帧会误删。此目录不做文件级清理（run 粒度保留另行治理）。
 */
export function studioRunDir(runId: string, agentId?: string | null, ...sub: string[]): string {
  const rid = (runId ?? '').trim() || 'run-unknown'
  const base = agentId?.trim()
    ? resolve(getPaths().agents, agentId.trim(), '漫剧产出', rid)
    : resolve(getPaths().workspace, '漫剧产出', rid)
  const dir = sub.length > 0 ? resolve(base, ...sub) : base
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 档位成本口径：mock 名义 / live 真实预估。¥ 对齐 SiliconFlow：draft 5s≈¥2($0.29)，hq 占位 ¥6。 */
export const TIER_COST: Record<VideoTier, { credits: number; costUsd: number; costCny: number }> = {
  draft: { credits: 4, costUsd: 0.29, costCny: 2 },
  hq: { credits: 20, costUsd: 0.86, costCny: 6 },
}

function sanitizeSegment(value: string): string {
  return (value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'shot'
}

/**
 * mock/dry-run provider：不联网、不烧钱。写占位 mp4 + 同名 meta.json 到 per-run 目录，返回名义成本。
 * 用于把全链路管路（批量/单镜重渲/cost_ledger/预算闸）跑通并单测。
 */
export class MockVideoProvider implements VideoProvider {
  readonly id = 'mock'
  readonly supportsLastFrame = true // mock 直接把入参尾帧当已连续，用于验证连续链路

  isConfigured(): boolean {
    return true
  }

  async generate(params: VideoGenParams, ctx: VideoGenContext): Promise<VideoGenResult> {
    const tier: VideoTier = ctx.tier === 'hq' ? 'hq' : 'draft'
    const cost = TIER_COST[tier]
    mkdirSync(ctx.outputDir, { recursive: true }) // 防御：调用方一般已由 studioRunDir 建目录
    const stem = `${sanitizeSegment(ctx.shotId)}_${tier}`
    const outputPath = resolve(ctx.outputDir, `${stem}.mp4`)
    const metaPath = resolve(ctx.outputDir, `${stem}.meta.json`)
    const model = params.model?.trim() || `mock-${tier}`
    const meta: Record<string, unknown> = {
      runId: ctx.runId,
      shotId: ctx.shotId,
      tier,
      provider: this.id,
      model,
      dryRun: true,
      prompt: params.prompt,
      firstFramePath: params.firstFramePath ?? null,
      lastFramePath: params.lastFramePath ?? null,
      durationSec: params.durationSec ?? null,
      aspectRatio: params.aspectRatio ?? null,
      credits: cost.credits,
      costUsd: cost.costUsd,
      costCny: cost.costCny,
      outputPath,
      renderedAt: new Date().toISOString(),
    }
    writeFileSync(outputPath, `# XiaoJuClaw mock ${tier} render (dry-run, no spend)\n${JSON.stringify(meta, null, 2)}\n`)
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    return {
      filePath: outputPath,
      providerId: this.id,
      model,
      costUsd: cost.costUsd,
      costCny: cost.costCny,
      credits: cost.credits,
      durationMs: 0,
      dryRun: true,
      endPath: null,
      meta,
    }
  }
}

/** live 端点/密钥解析：settings.studio 优先，回退 env（SILICONFLOW_*）。 */
function resolveLiveConfig(tier: VideoTier): { baseUrl: string; apiKey: string; model: string } {
  const s = getStoredSettings().studio
  const baseUrl = (s.baseUrl?.trim() || process.env.SILICONFLOW_BASE_URL?.trim() || '')
  const apiKey = (s.apiKey?.trim() || process.env.SILICONFLOW_API_KEY?.trim() || '')
  const model = ((tier === 'hq' ? s.hqModel : s.draftModel)?.trim() || '')
  return { baseUrl, apiKey, model }
}

/**
 * OpenAI 兼容（SiliconFlow）真视频 provider：submit → poll status → 下载落 per-run 目录。
 * SiliconFlow 核验：Wan-AI/Wan2.2-I2V-A14B（I2V，画幅按输入图自动匹配），异步 submit/poll，5s≈¥2；
 * 无原生 FLF2V → 项2 走前向 I2V 兼底（本 provider supportsLastFrame=false；尾帧连续由 pipeline 用
 * end[n]→start[n+1] 绑定，provider 侧只吃首帧做 I2V）。
 *
 * 安全：仅当 settings.studio.videoRenderMode=live 时才会被 resolveVideoProvider 返回；默认 mock，¥0。
 * 真花钱前另有 gate_video 审批 + ¥ 预算硬闸兜底。真样片验证走 M2 极小样片（controller green-light 后 flip live）。
 */
export class OpenAiCompatibleVideoProvider implements VideoProvider {
  readonly supportsLastFrame = false
  constructor(readonly id: string, private readonly tier: VideoTier) {}

  isConfigured(): boolean {
    const cfg = resolveLiveConfig(this.tier)
    return Boolean(cfg.baseUrl && cfg.apiKey && cfg.model)
  }

  async generate(params: VideoGenParams, ctx: VideoGenContext): Promise<VideoGenResult> {
    const cfg = resolveLiveConfig(this.tier)
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      throw new Error(`live 视频 provider「${this.id}」未配置：需 settings.studio（或 env SILICONFLOW_BASE_URL/API_KEY）+ ${this.tier} 档模型`)
    }
    const throwIfCancelled = () => { if (ctx.signal?.aborted) throw new Error('视频生成已取消') }
    throwIfCancelled()
    mkdirSync(ctx.outputDir, { recursive: true })
    const startedAt = Date.now()

    const payload: Record<string, unknown> = { model: cfg.model, prompt: params.prompt }
    // image_size 是 SiliconFlow /video/submit 的必填项（枚举 1280x720 | 720x1280 | 960x960）；
    // I2V/T2V 都必须带——之前 I2V 漏传导致服务端偶发 Failed(空 reason)。默认竖屏 720x1280。
    const sizeMap: Record<string, string> = { '9:16': '720x1280', '16:9': '1280x720', '1:1': '960x960' }
    payload.image_size = (params.aspectRatio && sizeMap[params.aspectRatio]) ? sizeMap[params.aspectRatio] : '720x1280'
    // I2V：首帧转 base64（前向 I2V 兼底 —— SiliconFlow 无原生 FLF2V，lastFramePath 不作 provider 入参）
    if (params.firstFramePath) {
      const ext = extname(params.firstFramePath).toLowerCase()
      if (!VIDEO_INPUT_IMAGE_EXTS.has(ext)) throw new Error('图生视频输入仅支持 png/jpg/jpeg/webp')
      const bytes = readFileSync(params.firstFramePath)
      if (bytes.byteLength > VIDEO_INPUT_IMAGE_MAX_BYTES) throw new Error('图生视频输入图过大（>10MB）')
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
      payload.image = `data:${mime};base64,${bytes.toString('base64')}`
    }

    let submitRes: Response
    try {
      submitRes = await fetch(endpointUrl(cfg.baseUrl, '/video/submit'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(VIDEO_SUBMIT_TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`视频提交失败：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!submitRes.ok) throw new Error(`视频提交失败（HTTP ${submitRes.status}）`)
    const submitBody = (await submitRes.json().catch(() => null)) as { requestId?: string } | null
    const requestId = submitBody?.requestId
    if (!requestId) throw new Error('视频提交返回缺 requestId')

    const deadline = startedAt + VIDEO_POLL_MAX_MS
    // 轮询间隔可由 env 覆盖（仅 CI/单测把 5s 压到毫秒级；生产保持 5s）。
    const pollIntervalMs = Number(process.env.XJC_VIDEO_POLL_MS) > 0 ? Number(process.env.XJC_VIDEO_POLL_MS) : VIDEO_POLL_INTERVAL_MS
    let videoUrl = ''
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs))
      throwIfCancelled()
      let statusRes: Response
      try {
        statusRes = await fetch(endpointUrl(cfg.baseUrl, '/video/status'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(VIDEO_SUBMIT_TIMEOUT_MS),
        })
      } catch { continue }
      if (!statusRes.ok) continue
      const sb = (await statusRes.json().catch(() => null)) as
        | { status?: string; reason?: string; results?: { videos?: Array<{ url?: string }> } }
        | null
      const st = String(sb?.status ?? '').toLowerCase()
      if (st === 'succeed' || st === 'succeeded' || st === 'success') {
        videoUrl = sb?.results?.videos?.[0]?.url ?? ''
        break
      }
      if (st === 'failed' || st === 'fail') {
        // reason 常为空 → 附完整 status body，便于诊断（限长）。
        const detail = (sb?.reason && sb.reason.trim()) ? sb.reason.trim() : JSON.stringify(sb ?? {}).slice(0, 500)
        throw new Error(`视频生成失败：${detail || '供应商未给原因'}`)
      }
    }
    if (!videoUrl) throw new Error('视频生成超时或未返回结果 URL（上限 10 分钟）')

    const stem = `${sanitizeSegment(ctx.shotId)}_${this.tier}`
    const filePath = resolve(ctx.outputDir, `${stem}.mp4`)
    const dl = await fetchRemoteMediaToFile(videoUrl, filePath, {
      maxBytes: GENERATED_VIDEO_MAX_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      fetchFn: ctx.artifactFetchFn,
    })
    if (!dl || dl.bytesWritten === 0) throw new Error('视频产物下载为空')

    const cost = TIER_COST[this.tier]
    getLogger().info(
      { runId: ctx.runId, shotId: ctx.shotId, tier: this.tier, provider: this.id, model: cfg.model, category: 'studio' },
      'Studio live video rendered',
    )
    return {
      filePath,
      providerId: this.id,
      model: cfg.model,
      costUsd: cost.costUsd,
      costCny: cost.costCny,
      credits: cost.credits,
      durationMs: Date.now() - startedAt,
      dryRun: false,
      endPath: null,
      meta: { runId: ctx.runId, shotId: ctx.shotId, tier: this.tier, model: cfg.model, requestId },
    }
  }
}

/** 当前视频渲染模式：env XJC_STUDIO_VIDEO_MODE（仅 CI/dry-run 覆盖）> settings.studio.videoRenderMode > mock。 */
export function studioVideoMode(): 'mock' | 'live' {
  const envMode = (process.env.XJC_STUDIO_VIDEO_MODE ?? '').trim().toLowerCase()
  if (envMode === 'mock' || envMode === 'live') return envMode
  try {
    return getStoredSettings().studio.videoRenderMode
  } catch {
    return 'mock'
  }
}

/**
 * 按 tier 解析 VideoProvider：mock 模式恒返回 MockVideoProvider；live 模式按路由表
 * {draft:draftProvider, hq:hqProvider} 返回 OpenAiCompatibleVideoProvider。
 */
export function resolveVideoProvider(tier: VideoTier): VideoProvider {
  if (studioVideoMode() === 'mock') return new MockVideoProvider()
  const s = getStoredSettings().studio
  const providerId = (tier === 'hq' ? s.hqProvider : s.draftProvider) || (tier === 'hq' ? 'kling' : 'wan')
  return new OpenAiCompatibleVideoProvider(providerId, tier)
}
