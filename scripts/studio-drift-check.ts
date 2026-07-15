#!/usr/bin/env bun
// [XJC] 镜内漂移客观分析：抽每镜视频 首帧 vs 末帧，VLM 打分「同镜内 画风/角色一致性」。
// 直击 PM 否决项（镜内 cel→3D/角色漂移）——keyframe QC 测不到，须比对同镜首末帧。ffmpeg 免费 + VLM ~¥0.01/次。
//   XJC_RUN_ID=sf-consist-xxxx bun scripts/studio-drift-check.ts

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { getStoredSettings, updateSettings } from '../src/settings/manager.ts'
import { studioRunDir } from '../src/media/video-provider.ts'
import { getShot } from '../src/studio/shotStore.ts'
import { extractLastFrame } from '../src/studio/ffmpegUtils.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scoreShotConsistency } from '../src/studio/vlmQc.ts'
import { recordCost } from '../src/studio/costLedger.ts'

const execFileAsync = promisify(execFile)
loadEnv(); initLogger(); initDatabase()

const runId = process.env.XJC_RUN_ID || 'sf-consist-mrld7wum'
const agentId = 'studio-sf'
const baseUrl = (process.env.SILICONFLOW_BASE_URL || '').trim()
const apiKey = (process.env.SILICONFLOW_API_KEY || '').trim()
const ff = process.env.XJC_FFMPEG_PATH?.trim() || 'ffmpeg'

// 确保 QC 开启并指向硅基 VLM
updateSettings({ studio: { ...getStoredSettings().studio, qc: { enabled: true, baseUrl, apiKey, model: 'Qwen/Qwen3-VL-30B-A3B-Instruct', minScore: 70 } } })

async function firstFrame(video: string, out: string): Promise<string | null> {
  try {
    await execFileAsync(ff, ['-y', '-i', video, '-vframes', '1', '-q:v', '2', out])
    return existsSync(out) ? out : null
  } catch { return null }
}

const framesDir = studioRunDir(runId, agentId, 'drift')
console.log(`=== 镜内漂移客观分析 run=${runId} ===`)
for (const id of ['S1', 'S2', 'S3']) {
  const shot = getShot(runId, id)
  if (!shot?.draftPath || !existsSync(shot.draftPath)) { console.log(`  ${id}: 无产物，跳过`); continue }
  const f0 = await firstFrame(shot.draftPath, resolve(framesDir, `${id}_first.png`))
  const fN = await extractLastFrame(shot.draftPath, resolve(framesDir, `${id}_last.png`))
  if (!f0 || !fN) { console.log(`  ${id}: 抽帧失败`); continue }
  // 同镜末帧 vs 首帧：分越高=镜内越稳（无 cel→3D/角色漂移）
  const s = await scoreShotConsistency({ imagePaths: [fN], referenceImagePaths: [f0], prompt: '同一镜头内首帧与末帧，评估画风是否保持一致（cel 动画风不应变 3D/写实）、角色是否保持一致。' })
  recordCost({ runId, shotId: id, kind: 'vlm', provider: 'siliconflow', model: 'Qwen/Qwen3-VL-30B-A3B-Instruct', costCny: 0.01, dryRun: false, status: 'ok', detail: '镜内漂移QC' })
  console.log(`  ${id} 镜内(末vs首): ${s.score} ${s.pass ? 'PASS' : 'FAIL'}  ${s.issues.join('；')}`)
}
console.log('\n[说明] 分越低=镜内漂移越大。硅基 Wan2.2 无 FLF2V/强画风锁，镜内运动漂移无法根治；此分量化其严重度。')
