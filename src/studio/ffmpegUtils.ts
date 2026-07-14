// [XJC] 漫剧工作室·ffmpeg 工具（首帧瘦身 / 抽末帧）。
// 开发机 ffmpeg 就绪（capcutDraft/draftExport 亦用 ffmpeg 脚本）；打包内置延 P1。
// 二进制解析：优先 env XJC_FFMPEG_PATH，否则 PATH 上的 ffmpeg。best-effort：不可用/失败不阻断主流程。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

const execFileAsync = promisify(execFile)

function ffmpegBin(): string {
  return process.env.XJC_FFMPEG_PATH?.trim() || 'ffmpeg'
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync(ffmpegBin(), ['-version'])
    return true
  } catch {
    return false
  }
}

/**
 * 把过大的首帧图压到 maxBytes 以下（SiliconFlow /video/submit 的 base64 首帧有字节阈值 ~1.4-1.5MB，
 * 超过会秒失败 status=Failed reason 空）。策略：转 JPEG(q:v 4，视觉近无损、体积大降) + 长边≤1280 保画幅。
 * ffmpeg 不可用/失败/未变小则返回原图（best-effort，不阻断）。
 */
export async function compressImageForUpload(srcPath: string, maxBytes = 1_000_000): Promise<string> {
  try {
    if (!srcPath || !existsSync(srcPath)) return srcPath
    const size = statSync(srcPath).size
    if (size <= maxBytes) return srcPath
    const outPath = resolve(dirname(srcPath), `${basename(srcPath, extname(srcPath))}_slim.jpg`)
    await execFileAsync(ffmpegBin(), ['-y', '-i', srcPath, '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', outPath])
    if (!existsSync(outPath)) return srcPath
    const outSize = statSync(outPath).size
    return outSize > 0 && outSize < size ? outPath : srcPath
  } catch {
    return srcPath
  }
}

/**
 * 从视频抽取「真实末帧」为 PNG（项2 真前向连续：下镜起始帧 = 上镜真实末帧）。
 * 返回落盘 PNG 路径；ffmpeg 不可用/失败返回 null（调用方回退占位关键帧）。
 */
export async function extractLastFrame(videoPath: string, outPath: string): Promise<string | null> {
  try {
    if (!videoPath || !existsSync(videoPath)) return null
    // -sseof -0.1 定位到末尾附近，取最后一帧。
    await execFileAsync(ffmpegBin(), ['-y', '-sseof', '-0.1', '-i', videoPath, '-vframes', '1', '-q:v', '2', outPath])
    return existsSync(outPath) && statSync(outPath).size > 0 ? outPath : null
  } catch {
    return null
  }
}
