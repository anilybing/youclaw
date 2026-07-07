// ecom-image 技能 CLI 入口（bun build 打包为 skills/ecom-image/scripts/image.mjs）
// 用法: bun image.mjs --mode <fit|compress|watermark|convert> --input <图片|目录> --outdir <输出目录> [选项] [--overwrite]
// 成功: stdout 单行 JSON {"ok":true,"mode":"...","count":N,"outdir":"...","outputs":[...]}，退出码 0
// 失败: stderr 人类可读原因 + stdout {"ok":false,"error":"..."}，退出码 1

import { MODES, UserError, runImage, type ImageOptions, type Mode, type WatermarkPosition, WATERMARK_POSITIONS } from './lib.ts'

const USAGE =
  '用法: bun image.mjs --mode <fit|compress|watermark|convert> --input <图片|目录> --outdir <输出目录> [--width 800 --height 800 --fit contain|cover --bg #FFFFFF --quality 80 --max 1600 --wm 水印.png --pos bottom-right --opacity 0.5 --scale 0.2 --margin 16 --format jpg|png] [--overwrite]'

const VALUE_KEYS = new Set([
  'mode', 'input', 'outdir', 'width', 'height', 'fit', 'bg',
  'quality', 'max', 'wm', 'pos', 'opacity', 'scale', 'margin', 'format',
])

function parseArgs(argv: string[]): { mode: Mode; input: string; outdir: string; overwrite: boolean; options: ImageOptions } {
  const values: Record<string, string> = {}
  let overwrite = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--overwrite') {
      overwrite = true
      continue
    }
    if (arg.startsWith('--') && VALUE_KEYS.has(arg.slice(2))) {
      const key = arg.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) throw new UserError(`参数 ${arg} 缺少值。${USAGE}`)
      if (key in values) throw new UserError(`参数 ${arg} 重复`)
      values[key] = val
      i++
      continue
    }
    throw new UserError(`未知参数 "${arg}"。${USAGE}`)
  }

  const missing = ['mode', 'input', 'outdir'].filter((k) => !(k in values))
  if (missing.length > 0) throw new UserError(`缺少必需参数: ${missing.map((k) => `--${k}`).join('、')}。${USAGE}`)
  if (!(MODES as readonly string[]).includes(values.mode)) {
    throw new UserError(`--mode 无效（"${values.mode}"），可选值: ${MODES.join('|')}`)
  }

  const num = (k: string): number | undefined => {
    if (!(k in values)) return undefined
    const n = Number(values[k])
    if (!Number.isFinite(n)) throw new UserError(`--${k} 必须是数字（收到 "${values[k]}"）`)
    return n
  }

  if (values.fit && values.fit !== 'contain' && values.fit !== 'cover') {
    throw new UserError(`--fit 仅支持 contain / cover（收到 "${values.fit}"）`)
  }
  if (values.pos && !(WATERMARK_POSITIONS as readonly string[]).includes(values.pos)) {
    throw new UserError(`--pos 无效（"${values.pos}"），可选: ${WATERMARK_POSITIONS.join('|')}`)
  }

  const options: ImageOptions = {
    width: num('width'),
    height: num('height'),
    fit: values.fit as 'contain' | 'cover' | undefined,
    bg: values.bg,
    quality: num('quality'),
    max: num('max'),
    wm: values.wm,
    pos: values.pos as WatermarkPosition | undefined,
    opacity: num('opacity'),
    scale: num('scale'),
    margin: num('margin'),
    format: values.format,
  }

  return { mode: values.mode as Mode, input: values.input, outdir: values.outdir, overwrite, options }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runImage(args)
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
}

main().catch((err: unknown) => {
  const message = err instanceof UserError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(message + '\n')
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
  process.exit(1)
})
