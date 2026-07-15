// [XJC] 漫剧工作室·单镜渲染共享核（架构师 G0 契约 Q3 落地）
//
// resolveVideoProvider(tier) → provider.generate → shotStore 更新(draft_path/hq_path) + studio_cost_ledger 写入。
// 批量（studio_render_shot tool + forEach）与单镜（workflow 级 rerunShot API）共用本核，保证行为一致。
// 预算硬闸：仅 live 模式在渲染前按 tier 预估卡 ¥ 预算（mock/dry-run 免费、不计、不卡）。
// 前置：镜头规格须已在 shotStore（调用方先 upsertShot 落 spec/首尾帧）。

import { resolve } from 'node:path'
import {
  getShot,
  markShotFailed,
  markShotRendered,
  markShotRendering,
  normalizeTier,
  type ShotTier,
} from './shotStore.ts'
import { assertRunBudget, BudgetExceededError, estimateVideoCny, recordCost } from './costLedger.ts'
import { compressImageForUpload, extractLastFrame } from './ffmpegUtils.ts'
import {
  resolveVideoProvider,
  studioRunDir,
  studioVideoMode,
  type VideoGenParams,
} from '../media/video-provider.ts'

export interface RenderShotInput {
  runId: string
  agentId?: string | null
  shotId: string
  tier: ShotTier
  /** live 模式下：已获确认时可越过 ¥ 警戒线继续到硬顶 */
  allowNearLimit?: boolean
}

export interface RenderShotOutcome {
  runId: string
  shotId: string
  tier: ShotTier
  attempt: number
  provider: string
  model: string
  dryRun: boolean
  outputPath: string
  costUsd: number
  costCny: number
  credits: number
  durationMs: number
}

/**
 * 渲染单镜（共享核）。镜头须已在 shotStore。live 模式渲染前卡 ¥ 预算；mock 免费。
 * 成功→shotStore.markShotRendered + studio_cost_ledger(ok)；失败→markShotFailed + ledger(failed) 并抛错。
 * BudgetExceededError 原样抛出，供调用方回主控确认。
 */
export async function renderShot(input: RenderShotInput): Promise<RenderShotOutcome> {
  const runId = (input.runId ?? '').trim()
  const shotId = (input.shotId ?? '').trim()
  if (!runId || !shotId) throw new Error('renderShot 需要 runId 与 shotId')
  const tier = normalizeTier(input.tier)

  const shot = getShot(runId, shotId)
  if (!shot) throw new Error(`renderShot：镜头不存在 ${runId}/${shotId}（请先 upsertShot 落规格）`)

  const live = studioVideoMode() === 'live'
  const provider = resolveVideoProvider(tier)
  const { attempt } = markShotRendering(runId, shotId)

  try {
    // 真渲染前 ¥ 硬闸（mock 免费不卡）。BudgetExceededError 会被下方 catch 记账后原样抛出。
    if (live) assertRunBudget(runId, estimateVideoCny(tier, 1), { allowNearLimit: input.allowNearLimit })

    // live：首帧图超阈值先瘦身（SiliconFlow /video/submit base64 首帧字节阈值 ~1.4-1.5MB，超则秒失败）。
    // mock 忽略帧，不处理。best-effort：ffmpeg 不可用则用原图。
    const firstFramePath = live && shot.startPath ? await compressImageForUpload(shot.startPath) : shot.startPath
    const params: VideoGenParams = {
      prompt: String(shot.spec.prompt ?? ''),
      firstFramePath,
      lastFramePath: shot.endPath,
      durationSec: typeof shot.spec.durationSec === 'number' ? shot.spec.durationSec : null,
      aspectRatio: typeof shot.spec.aspectRatio === 'string' ? shot.spec.aspectRatio : null,
    }
    const outputDir = studioRunDir(runId, input.agentId, tier)
    const result = await provider.generate(params, { runId, agentId: input.agentId, shotId, tier, outputDir })

    // 项2 真前向连续（架构抽检 a 定案·方案1）：仅「无原生首尾帧」的 provider(如 wan，result.endPath 为空)
    // 在 live 渲染成功后用 ffmpeg 抽真实末帧作 end_path（供下镜 start 继承）。原生首尾帧 provider(如 Kling)
    // 已回传 endPath=传入尾帧 → 直接用、不冗余抽帧（尊重 supportsLastFrame 语义）。mock live=false 不抽。
    let endPath = result.endPath
    if (live && !endPath && result.filePath) {
      const endFrame = await extractLastFrame(result.filePath, resolve(studioRunDir(runId, input.agentId, 'frames'), `${shotId}_end.png`))
      if (endFrame) endPath = endFrame
    }
    markShotRendered(runId, shotId, {
      tier,
      outputPath: result.filePath,
      provider: result.providerId,
      endPath,
    })
    recordCost({
      runId, shotId, kind: 'video', provider: result.providerId, model: result.model, tier,
      credits: result.credits, costUsd: result.costUsd, costCny: result.costCny,
      durationMs: result.durationMs, attempt, dryRun: result.dryRun, status: 'ok',
    })
    return {
      runId, shotId, tier, attempt,
      provider: result.providerId, model: result.model, dryRun: result.dryRun,
      outputPath: result.filePath, costUsd: result.costUsd, costCny: result.costCny,
      credits: result.credits, durationMs: result.durationMs,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    markShotFailed(runId, shotId, message, tier)
    // 失败/被预算阻断都记一行（¥0），便于审计；不计入真实花费（dryRun 标记为 !live）。
    recordCost({
      runId, shotId, kind: 'video', provider: provider.id, tier,
      credits: 0, costUsd: 0, costCny: 0, attempt, dryRun: !live, status: 'failed', detail: message,
    })
    if (err instanceof BudgetExceededError) throw err
    throw new Error(`renderShot 渲染失败（${shotId}）：${message}`)
  }
}
