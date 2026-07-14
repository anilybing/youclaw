#!/usr/bin/env bun
// [XJC] 漫剧 live 3 镜小样片脚本（安全默认：不花钱）。验「自动出片 → 前向连续(end→start) → 成本入账」。
//
// 默认 dry-run（打印计划+就绪度+预估¥，不联网不花钱）。真花钱：
//   XJC_SAMPLE_CONFIRM=1 bun scripts/studio-live-sample.ts
// 画幅 9:16（keyframe 传 image_size=720x1280）。3 镜 = 2 段 end→start 连续。预计 ≈¥6.9。

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getStoredSettings, updateSettings } from '../src/settings/manager.ts'
import { getMediaService } from '../src/media/service.ts'
import { resolveVideoProvider, studioVideoMode } from '../src/media/video-provider.ts'
import { getShot } from '../src/studio/shotStore.ts'
import { getWorkflowNodeTool, type WorkflowNodeContext } from '../src/workflow/nodes.ts'
import { estimateImageCny, estimateVideoCny, getRunBudgetStatus, recordCost, SILICONFLOW_COST_CNY, summarizeRunCost } from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const CONFIRM = process.env.XJC_SAMPLE_CONFIRM === '1'
const runId = process.env.XJC_SAMPLE_RUN_ID || `sample-${Date.now().toString(36)}`
const IMAGE_SIZE = '720x1280' // 9:16 竖屏
const agentId = 'studio-sample'
if (CONFIRM) process.env.XJC_STUDIO_VIDEO_MODE = 'live'

const studio = getStoredSettings().studio
const provider = resolveVideoProvider('draft')
const estCny = estimateVideoCny('draft', 3) + estimateImageCny(3)

console.log('=== 漫剧 live 3 镜样片计划（9:16）===')
console.log(JSON.stringify({
  mode: studioVideoMode(),
  videoProvider: provider.id,
  videoProviderConfigured: provider.isConfigured(),
  videoModel: studio.draftModel,
  imageSize: IMAGE_SIZE,
  budgetCnyCap: studio.maxRenderCnyPerRun,
  estimateCny: estCny,
  runId,
}, null, 2))

if (!CONFIRM) {
  console.log('\n[DRY-RUN] 未设 XJC_SAMPLE_CONFIRM=1 → 不联网、不花钱、不出片。')
  console.log('green-light 后：XJC_SAMPLE_CONFIRM=1 bun scripts/studio-live-sample.ts')
  process.exit(0)
}

if (!provider.isConfigured()) { console.error('\n[ABORT] live 视频 provider 未配置。'); process.exit(1) }

// 确保 media.image = SiliconFlow Kolors（冒烟已配则复用）
if (!getMediaService().status().imageConfigured) {
  const base = (process.env.SILICONFLOW_BASE_URL || '').trim()
  const key = (process.env.SILICONFLOW_API_KEY || '').trim()
  const imgModel = (process.env.XJC_SMOKE_IMAGE_MODEL || 'Kwai-Kolors/Kolors').trim()
  if (base && key) updateSettings({ media: { image: { provider: 'openai-compatible', baseUrl: base, apiKey: key, model: imgModel, editModel: '' }, video: getStoredSettings().media.video } })
  if (!getMediaService().status().imageConfigured) { console.error('\n[ABORT] media.image 未配置且自动配置失败。'); process.exit(1) }
}

// 1) 生成 3 张 9:16 关键帧（kfA=S1首帧，kfB=S1尾帧/S2首帧，kfC=S2尾帧/S3首帧）
const kfPrompts = [
  '竖屏动漫关键帧：清晨卧室，一只橘猫趴在窗台上，阳光洒入，日系动画风，干净背景',
  '竖屏动漫关键帧：橘猫在窗台上起身伸懒腰，晨光，日系动画风',
  '竖屏动漫关键帧：橘猫跳下窗台走向房间中央，日系动画风',
]
const media = getMediaService()
const kf: string[] = []
for (let i = 0; i < kfPrompts.length; i++) {
  console.log(`\n[LIVE] 生成关键帧 ${i + 1}/3（9:16，≈¥0.3）…`)
  const img = await media.generateImage(kfPrompts[i]!, agentId, { imageSize: IMAGE_SIZE })
  kf.push(img.filePath)
  recordCost({ runId, shotId: `S${i + 1}`, kind: 'image', provider: 'siliconflow', costCny: SILICONFLOW_COST_CNY.image, dryRun: false, status: 'ok', detail: `关键帧${i + 1}` })
  console.log('关键帧：', img.filePath)
}

// 2) 用 studio_render_shot 工具逐镜渲染（走 forEach 同款路径，验前向连续）
const tool = getWorkflowNodeTool('studio_render_shot')
if (!tool) { console.error('[ABORT] studio_render_shot 未注册'); process.exit(1) }
const ctx = (shotIndex: number): WorkflowNodeContext => ({
  agentId, workflowId: 'anime-drama-studio-v1', workflowRunId: runId,
  traceId: 'sample', stepId: 'render_draft', stepIndex: 0, itemIndex: shotIndex, signal: new AbortController().signal,
})

console.log('\n[LIVE] 渲染 S1（首帧 kfA，尾帧 kfB，≈¥2）…')
await tool.execute({ shotId: 'S1', prompt: '橘猫从趴卧到起身，镜头轻微推进，柔和晨光', shotIndex: '1', startPath: kf[0]!, lastFramePath: kf[1]!, durationSec: '5', aspect: '9:16' }, ctx(1))
console.log('[LIVE] 渲染 S2（无首帧→继承 S1 尾帧 kfB，尾帧 kfC，≈¥2）…')
await tool.execute({ shotId: 'S2', prompt: '橘猫伸懒腰后转身走动，镜头平移', shotIndex: '2', lastFramePath: kf[2]!, durationSec: '5', aspect: '9:16' }, ctx(2))
console.log('[LIVE] 渲染 S3（无首帧→继承 S2 尾帧 kfC，≈¥2）…')
await tool.execute({ shotId: 'S3', prompt: '橘猫跳下窗台走向镜头，轻微跟拍', shotIndex: '3', durationSec: '5', aspect: '9:16' }, ctx(3))

// 3) 验前向连续 + 汇总
const s1 = getShot(runId, 'S1')!
const s2 = getShot(runId, 'S2')!
const s3 = getShot(runId, 'S3')!
const continuity = {
  'S1.end==S2.start': s1.endPath === s2.startPath,
  'S2.end==S3.start': s2.endPath === s3.startPath,
  chain: [s1.startPath, s1.endPath, s2.endPath].map((p) => (p ? p.split(/[\\/]/).pop() : null)),
}
console.log('\n=== 3 镜样片结果 ===')
console.log('产物 mp4：')
for (const s of [s1, s2, s3]) console.log(`  ${s.shotId}: ${s.draftPath}  (start=${s.startPath?.split(/[\\/]/).pop()})`)
console.log('前向连续(end→start)：', JSON.stringify(continuity, null, 2))
console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
