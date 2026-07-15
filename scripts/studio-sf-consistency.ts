#!/usr/bin/env bun
// [XJC] 漫剧·硅基流动 一致性攻坚测试（攻 PM 两大否决项：角色一致 + 画风统一）。安全默认不花钱。
//
// 思路（硅基流动能力内最大化一致性）：
//   1) Qwen/Qwen-Image 出「角色锚点」关键帧（统一 cel 画风）；
//   2) Qwen/Qwen-Image-Edit-2509 以锚点为参考，编辑式产出跨镜一致关键帧（同角色/同画风，换姿态/场景）；
//   3) 各一致关键帧作首帧 → Wan2.2-I2V 出 3 镜 draft；
//   4) Qwen3-VL-Instruct 对新/旧关键帧自动打分（画风/角色/场景一致性），给客观分对比上次。
// 硅基无原生 FLF2V → 镜内漂移根治仍需后续 Kling/Seedance；本轮重点是编辑式关键帧 + 自动质检。
//
//   dry-run（默认，不花钱）：            bun scripts/studio-sf-consistency.ts
//   真跑（真花钱，约 ¥7-8）：            XJC_CONFIRM=1 bun scripts/studio-sf-consistency.ts

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { updateSettings, getStoredSettings } from '../src/settings/manager.ts'
import { OpenAiCompatibleKeyframeProvider, resolveKeyframeProvider, KEYFRAME_COST_CNY } from '../src/studio/keyframeProvider.ts'
import { resizeToFrame } from '../src/studio/ffmpegUtils.ts'
import { studioRunDir } from '../src/media/video-provider.ts'
import { upsertShot, getShot } from '../src/studio/shotStore.ts'
import { renderShot } from '../src/studio/renderShot.ts'
import { scoreShotConsistency } from '../src/studio/vlmQc.ts'
import { recordCost, summarizeRunCost, getRunBudgetStatus, estimateVideoCny } from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const CONFIRM = process.env.XJC_CONFIRM === '1'
const runId = process.env.XJC_RUN_ID || `sf-consist-${Date.now().toString(36)}`
const agentId = 'studio-sf'
const baseUrl = (process.env.SILICONFLOW_BASE_URL || '').trim()
const apiKey = (process.env.SILICONFLOW_API_KEY || '').trim()

const IMG_BASE = 'Qwen/Qwen-Image'
const IMG_EDIT = 'Qwen/Qwen-Image-Edit-2509'
const VLM = 'Qwen/Qwen3-VL-30B-A3B-Instruct'
const VIDEO = 'Wan-AI/Wan2.2-I2V-A14B'

// 统一画风/角色设定（cel 日系动画、同一角色，攻一致性）
const STYLE = '日系 cel 动画风，干净线条，柔和光影，竖屏 9:16'
const CHAR = '一只橘白相间的小猫，圆脸大眼，右耳有一小缺口，戴红色小铃铛项圈'
const ANCHOR_PROMPT = `${CHAR}，坐在窗台上，${STYLE}`
const SHOTS = [
  { id: 'S1', scene: `${CHAR}，在窗台上伸懒腰，晨光，${STYLE}`, motion: '小猫在窗台缓缓伸懒腰，镜头轻微推进' },
  { id: 'S2', scene: `${CHAR}，从窗台跳下走向房间中央，${STYLE}`, motion: '小猫轻巧跳下窗台，镜头平移跟随' },
  { id: 'S3', scene: `${CHAR}，坐在地毯上抬头看镜头，${STYLE}`, motion: '小猫坐下抬头，轻微跟拍特写' },
]

// 配置 settings.studio 指向硅基可用模型
updateSettings({
  studio: {
    ...getStoredSettings().studio,
    image: { kind: 'qwen-image', baseUrl, apiKey, model: IMG_EDIT },
    qc: { enabled: true, baseUrl, apiKey, model: VLM, minScore: 70 },
    draft: { kind: 'wan', baseUrl, apiKey, model: VIDEO },
  },
})

const estCny = KEYFRAME_COST_CNY /*anchor*/ + KEYFRAME_COST_CNY * SHOTS.length /*edit kf*/ + estimateVideoCny('draft', SHOTS.length)
console.log('=== 硅基流动 一致性攻坚测试计划 ===')
console.log(JSON.stringify({
  runId, baseUrlSet: Boolean(baseUrl), apiKeySet: Boolean(apiKey),
  imageBase: IMG_BASE, imageEdit: IMG_EDIT, vlm: VLM, video: VIDEO,
  shots: SHOTS.length, estimateCny: estCny, budgetCap: getStoredSettings().studio.maxRenderCnyPerRun,
}, null, 2))

if (!baseUrl || !apiKey) { console.error('\n[ABORT] 缺 SILICONFLOW_BASE_URL/API_KEY（从 .env.local 注入到 shell env 再跑）。'); process.exit(1) }
if (!CONFIRM) {
  console.log('\n[DRY-RUN] 未设 XJC_CONFIRM=1 → 不联网、不花钱。真跑：XJC_CONFIRM=1 bun scripts/studio-sf-consistency.ts')
  process.exit(0)
}

process.env.XJC_STUDIO_VIDEO_MODE = 'live'
const framesDir = studioRunDir(runId, agentId, 'frames')
const base = (p: string | null | undefined) => p?.split(/[\\/]/).pop() ?? '-'

// 1) 角色锚点关键帧（Qwen-Image 基础 T2I）= 余额冒烟。可续跑：已存在则复用不重花。
console.log('\n[LIVE] 生成角色锚点关键帧（Qwen-Image，¥0.3）…')
const anchorPath = resolve(framesDir, 'anchor.png')
const anchorProvider = new OpenAiCompatibleKeyframeProvider('qwen-image', { baseUrl, apiKey, model: IMG_BASE })
if (existsSync(anchorPath)) {
  console.log('[SKIP] 锚点已存在，复用：', anchorPath)
} else {
  await anchorProvider.generate({ prompt: ANCHOR_PROMPT, aspectRatio: '9:16', outputPath: anchorPath })
  recordCost({ runId, shotId: 'anchor', kind: 'image', provider: 'siliconflow', model: IMG_BASE, costCny: KEYFRAME_COST_CNY, dryRun: false, status: 'ok', detail: '角色锚点' })
  console.log('[OK] 余额可用。锚点：', anchorPath)
}

// 2) 编辑式一致关键帧（Qwen-Image-Edit-2509，以锚点为参考）。已存在则复用（续跑省钱）。
const editProvider = resolveKeyframeProvider()
const kf: string[] = []
for (const shot of SHOTS) {
  const kfPath = resolve(framesDir, `${shot.id}_kf.png`)
  if (existsSync(kfPath)) {
    console.log(`[SKIP] ${shot.id} 一致关键帧已存在，复用。`)
  } else {
    console.log(`[LIVE] 一致关键帧 ${shot.id}（Qwen-Image-Edit，参考锚点，¥0.3）…`)
    await editProvider.generate({ prompt: shot.scene, referenceImagePaths: [anchorPath], aspectRatio: '9:16', outputPath: kfPath })
    recordCost({ runId, shotId: shot.id, kind: 'image', provider: 'siliconflow', model: IMG_EDIT, costCny: KEYFRAME_COST_CNY, dryRun: false, status: 'ok', detail: '编辑式一致关键帧' })
  }
  kf.push(kfPath)
}

// 3) 各一致关键帧作首帧 → Wan2.2 I2V 出 3 镜。已 done 复用；失败限次自动重试（Wan2.2 偶发 Failed 空 reason）。
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < SHOTS.length; i++) {
  const shot = SHOTS[i]!
  const existing = getShot(runId, shot.id)
  if (existing?.status === 'done' && existing.draftPath) { console.log(`[SKIP] ${shot.id} 已渲染，复用。`); continue }
  // Qwen-Image-Edit 输出 768x1360（忽略 image_size）→ 缩裁到 Wan2.2 要求的精确 720x1280，避免尺寸不符 Failed。
  const kfFramed = await resizeToFrame(kf[i]!, resolve(framesDir, `${shot.id}_kf_720.png`), 720, 1280)
  upsertShot({ runId, shotId: shot.id, shotIndex: i + 1, spec: { prompt: shot.motion, durationSec: 5, aspectRatio: '9:16' }, startPath: kfFramed })
  const MAX = 3
  for (let a = 1; a <= MAX; a++) {
    try {
      console.log(`[LIVE] 渲染 ${shot.id}（Wan2.2-I2V，首帧=一致关键帧，¥2，第 ${a}/${MAX} 次）…`)
      await renderShot({ runId, agentId, shotId: shot.id, tier: 'draft' })
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (a === MAX) throw new Error(`${shot.id} 渲染连续 ${MAX} 次失败：${msg}`)
      console.warn(`[RETRY] ${shot.id} 第 ${a} 次失败（${msg.slice(0, 80)}），3s 后重试…`)
      await sleep(3000)
    }
  }
}

// 4) VLM 质检：新关键帧 vs 锚点（画风/角色/场景一致性）
console.log('\n[QC] Qwen3-VL 对新关键帧打分…')
const newScores: Array<{ id: string; score: number; issues: string[] }> = []
for (let i = 0; i < SHOTS.length; i++) {
  const shot = SHOTS[i]!
  const s = await scoreShotConsistency({ imagePaths: [kf[i]!], prompt: shot.scene, referenceImagePaths: [anchorPath] })
  recordCost({ runId, shotId: shot.id, kind: 'vlm', provider: 'siliconflow', model: VLM, costCny: 0.01, dryRun: false, status: 'ok', detail: 'QC 新关键帧' })
  newScores.push({ id: shot.id, score: s.score, issues: s.issues })
  console.log(`  ${shot.id}: ${s.score} ${s.pass ? 'PASS' : 'FAIL'} ${s.issues.join('；')}`)
}

// 5) VLM 质检：旧样片关键帧（上次 sample run）作对比
const OLD_KF_DIR = resolve(process.env.DATA_DIR || './data', 'workspace', 'agents', 'studio-sample', '媒体产出')
const oldKfCandidates = ['img_20260714174649_xzls.png', 'img_20260714174654_vr49.png', 'img_20260714174658_b9f1.png'].map((n) => resolve(OLD_KF_DIR, n))
const oldScores: Array<{ file: string; score: number }> = []
if (oldKfCandidates.every((p) => existsSync(p))) {
  console.log('\n[QC] Qwen3-VL 对旧样片关键帧打分（对比）…')
  // 旧样片首张作参考，评估旧链一致性
  for (let i = 1; i < oldKfCandidates.length; i++) {
    const s = await scoreShotConsistency({ imagePaths: [oldKfCandidates[i]!], referenceImagePaths: [oldKfCandidates[0]!] })
    recordCost({ runId, shotId: `old${i}`, kind: 'vlm', provider: 'siliconflow', model: VLM, costCny: 0.01, dryRun: false, status: 'ok', detail: 'QC 旧样片' })
    oldScores.push({ file: base(oldKfCandidates[i]), score: s.score })
    console.log(`  old-${i}: ${s.score}`)
  }
} else {
  console.log('\n[QC] 旧样片关键帧未找到，跳过对比。')
}

// 汇总
console.log('\n=== 结果汇总 ===')
for (const shot of SHOTS) {
  const s = getShot(runId, shot.id)
  console.log(`  ${shot.id}: ${s?.status}  ${s?.draftPath}  start=${base(s?.startPath)}`)
}
const newAvg = newScores.length ? Math.round(newScores.reduce((a, b) => a + b.score, 0) / newScores.length) : 0
const oldAvg = oldScores.length ? Math.round(oldScores.reduce((a, b) => a + b.score, 0) / oldScores.length) : 0
console.log(`\nVLM 一致性均分：新=${newAvg}（明细 ${JSON.stringify(newScores)}）  旧=${oldAvg}（${JSON.stringify(oldScores)}）`)
console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
