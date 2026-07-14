#!/usr/bin/env bun
// [XJC] 漫剧 live 出片冒烟脚本（安全默认：不花钱）。
//
// 用途：controller/用户 green-light 后，用「1 镜真出片」验证 SiliconFlow live 通路（约 ¥2，含首帧图约 ¥0.3）。
// 安全默认：不带 XJC_SMOKE_CONFIRM=1 时只打印计划 + 就绪度 + 预估 ¥，绝不联网/出片/花钱。
//
// green-light 后（真花钱）：
//   XJC_SMOKE_CONFIRM=1 XJC_SMOKE_GEN_IMAGE=1 bun scripts/studio-live-smoke.ts        # 现生首帧图(¥0.3)+出视频(¥2)
//   XJC_SMOKE_CONFIRM=1 XJC_SMOKE_IMAGE=<首帧.png> bun scripts/studio-live-smoke.ts    # 用已有首帧，仅出视频(¥2)
// 可选：XJC_SMOKE_RUN_ID=<runId> 复用同一 run 的成本台账。videoRenderMode 由本脚本在确认时置 live（仅本进程）。

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getStoredSettings, updateSettings } from '../src/settings/manager.ts'
import { getMediaService } from '../src/media/service.ts'
import { resolveVideoProvider, studioVideoMode } from '../src/media/video-provider.ts'
import { upsertShot } from '../src/studio/shotStore.ts'
import { renderShot } from '../src/studio/renderShot.ts'
import {
  estimateImageCny,
  estimateVideoCny,
  getRunBudgetStatus,
  recordCost,
  SILICONFLOW_COST_CNY,
  summarizeRunCost,
} from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const CONFIRM = process.env.XJC_SMOKE_CONFIRM === '1'
const GEN_IMAGE = process.env.XJC_SMOKE_GEN_IMAGE === '1'
const runId = process.env.XJC_SMOKE_RUN_ID || `smoke-${Date.now().toString(36)}`
let firstFrame = (process.env.XJC_SMOKE_IMAGE || '').trim()
const tier = 'draft' as const

if (CONFIRM) process.env.XJC_STUDIO_VIDEO_MODE = 'live'

const studio = getStoredSettings().studio
const provider = resolveVideoProvider(tier)
const mediaStatus = getMediaService().status()
const willGenImage = !firstFrame && GEN_IMAGE
const estCny = estimateVideoCny(tier, 1) + (willGenImage ? estimateImageCny(1) : 0)

console.log('=== 漫剧 live 出片冒烟计划 ===')
console.log(JSON.stringify({
  mode: studioVideoMode(),
  videoProvider: provider.id,
  videoProviderConfigured: provider.isConfigured(),
  videoModel: studio.draftModel,
  imageConfigured: mediaStatus.imageConfigured,
  genImage: willGenImage,
  budgetCnyCap: studio.maxRenderCnyPerRun,
  estimateCny: estCny,
  runId,
  firstFrame: firstFrame || (willGenImage ? '(将现生成)' : '(未提供；I2V 需首帧 → 设 XJC_SMOKE_IMAGE 或 XJC_SMOKE_GEN_IMAGE=1)'),
}, null, 2))

if (!CONFIRM) {
  console.log('\n[DRY-RUN] 未设 XJC_SMOKE_CONFIRM=1 → 不联网、不花钱、不出片。')
  console.log('green-light 后：XJC_SMOKE_CONFIRM=1 XJC_SMOKE_GEN_IMAGE=1 bun scripts/studio-live-smoke.ts')
  process.exit(0)
}

if (!provider.isConfigured()) {
  console.error('\n[ABORT] live 视频 provider 未配置（缺 SILICONFLOW_BASE_URL/API_KEY 或 studio.draftModel）。')
  process.exit(1)
}

// 1) 首帧图：现生成（¥0.3）或用已有
if (willGenImage) {
  if (!mediaStatus.imageConfigured) {
    // 冒烟自动配置 media.image = SiliconFlow Kolors（对齐主控「图像走 Kolors/便宜档」）。仅本机 DB。
    const base = (process.env.SILICONFLOW_BASE_URL || '').trim()
    const key = (process.env.SILICONFLOW_API_KEY || '').trim()
    const imgModel = (process.env.XJC_SMOKE_IMAGE_MODEL || 'Kwai-Kolors/Kolors').trim()
    if (base && key) {
      updateSettings({ media: { image: { provider: 'openai-compatible', baseUrl: base, apiKey: key, model: imgModel, editModel: '' }, video: getStoredSettings().media.video } })
      console.log(`[SETUP] 已按 SiliconFlow ${imgModel} 配置 media.image（冒烟用）。`)
    }
    if (!getMediaService().status().imageConfigured) {
      console.error('\n[ABORT] media.image 未配置且自动配置失败（缺 SILICONFLOW_BASE_URL/API_KEY）。可改用 XJC_SMOKE_IMAGE=<已有 png>。')
      process.exit(1)
    }
  }
  console.log('\n[LIVE] 生成首帧关键帧图（≈¥0.3）…')
  const img = await getMediaService().generateImage(
    '竖屏 9:16 漫剧关键帧：一只橘猫在窗边伸懒腰，柔和晨光，日系动画风，干净背景',
    'studio-smoke',
  )
  firstFrame = img.filePath
  recordCost({ runId, shotId: 'SMOKE1', kind: 'image', provider: 'siliconflow', costCny: SILICONFLOW_COST_CNY.image, dryRun: false, status: 'ok', detail: '冒烟首帧图' })
  console.log('首帧图产物：', firstFrame)
}
if (!firstFrame) {
  console.error('\n[ABORT] I2V 需首帧图：设 XJC_SMOKE_IMAGE=<本机 png/jpg> 或 XJC_SMOKE_GEN_IMAGE=1。')
  process.exit(1)
}

// 2) 出 1 镜 draft 视频（¥ 预算硬闸兜底）
console.log('\n[LIVE] 开始 1 镜真出片（draft，≈¥2）…')
upsertShot({
  runId,
  shotId: 'SMOKE1',
  shotIndex: 1,
  spec: { prompt: '橘猫在窗边缓缓伸懒腰，镜头轻微推进，柔和晨光', durationSec: 5, aspectRatio: '9:16' },
  startPath: firstFrame,
})
const outcome = await renderShot({ runId, shotId: 'SMOKE1', tier })

console.log('\n渲染完成：', JSON.stringify(outcome, null, 2))
console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
console.log('\n[OK] 冒烟完成。视频产物：', outcome.outputPath)
if (firstFrame) console.log('[OK] 首帧图：', firstFrame)
