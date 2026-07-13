// [XJC] 漫剧成片草稿构建器测试：画布尺寸/时间线累计/时长兜底/剪映分轨/FFmpeg concat。
import { describe, expect, test } from 'bun:test'
import { buildStudioDraft, resolveCanvasSize } from '../src/studio/capcutDraft.ts'

describe('resolveCanvasSize', () => {
  test('9:16 竖屏按分辨率决定短边', () => {
    expect(resolveCanvasSize('9:16', '720p')).toEqual({ width: 720, height: 1280 })
    expect(resolveCanvasSize('9:16', '1080p')).toEqual({ width: 1080, height: 1920 })
  })
  test('16:9 横屏与 1:1 方屏', () => {
    expect(resolveCanvasSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080 })
    expect(resolveCanvasSize('1:1', '720p')).toEqual({ width: 720, height: 720 })
  })
  test('未知画幅回落 9:16，未知分辨率回落 720p', () => {
    expect(resolveCanvasSize('weird', 'weird')).toEqual({ width: 720, height: 1280 })
  })
})

describe('buildStudioDraft', () => {
  const base = {
    title: '囤货少女',
    aspect: '9:16',
    resolution: '720p',
    shots: [
      { shotId: 'S1', durationSec: 4, mediaPath: '/m/a.png', dialogue: '你好' },
      { shotId: 'S2', durationSec: 6, mediaPath: '/m/b.png' },
    ],
  }

  test('时间线累计起始秒 + 总时长', () => {
    const b = buildStudioDraft(base)
    expect(b.totalSec).toBe(10)
    expect(b.manifest.shots[0].startSec).toBe(0)
    expect(b.manifest.shots[1].startSec).toBe(4)
    expect(b.totalMicros).toBe(10_000_000)
    expect(b.width).toBe(720)
    expect(b.height).toBe(1280)
  })

  test('媒体类型按扩展名推断，台词进文本轨', () => {
    const b = buildStudioDraft(base)
    expect(b.manifest.shots[0].mediaType).toBe('photo')
    const tracks = b.capcutDraft.tracks as Array<{ type: string; segments: unknown[] }>
    const video = tracks.find((t) => t.type === 'video')!
    const text = tracks.find((t) => t.type === 'text')
    expect(video.segments.length).toBe(2)
    // 只有 S1 有台词 → 文本轨仅 1 段
    expect(text?.segments.length).toBe(1)
  })

  test('时长非法值兜底：0/负数→3s，超大→60s', () => {
    const b = buildStudioDraft({
      ...base,
      shots: [
        { shotId: 'A', durationSec: 0, mediaPath: '/m/a.png' },
        { shotId: 'B', durationSec: -5, mediaPath: '/m/b.png' },
        { shotId: 'C', durationSec: 999, mediaPath: '/m/c.png' },
      ],
    })
    expect(b.manifest.shots[0].durationSec).toBe(3)
    expect(b.manifest.shots[1].durationSec).toBe(3)
    expect(b.manifest.shots[2].durationSec).toBe(60)
  })

  test('FFmpeg concat 每镜 file+duration，末条重复一次', () => {
    const b = buildStudioDraft(base)
    const lines = b.ffmpegConcat.split('\n')
    expect(b.ffmpegConcat).toContain(`file '/m/a.png'`)
    expect(b.ffmpegConcat).toContain('duration 4.000')
    expect(b.ffmpegConcat).toContain('duration 6.000')
    // 末条 file 重复：/m/b.png 出现两次
    const bCount = lines.filter((l) => l === `file '/m/b.png'`).length
    expect(bCount).toBe(2)
  })

  test('提供配乐时生成音频轨；构建脚本含 ffmpeg 命令', () => {
    const b = buildStudioDraft({ ...base, audioPath: '/m/bgm.mp3' })
    const tracks = b.capcutDraft.tracks as Array<{ type: string }>
    expect(tracks.some((t) => t.type === 'audio')).toBe(true)
    expect(b.ffmpegBuildSh).toContain('ffmpeg')
    expect(b.ffmpegBuildPs1).toContain('ffmpeg')
    expect(b.ffmpegBuildSh).toContain('/m/bgm.mp3')
  })

  test('空镜头列表也不崩，总时长 0', () => {
    const b = buildStudioDraft({ ...base, shots: [] })
    expect(b.totalSec).toBe(0)
    expect(b.manifest.shots.length).toBe(0)
  })
})
