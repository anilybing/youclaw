#!/usr/bin/env bun
// [XJC] 项2 真前向连续补跑：保留 S1，抽 S1 真实末帧→S2 起始→重渲 S2（自动抽 S2 真末帧）→S3 起始→重渲 S3。
// 根治「伪连续」（旧 end_path=预生成关键帧≠真末帧）。安全默认不花钱。
//   XJC_SAMPLE_CONFIRM=1 [XJC_SAMPLE_RUN_ID=sample-xxxx] bun scripts/studio-live-continuity.ts

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { resolve } from 'node:path'
import { rerunShot } from '../src/workflow/runner.ts'
import { getShot, upsertShot } from '../src/studio/shotStore.ts'
import { extractLastFrame } from '../src/studio/ffmpegUtils.ts'
import { studioRunDir } from '../src/media/video-provider.ts'
import { getRunBudgetStatus, summarizeRunCost } from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const CONFIRM = process.env.XJC_SAMPLE_CONFIRM === '1'
const runId = process.env.XJC_SAMPLE_RUN_ID || 'sample-mrky0ur8'
const agentId = 'studio-sample'
const base = (p: string | null | undefined) => p?.split(/[\\/]/).pop() ?? '-'

console.log(`=== 项2 真前向连续补跑 run=${runId} ===`)
if (!CONFIRM) { console.log('[DRY-RUN] 未设 XJC_SAMPLE_CONFIRM=1 → 不联网不花钱。'); process.exit(0) }
process.env.XJC_STUDIO_VIDEO_MODE = 'live'

const framesDir = studioRunDir(runId, agentId, 'frames')

// 1) 抽 S1 真实末帧（S1 已存在、旧渲染无自动抽）→ 写回 S1.end + 作 S2 起始
const s1 = getShot(runId, 'S1')
if (!s1?.draftPath) { console.error('[ABORT] S1 未就绪（无 draftPath）'); process.exit(1) }
console.log('[FFMPEG] 抽 S1 真实末帧…')
const s1End = await extractLastFrame(s1.draftPath, resolve(framesDir, 'S1_end_real.png'))
if (!s1End) { console.error('[ABORT] 抽 S1 末帧失败（ffmpeg?）'); process.exit(1) }
console.log('S1 真末帧：', s1End)
upsertShot({ runId, shotId: 'S1', endPath: s1End })   // S1.end = 真末帧（替代占位 kfB）
upsertShot({ runId, shotId: 'S2', startPath: s1End })  // S2.start = S1 真末帧

// 2) 重渲 S2（起=S1真末帧；renderShot 渲染成功后自动抽 S2 真末帧写 end_path）
console.log('[LIVE] 重渲 S2（起=S1真末帧，≈¥2）…')
const r2 = await rerunShot(runId, 'S2', 'draft', { confirmed: true, agentId })
console.log('S2:', JSON.stringify(r2, null, 2))

// 3) S3 起始 = S2 真末帧（已由 renderShot 覆盖 S2.end_path）→ 重渲 S3
const s2 = getShot(runId, 'S2')
if (!s2?.endPath) { console.error('[ABORT] S2 真末帧缺失（抽帧失败？）'); process.exit(1) }
upsertShot({ runId, shotId: 'S3', startPath: s2.endPath })
console.log('[LIVE] 重渲 S3（起=S2真末帧，≈¥2）…')
const r3 = await rerunShot(runId, 'S3', 'draft', { confirmed: true, agentId })
console.log('S3:', JSON.stringify(r3, null, 2))

// 4) 校验真连续 + 汇总
const a = getShot(runId, 'S1')!
const b = getShot(runId, 'S2')!
const c = getShot(runId, 'S3')!
console.log('\n=== 真前向连续校验（start 应 === 上镜真实末帧）===')
console.log(`S2.start === S1.end(真末帧)：${b.startPath === a.endPath}  [${base(b.startPath)} vs ${base(a.endPath)}]`)
console.log(`S3.start === S2.end(真末帧)：${c.startPath === b.endPath}  [${base(c.startPath)} vs ${base(b.endPath)}]`)
console.log('\n3 镜产物：')
for (const s of [a, b, c]) console.log(`  ${s.shotId}: ${s.status}  ${s.draftPath}  start=${base(s.startPath)} end=${base(s.endPath)}`)
console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
