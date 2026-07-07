// ecom-image 技能核心逻辑：本地批量主图处理（jimp，纯 JS，离线，零 API Key）。
// 供 cli.ts 调用；cli 负责参数解析与 IO，本文件负责图片处理与批处理编排。
//
// 设计红线：
// - 只用纯 JS 的 jimp，不依赖 ffmpeg/imagemagick/native 二进制，可打包进便携包离线跑。
// - 只写到 --outdir，绝不覆盖原图（除非 --overwrite），原图目录不写入。
// - jimp 1.x 不支持 webp 编码，输出格式仅 jpg/png。

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Jimp } from 'jimp'

export class UserError extends Error {}

export const MODES = ['fit', 'compress', 'watermark', 'convert'] as const
export type Mode = (typeof MODES)[number]

/** jimp 可读写的位图扩展名（webp 不支持编码，排除） */
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png'])

export const WATERMARK_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number]

export interface ImageOptions {
  width?: number
  height?: number
  fit?: 'contain' | 'cover'
  bg?: string
  quality?: number
  max?: number
  wm?: string
  pos?: WatermarkPosition
  opacity?: number
  scale?: number
  margin?: number
  format?: string
}

export interface RunImageParams {
  mode: Mode
  input: string
  outdir: string
  overwrite: boolean
  options: ImageOptions
}

export interface RunImageResult {
  mode: Mode
  count: number
  outdir: string
  outputs: string[]
}

/** #RRGGBB / #RGB → jimp RGBA 整数（0xRRGGBBAA，A 固定 ff） */
export function parseColor(hex: string): number {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new UserError(`--bg 颜色格式无效（"${hex}"），应为 #RRGGBB，例如 #FFFFFF`)
  }
  return (parseInt(h + 'ff', 16) >>> 0)
}

/** 规范化输出扩展名：jpg/jpeg → .jpg；png → .png */
function normalizeExt(fmt: string): string {
  const f = fmt.trim().toLowerCase().replace(/^\./, '')
  if (f === 'jpg' || f === 'jpeg') return '.jpg'
  if (f === 'png') return '.png'
  throw new UserError(`--format 仅支持 jpg / png（收到 "${fmt}"）`)
}

/** 列出待处理图片：input 可为单文件或目录（目录只扫第一层，跳过隐藏/锁文件） */
export function listInputs(input: string): string[] {
  if (!existsSync(input)) throw new UserError(`输入不存在: ${input}`)
  const st = statSync(input)
  if (st.isFile()) {
    if (!SUPPORTED_EXT.has(path.extname(input).toLowerCase())) {
      throw new UserError(`不支持的图片格式: ${path.extname(input)}（支持 .jpg/.jpeg/.png）`)
    }
    return [input]
  }
  const files = readdirSync(input, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.startsWith('~$'))
    .filter((e) => SUPPORTED_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(input, e.name))
    .sort()
  if (files.length === 0) throw new UserError(`目录下没有支持的图片（.jpg/.jpeg/.png）: ${input}`)
  return files
}

function placeXY(
  pos: WatermarkPosition, baseW: number, baseH: number, wmW: number, wmH: number, margin: number,
): [number, number] {
  const xs: Record<string, number> = { left: margin, center: Math.round((baseW - wmW) / 2), right: baseW - wmW - margin }
  const ys: Record<string, number> = { top: margin, center: Math.round((baseH - wmH) / 2), bottom: baseH - wmH - margin }
  // 'center' 只有一个词（无连字符），vx 回退到 vy → 正中；其余为 "纵-横"
  const parts = pos.split('-')
  const vy = parts[0]
  const vx = parts[1] ?? parts[0]
  return [xs[vx] ?? xs.center, ys[vy] ?? ys.center]
}

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>

async function processFit(inPath: string, o: ImageOptions): Promise<JimpImage> {
  if (!o.width || !o.height) throw new UserError('fit 模式需要 --width 与 --height（目标像素，如 800 800）')
  if (o.width <= 0 || o.height <= 0 || !Number.isInteger(o.width) || !Number.isInteger(o.height)) {
    throw new UserError(`--width / --height 必须是正整数（收到 ${o.width}×${o.height}）`)
  }
  const bg = parseColor(o.bg ?? '#FFFFFF')
  const img = await Jimp.read(inPath)
  const fitted = o.fit === 'cover' ? img.cover({ w: o.width, h: o.height }) : img.contain({ w: o.width, h: o.height })
  // 统一贴到纯色画布：contain 的透明留白与源图透明区都会被背景色填充 → 得到白底方图
  const canvas = new Jimp({ width: o.width, height: o.height, color: bg })
  canvas.composite(fitted, 0, 0)
  return canvas
}

async function processCompress(inPath: string, o: ImageOptions): Promise<JimpImage> {
  const img = await Jimp.read(inPath)
  if (o.max && o.max > 0) {
    const longest = Math.max(img.width, img.height)
    if (longest > o.max) {
      const s = o.max / longest
      img.resize({ w: Math.max(1, Math.round(img.width * s)), h: Math.max(1, Math.round(img.height * s)) })
    }
  }
  return img // 质量在写出时按 --quality 应用（仅对 jpg 生效）
}

async function processWatermark(inPath: string, o: ImageOptions): Promise<JimpImage> {
  if (!o.wm) throw new UserError('watermark 模式需要 --wm <水印图.png/.jpg>')
  if (!existsSync(o.wm)) throw new UserError(`水印图不存在: ${o.wm}`)
  const base = await Jimp.read(inPath)
  const wm = await Jimp.read(o.wm)
  const scale = o.scale ?? 0.2
  if (scale <= 0 || scale > 1) throw new UserError('--scale 应在 0~1 之间（水印宽占主图宽的比例）')
  const targetW = Math.max(1, Math.round(base.width * scale))
  const ratio = wm.height / wm.width
  wm.resize({ w: targetW, h: Math.max(1, Math.round(targetW * ratio)) })
  const opacity = o.opacity ?? 0.5
  if (opacity < 0 || opacity > 1) throw new UserError('--opacity 应在 0~1 之间')
  if (opacity < 1) wm.opacity(opacity)
  const margin = o.margin ?? 16
  const [x, y] = placeXY(o.pos ?? 'bottom-right', base.width, base.height, wm.width, wm.height, margin)
  base.composite(wm, x, y)
  return base
}

async function processConvert(inPath: string, _o: ImageOptions): Promise<JimpImage> {
  return Jimp.read(inPath) // 转换只改输出扩展名，由 outExtFor 决定
}

function outExtFor(mode: Mode, srcExt: string, formatOpt?: string): string {
  if (mode === 'convert') {
    if (!formatOpt) throw new UserError('convert 模式需要 --format jpg|png')
    return normalizeExt(formatOpt)
  }
  if (formatOpt) return normalizeExt(formatOpt)
  return srcExt.toLowerCase() === '.jpeg' ? '.jpg' : srcExt.toLowerCase()
}

async function writeImage(img: JimpImage, outPath: string, quality: number): Promise<void> {
  const ext = path.extname(outPath).toLowerCase()
  if (ext === '.png') {
    writeFileSync(outPath, await img.getBuffer('image/png'))
    return
  }
  // jpeg 无 alpha 通道：透明像素会被编码成黑块。先把图叠到白底再编码。
  // fit 输出已是不透明实色底图（叠白底不改变其像素，白底被完全遮住），
  // 只有真正含透明的图（如 convert 一张透明 png）才会被铺白，符合预期。
  const onWhite = new Jimp({ width: img.width, height: img.height, color: 0xffffffff })
  onWhite.composite(img, 0, 0)
  writeFileSync(outPath, await onWhite.getBuffer('image/jpeg', { quality }))
}

const PROCESSORS: Record<Mode, (inPath: string, o: ImageOptions) => Promise<JimpImage>> = {
  fit: processFit,
  compress: processCompress,
  watermark: processWatermark,
  convert: processConvert,
}

/** 执行一批图片处理。返回产物 basename 清单（顺序与输入一致）。 */
export async function runImage(params: RunImageParams): Promise<RunImageResult> {
  const { mode, input, outdir, overwrite, options } = params
  const inputs = listInputs(input)
  const quality = options.quality ?? 80
  if (quality < 1 || quality > 100) throw new UserError('--quality 应在 1~100 之间')

  mkdirSync(outdir, { recursive: true })
  const process = PROCESSORS[mode]
  const outputs: string[] = []

  for (const inPath of inputs) {
    const base = path.basename(inPath, path.extname(inPath))
    const outExt = outExtFor(mode, path.extname(inPath), options.format)
    const outPath = path.join(outdir, base + outExt)
    if (path.resolve(outPath) === path.resolve(inPath)) {
      throw new UserError(`输出会覆盖原图（${outPath}）；请指定不同的 --outdir`)
    }
    if (existsSync(outPath) && !overwrite) {
      throw new UserError(`输出文件已存在: ${outPath}；确认覆盖请追加 --overwrite`)
    }
    const img = await process(inPath, options)
    await writeImage(img, outPath, quality)
    outputs.push(base + outExt)
  }

  return { mode, count: outputs.length, outdir, outputs }
}
