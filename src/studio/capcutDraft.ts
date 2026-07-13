// [XJC] 漫剧工作室·成片草稿构建器（纯函数，无副作用，便于单测）
//
// 输入：一条标准化的镜头时间线（每镜时长 + 静帧/视频路径 + 台词）+ 画幅/分辨率/可选配乐。
// 输出：三种可直接落盘的产物——
//   1) manifest.json：结构化镜头时间线（供人核对 / 二次程序化消费）
//   2) 剪映草稿 draft_content.json + draft_meta_info.json（beta：视频/文本/音频分轨，时间单位微秒）
//   3) FFmpeg concat 清单 + 一键合成脚本（sh/ps1）：静帧幻灯片式确定性合成，不依赖付费视频
//
// 设计红线：本模块只做「数据 → 结构」的纯变换，绝不读写磁盘 / 不触网 / 不烧模型 token。
// 落盘由 draftExport.ts 负责；这样时间线构建逻辑可被单测钉死。

export type StudioMediaType = 'photo' | 'video'

export interface StudioTimelineShot {
  shotId: string
  /** 单镜时长（秒）；非法值兜底为 3s，避免草稿出现 0 时长段。 */
  durationSec: number
  /** 静帧或视频的本机绝对路径（可缺省：占位镜） */
  mediaPath?: string
  mediaType?: StudioMediaType
  /** 台词/字幕文本（进文本轨） */
  dialogue?: string
}

export interface StudioDraftInput {
  title: string
  /** '9:16' | '16:9' | '1:1'（其它值按 9:16 处理） */
  aspect: string
  /** '720p' | '1080p'（其它值按 720p 处理） */
  resolution: string
  fps?: number
  shots: StudioTimelineShot[]
  /** 可选整段配乐/旁白音频本机路径 */
  audioPath?: string
}

export interface StudioManifestShot {
  index: number
  shotId: string
  startSec: number
  durationSec: number
  mediaPath: string | null
  mediaType: StudioMediaType | null
  dialogue: string | null
}

export interface StudioDraftBundle {
  title: string
  width: number
  height: number
  fps: number
  totalSec: number
  totalMicros: number
  manifest: {
    title: string
    aspect: string
    resolution: string
    width: number
    height: number
    fps: number
    totalSec: number
    audioPath: string | null
    shots: StudioManifestShot[]
  }
  capcutDraft: Record<string, unknown>
  capcutMeta: Record<string, unknown>
  ffmpegConcat: string
  ffmpegBuildSh: string
  ffmpegBuildPs1: string
}

const MIN_SHOT_SEC = 0.5
const DEFAULT_SHOT_SEC = 3
const MAX_SHOT_SEC = 60
const SECOND_MICROS = 1_000_000

function clampDuration(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_SHOT_SEC
  return Math.min(MAX_SHOT_SEC, Math.max(MIN_SHOT_SEC, sec))
}

/** 画幅 + 分辨率 → 像素宽高（短边由分辨率决定，长边按画幅推算）。 */
export function resolveCanvasSize(aspect: string, resolution: string): { width: number; height: number } {
  const shortSide = String(resolution).trim().toLowerCase() === '1080p' ? 1080 : 720
  const a = String(aspect).trim()
  if (a === '16:9') return { width: Math.round((shortSide * 16) / 9), height: shortSide }
  if (a === '1:1') return { width: shortSide, height: shortSide }
  // 默认竖屏 9:16（短剧主力画幅）
  return { width: shortSide, height: Math.round((shortSide * 16) / 9) }
}

function guessMediaType(shot: StudioTimelineShot): StudioMediaType | null {
  if (shot.mediaType) return shot.mediaType
  const p = (shot.mediaPath ?? '').toLowerCase()
  if (!p) return null
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/.test(p)) return 'video'
  if (/\.(png|jpg|jpeg|webp|gif|bmp)$/.test(p)) return 'photo'
  return null
}

function upperUuid(): string {
  return (globalThis.crypto?.randomUUID?.() ?? fallbackUuid()).toUpperCase()
}

function fallbackUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 单引号包裹路径并转义内部单引号，供 shell/concat 使用（防路径含空格/特殊字符）。 */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

function buildFfmpegConcat(shots: StudioManifestShot[]): string {
  // concat demuxer：每个 file 后跟 duration；末条需重复一次 file 才能让最后一段生效。
  const lines: string[] = ['# FFmpeg concat demuxer — 由漫剧工作室生成', 'ffconcat version 1.0']
  const withMedia = shots.filter((s) => s.mediaPath)
  withMedia.forEach((s, i) => {
    lines.push(`file ${shellQuote(s.mediaPath as string)}`)
    lines.push(`duration ${s.durationSec.toFixed(3)}`)
    if (i === withMedia.length - 1) lines.push(`file ${shellQuote(s.mediaPath as string)}`)
  })
  return `${lines.join('\n')}\n`
}

function buildBuildScript(kind: 'sh' | 'ps1', input: {
  width: number
  height: number
  fps: number
  audioPath: string | null
}): string {
  const scale = `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease,pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  const audioIn = input.audioPath ? ` -i ${shellQuote(input.audioPath)}` : ''
  const audioMap = input.audioPath ? ' -map 0:v -map 1:a -shortest' : ''
  const cmd = [
    'ffmpeg -y -f concat -safe 0 -i concat.txt' + audioIn,
    `-vf "${scale},fps=${input.fps}"`,
    '-pix_fmt yuv420p -c:v libx264 -crf 20' + (input.audioPath ? ' -c:a aac' : '') + audioMap,
    'output.mp4',
  ].join(' ')
  if (kind === 'ps1') {
    return [
      '# 漫剧工作室 · 一键合成（Windows PowerShell）。需已安装 ffmpeg 并在 PATH。',
      'Set-Location -Path $PSScriptRoot',
      cmd,
      'Write-Host "合成完成：output.mp4"',
      '',
    ].join('\n')
  }
  return [
    '#!/usr/bin/env bash',
    '# 漫剧工作室 · 一键合成（macOS/Linux）。需已安装 ffmpeg。',
    'set -e',
    'cd "$(dirname "$0")"',
    cmd,
    'echo "合成完成：output.mp4"',
    '',
  ].join('\n')
}

/** 剪映草稿：视频轨（静帧/视频）+ 文本轨（台词字幕）+ 可选音频轨。时间单位微秒。 */
function buildCapcutDraft(params: {
  title: string
  width: number
  height: number
  fps: number
  shots: StudioManifestShot[]
  audioPath: string | null
  totalMicros: number
}): Record<string, unknown> {
  const { width, height, fps, shots, audioPath, totalMicros } = params
  const videoMaterials: Record<string, unknown>[] = []
  const textMaterials: Record<string, unknown>[] = []
  const audioMaterials: Record<string, unknown>[] = []
  const videoSegments: Record<string, unknown>[] = []
  const textSegments: Record<string, unknown>[] = []
  const audioSegments: Record<string, unknown>[] = []

  let cursor = 0
  for (const shot of shots) {
    const dur = Math.round(shot.durationSec * SECOND_MICROS)
    if (shot.mediaPath) {
      const matId = upperUuid()
      const isVideo = shot.mediaType === 'video'
      videoMaterials.push({
        id: matId,
        type: isVideo ? 'video' : 'photo',
        path: shot.mediaPath,
        material_name: `${shot.shotId}`,
        width,
        height,
        duration: isVideo ? dur : 10_800_000_000, // 剪映静帧素材惯例给一个很大的可裁时长
        has_audio: false,
      })
      videoSegments.push({
        id: upperUuid(),
        material_id: matId,
        target_timerange: { start: cursor, duration: dur },
        source_timerange: { start: 0, duration: dur },
        speed: 1.0,
        volume: 1.0,
        visible: true,
        clip: { alpha: 1.0, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: 0.0 } },
      })
    }
    const dialogue = (shot.dialogue ?? '').trim()
    if (dialogue) {
      const txtId = upperUuid()
      textMaterials.push({
        id: txtId,
        type: 'text',
        content: dialogue,
        font_size: 8,
        text_color: '#FFFFFF',
        alignment: 1,
      })
      textSegments.push({
        id: upperUuid(),
        material_id: txtId,
        target_timerange: { start: cursor, duration: dur },
        clip: { alpha: 1.0, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: -0.8 } },
      })
    }
    cursor += dur
  }

  if (audioPath) {
    const audId = upperUuid()
    audioMaterials.push({ id: audId, type: 'extract_music', path: audioPath, duration: totalMicros, name: 'bgm' })
    audioSegments.push({
      id: upperUuid(),
      material_id: audId,
      target_timerange: { start: 0, duration: totalMicros },
      source_timerange: { start: 0, duration: totalMicros },
      speed: 1.0,
      volume: 0.6,
    })
  }

  const tracks: Record<string, unknown>[] = [
    { id: upperUuid(), type: 'video', attribute: 0, flag: 0, segments: videoSegments },
  ]
  if (audioSegments.length > 0) tracks.push({ id: upperUuid(), type: 'audio', attribute: 0, flag: 0, segments: audioSegments })
  if (textSegments.length > 0) tracks.push({ id: upperUuid(), type: 'text', attribute: 0, flag: 0, segments: textSegments })

  return {
    // 结构对齐剪映 draft_content.json 的核心骨架（版本相关字段属 beta，导入后以剪映为准）。
    id: upperUuid(),
    version: '1.0.0',
    app_version: 'anime-drama-studio',
    duration: totalMicros,
    fps,
    canvas_config: { width, height, ratio: 'original' },
    materials: {
      videos: videoMaterials,
      audios: audioMaterials,
      texts: textMaterials,
      stickers: [],
      effects: [],
      transitions: [],
    },
    tracks,
    platform: { os: 'windows', app: 'anime-drama-studio' },
  }
}

/** 构建成片草稿全套产物（纯函数）。传入镜头时间线，返回可落盘的结构与脚本文本。 */
export function buildStudioDraft(input: StudioDraftInput): StudioDraftBundle {
  const title = (input.title ?? '').trim() || '未命名漫剧'
  const { width, height } = resolveCanvasSize(input.aspect, input.resolution)
  const fps = Number.isFinite(input.fps) && (input.fps ?? 0) > 0 ? Math.round(input.fps as number) : 30
  const rawShots = Array.isArray(input.shots) ? input.shots : []

  let cursorSec = 0
  const manifestShots: StudioManifestShot[] = rawShots.map((shot, index) => {
    const durationSec = clampDuration(Number(shot.durationSec))
    const startSec = cursorSec
    cursorSec += durationSec
    return {
      index: index + 1,
      shotId: (shot.shotId ?? '').trim() || `shot-${index + 1}`,
      startSec: Number(startSec.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      mediaPath: shot.mediaPath?.trim() || null,
      mediaType: guessMediaType(shot),
      dialogue: shot.dialogue?.trim() || null,
    }
  })

  const totalSec = Number(cursorSec.toFixed(3))
  const totalMicros = Math.round(totalSec * SECOND_MICROS)
  const audioPath = input.audioPath?.trim() || null

  return {
    title,
    width,
    height,
    fps,
    totalSec,
    totalMicros,
    manifest: {
      title,
      aspect: String(input.aspect ?? '9:16'),
      resolution: String(input.resolution ?? '720p'),
      width,
      height,
      fps,
      totalSec,
      audioPath,
      shots: manifestShots,
    },
    capcutDraft: buildCapcutDraft({ title, width, height, fps, shots: manifestShots, audioPath, totalMicros }),
    capcutMeta: {
      draft_id: upperUuid(),
      draft_name: title,
      draft_fold_path: '',
      tm_draft_create: Date.now(),
      tm_draft_modified: Date.now(),
      draft_root_path: '',
    },
    ffmpegConcat: buildFfmpegConcat(manifestShots),
    ffmpegBuildSh: buildBuildScript('sh', { width, height, fps, audioPath }),
    ffmpegBuildPs1: buildBuildScript('ps1', { width, height, fps, audioPath }),
  }
}
