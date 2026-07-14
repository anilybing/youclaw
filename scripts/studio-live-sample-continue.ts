#!/usr/bin/env bun
// [XJC] 漫剧样片续跑：rerunShot 重试失败的 S2（实测 P0.5 单镜重渲），成功则补齐 S3。安全默认不花钱。
//   XJC_SAMPLE_CONFIRM=1 [XJC_SAMPLE_RUN_ID=sample-xxxx] bun scripts/studio-live-sample-continue.ts
// S2 再失败 → 停(不跑 S3)，报诊断，别烧更多钱。

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { rerunShot } from '../src/workflow/runner.ts'
import { getWorkflowNodeTool, type WorkflowNodeContext } from '../src/workflow/nodes.ts'
import { getShot } from '../src/studio/shotStore.ts'
import { getRunBudgetStatus, summarizeRunCost } from '../src/studio/costLedger.ts'

loadEnv()
initLogger()
initDatabase()

const CONFIRM = process.env.XJC_SAMPLE_CONFIRM === '1'
const runId = process.env.XJC_SAMPLE_RUN_ID || 'sample-mrky0ur8'
const agentId = 'studio-sample'

console.log(`=== 样片续跑 runId=${runId} ===`)
if (!CONFIRM) {
  console.log('[DRY-RUN] 未设 XJC_SAMPLE_CONFIRM=1 → 不联网、不花钱。')
  process.exit(0)
}
process.env.XJC_STUDIO_VIDEO_MODE = 'live'

// 1) rerunShot 重试 S2（单镜重渲：只重跑 S2 不动 S1）
console.log('\n[LIVE] rerunShot(S2, draft) 单镜重渲（≈¥2）…')
try {
  const s2 = await rerunShot(runId, 'S2', 'draft', { confirmed: true, agentId })
  console.log('S2 重渲成功：', JSON.stringify(s2, null, 2))
} catch (err) {
  console.error('\n[S2 重试再次失败 = 持续性问题]', err instanceof Error ? err.message : String(err))
  console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
  console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
  console.log('[STOP] 不跑 S3，待诊断 provider（payload/参数/内审）。')
  process.exit(2)
}

// 2) 补齐 S3（前向连续：无首帧 → 继承 S2 尾帧 kfC）
const tool = getWorkflowNodeTool('studio_render_shot')
if (!tool) { console.error('[ABORT] studio_render_shot 未注册'); process.exit(1) }
const ctx: WorkflowNodeContext = {
  agentId, workflowId: 'anime-drama-studio-v1', workflowRunId: runId,
  traceId: 'sample', stepId: 'render_draft', stepIndex: 0, itemIndex: 3, signal: new AbortController().signal,
}
console.log('\n[LIVE] 渲染 S3（无首帧 → 继承 S2 尾帧 kfC，≈¥2）…')
try {
  await tool.execute({ shotId: 'S3', prompt: '橘猫跳下窗台走向镜头，轻微跟拍', shotIndex: '3', durationSec: '5', aspect: '9:16' }, ctx)
} catch (err) {
  console.error('\n[S3 失败]', err instanceof Error ? err.message : String(err))
}

// 3) 汇总
const shots = ['S1', 'S2', 'S3'].map((id) => getShot(runId, id))
console.log('\n=== 3 镜结果 ===')
for (const s of shots) {
  if (!s) continue
  console.log(`  ${s.shotId}: ${s.status}  ${s.draftPath ?? '(无)'}  start=${s.startPath?.split(/[\\/]/).pop() ?? '-'} end=${s.endPath?.split(/[\\/]/).pop() ?? '-'}`)
}
const [a, b, c] = shots
console.log('前向连续(end->start)：', JSON.stringify({
  'S1.end==S2.start': !!a && !!b && a.endPath === b.startPath,
  'S2.end==S3.start': !!b && !!c && b.endPath === c.startPath,
}, null, 2))
console.log('成本台账：', JSON.stringify(summarizeRunCost(runId), null, 2))
console.log('预算状态：', JSON.stringify(getRunBudgetStatus(runId), null, 2))
