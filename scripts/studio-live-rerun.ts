#!/usr/bin/env bun
// [XJC] 通用单镜重渲（rerunShot）。用于恢复 SiliconFlow I2V 偶发失败的某一镜。安全默认不花钱。
//   XJC_SAMPLE_CONFIRM=1 XJC_SAMPLE_RUN_ID=sample-xxxx XJC_RERUN_SHOT=S3 [XJC_RERUN_TIER=draft] bun scripts/studio-live-rerun.ts

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { rerunShot } from '../src/workflow/runner.ts'
import { getShot } from '../src/studio/shotStore.ts'
import { getRunBudgetStatus, summarizeRunCost } from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const CONFIRM = process.env.XJC_SAMPLE_CONFIRM === '1'
const runId = process.env.XJC_SAMPLE_RUN_ID || 'sample-mrky0ur8'
const shotId = process.env.XJC_RERUN_SHOT || 'S3'
const tier = (process.env.XJC_RERUN_TIER === 'hq' ? 'hq' : 'draft') as 'draft' | 'hq'
const agentId = 'studio-sample'

console.log(`=== 单镜重渲 run=${runId} shot=${shotId} tier=${tier} ===`)
if (!CONFIRM) { console.log('[DRY-RUN] 未设 XJC_SAMPLE_CONFIRM=1 → 不联网、不花钱。'); process.exit(0) }
process.env.XJC_STUDIO_VIDEO_MODE = 'live'

try {
  const out = await rerunShot(runId, shotId, tier, { confirmed: true, agentId })
  console.log('重渲成功：', JSON.stringify(out, null, 2))
} catch (err) {
  console.error('[重渲失败]', err instanceof Error ? err.message : String(err))
}
const s = getShot(runId, shotId)
console.log('镜头状态：', s ? `${s.shotId} ${s.status} ${s.draftPath ?? '(无)'}` : '(不存在)')
console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
