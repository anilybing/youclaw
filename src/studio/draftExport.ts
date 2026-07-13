// [XJC] 漫剧工作室·成片草稿落盘（副作用集中在此，纯构建逻辑见 capcutDraft.ts）
//
// 把 buildStudioDraft 产出的结构写进「员工工作区/漫剧草稿/<runId>/」：
//   manifest.json                 结构化镜头时间线（人工核对 / 二次消费）
//   capcut/draft_content.json     剪映草稿（beta）
//   capcut/draft_meta_info.json   剪映元信息（beta）
//   ffmpeg/concat.txt             concat demuxer 清单（绝对媒体路径）
//   ffmpeg/build.sh / build.ps1   一键合成脚本（静帧幻灯片，不依赖付费视频）
//   README.txt                    使用说明
// 产物落员工工作区，便于「媒体产出」同区管理，不上云。

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/paths.ts'
import { buildStudioDraft, type StudioDraftBundle, type StudioDraftInput } from './capcutDraft.ts'

export interface StudioDraftExportResult {
  runId: string
  dir: string
  totalSec: number
  shotCount: number
  files: string[]
  bundle: StudioDraftBundle
}

const RUN_ID_SAFE = /[^a-zA-Z0-9_-]/g

/** 草稿输出根目录：优先员工工作区「漫剧草稿」，无 agentId 时落全局 workspace/studio-drafts。 */
function draftRootDir(agentId?: string | null): string {
  const id = (agentId ?? '').trim()
  return id
    ? resolve(getPaths().agents, id, '漫剧草稿')
    : resolve(getPaths().workspace, 'studio-drafts')
}

const README = [
  '漫剧工作室 · 成片草稿包',
  '',
  '一、剪映草稿（beta）',
  '  capcut/draft_content.json 为分轨草稿（视频/字幕/音频）。剪映各版本 draft 结构有差异，',
  '  如无法直接导入，请以 manifest.json + ffmpeg 脚本为准，或按镜头清单在剪映内手动排轨。',
  '',
  '二、FFmpeg 一键合成（推荐，确定性）',
  '  1) 安装 ffmpeg 并加入 PATH',
  '  2) Windows：右键 ffmpeg/build.ps1 → 用 PowerShell 运行；macOS/Linux：bash ffmpeg/build.sh',
  '  3) 产物 output.mp4 即按镜头时长拼接的成片（静帧幻灯片式；有配乐则自动混入）',
  '',
  '三、manifest.json',
  '  结构化镜头时间线（序号/起始秒/时长/媒体路径/台词），可供二次程序化消费。',
  '',
].join('\n')

/**
 * 构建并落盘成片草稿包。runId 仅用于目录命名（做安全化处理）。
 * 返回包目录与产物清单，供路由回给前端展示 / 打开目录。
 */
export function exportStudioDraftPackage(
  runId: string,
  input: StudioDraftInput,
  agentId?: string | null,
): StudioDraftExportResult {
  const safeRunId = (runId ?? '').trim().replace(RUN_ID_SAFE, '_').slice(0, 80) || `run-${Date.now().toString(36)}`
  const bundle = buildStudioDraft(input)
  const dir = resolve(draftRootDir(agentId), safeRunId)
  const capcutDir = resolve(dir, 'capcut')
  const ffmpegDir = resolve(dir, 'ffmpeg')
  mkdirSync(capcutDir, { recursive: true })
  mkdirSync(ffmpegDir, { recursive: true })

  const files: Array<[string, string]> = [
    [resolve(dir, 'manifest.json'), JSON.stringify(bundle.manifest, null, 2)],
    [resolve(dir, 'README.txt'), README],
    [resolve(capcutDir, 'draft_content.json'), JSON.stringify(bundle.capcutDraft, null, 2)],
    [resolve(capcutDir, 'draft_meta_info.json'), JSON.stringify(bundle.capcutMeta, null, 2)],
    [resolve(ffmpegDir, 'concat.txt'), bundle.ffmpegConcat],
    [resolve(ffmpegDir, 'build.sh'), bundle.ffmpegBuildSh],
    [resolve(ffmpegDir, 'build.ps1'), bundle.ffmpegBuildPs1],
  ]
  for (const [path, content] of files) writeFileSync(path, content, 'utf8')

  return {
    runId: safeRunId,
    dir,
    totalSec: bundle.totalSec,
    shotCount: bundle.manifest.shots.length,
    files: files.map(([path]) => path),
    bundle,
  }
}
