#!/usr/bin/env bun
// [XJC] 漫剧 run 镜头状态/连续性/成本速查（只读，不花钱）。
//   [XJC_SAMPLE_RUN_ID=sample-xxxx] bun scripts/studio-shot-status.ts

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getShot, listShots } from '../src/studio/shotStore.ts'
import { getRunBudgetStatus, summarizeRunCost } from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const runId = process.env.XJC_SAMPLE_RUN_ID || 'sample-mrky0ur8'
const base = (p: string | null | undefined): string => p?.split(/[\\/]/).pop() ?? '-'

console.log(`=== run=${runId} 镜头台账 ===`)
for (const s of listShots(runId)) {
  console.log(`  ${s.shotId}: ${s.status}  draft=${base(s.draftPath)}  start=${base(s.startPath)}  end=${base(s.endPath)}  attempts=${s.attemptCount}`)
}

const a = getShot(runId, 'S1')
const b = getShot(runId, 'S2')
const c = getShot(runId, 'S3')
console.log('\n=== 真前向连续校验（下镜 start 应 === 上镜 end 真末帧）===')
if (a && b) console.log(`  S2.start === S1.end : ${b.startPath === a.endPath}  [${base(b.startPath)} vs ${base(a.endPath)}]`)
if (b && c) console.log(`  S3.start === S2.end : ${c.startPath === b.endPath}  [${base(c.startPath)} vs ${base(b.endPath)}]`)

console.log('\n成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
