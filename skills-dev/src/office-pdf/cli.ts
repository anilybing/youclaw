// office-pdf 技能 CLI：合并 / 拆分 / 加水印
// 契约（doc/技能包开发规范.md 第 4 节）：
//   成功 => stdout 单行 JSON {"ok":true,"out":"<绝对路径>","pages":N}，退出码 0
//   失败 => stderr 人类可读原因 + stdout {"ok":false,"error":"..."}，退出码 1
//   禁网络、禁交互、禁位置参数
import { UserError, mergePdfs, splitPdf, watermarkPdf, type PdfOpResult } from './pdf'

const USAGE = `用法：bun pdf.mjs --mode <merge|split|watermark> ...
  merge:     --input a.pdf,b.pdf[,c.pdf...] --out merged.pdf   （至少 2 个输入，按顺序合并全部页）
  split:     --input a.pdf --pages 1-3,5 --out part.pdf        （页码从 1 开始，支持区间与逗号列表）
  watermark: --input a.pdf --text "CONFIDENTIAL" --out marked.pdf [--opacity 0.15]
             （水印文本仅支持英文/数字等 WinAnsi 字符，含中文会报错）
  通用：--out 必须是新路径，不允许与输入相同；覆盖已存在文件需显式 --overwrite`

interface CliArgs {
  flags: Map<string, string>
  switches: Set<string>
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  const valueFlags = new Set(['--mode', '--input', '--out', '--pages', '--text', '--opacity'])
  const switchFlags = new Set(['--overwrite'])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (valueFlags.has(token)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UserError(`参数 ${token} 缺少值。\n${USAGE}`)
      flags.set(token, value)
      i++
    } else if (switchFlags.has(token)) {
      switches.add(token)
    } else {
      throw new UserError(`无法识别的参数：${token}（只支持长参数，不支持位置参数）\n${USAGE}`)
    }
  }
  return { flags, switches }
}

function requireFlag(args: CliArgs, name: string, mode: string): string {
  const value = args.flags.get(name)
  if (value === undefined) throw new UserError(`${mode} 模式缺少必需参数 ${name}。\n${USAGE}`)
  return value
}

async function run(argv: string[]): Promise<PdfOpResult> {
  const args = parseArgs(argv)
  const mode = args.flags.get('--mode')
  if (!mode) throw new UserError(`缺少必需参数 --mode。\n${USAGE}`)
  const overwrite = args.switches.has('--overwrite')

  switch (mode) {
    case 'merge': {
      const inputs = requireFlag(args, '--input', 'merge')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      const out = requireFlag(args, '--out', 'merge')
      return mergePdfs(inputs, out, overwrite)
    }
    case 'split': {
      const input = requireFlag(args, '--input', 'split')
      if (input.includes(',')) throw new UserError('split 模式只支持单个 --input 文件（不要用逗号传多个）')
      const pages = requireFlag(args, '--pages', 'split')
      const out = requireFlag(args, '--out', 'split')
      return splitPdf(input, pages, out, overwrite)
    }
    case 'watermark': {
      const input = requireFlag(args, '--input', 'watermark')
      if (input.includes(',')) throw new UserError('watermark 模式只支持单个 --input 文件（不要用逗号传多个）')
      const text = requireFlag(args, '--text', 'watermark')
      const out = requireFlag(args, '--out', 'watermark')
      const opacityRaw = args.flags.get('--opacity') ?? '0.15'
      const opacity = Number(opacityRaw)
      if (!Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
        throw new UserError(`--opacity 必须是 (0, 1] 之间的数字，当前值：${opacityRaw}`)
      }
      return watermarkPdf(input, text, out, opacity, overwrite)
    }
    default:
      throw new UserError(`不支持的 --mode：${mode}（只支持 merge / split / watermark）\n${USAGE}`)
  }
}

try {
  const result = await run(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify({ ok: true, out: result.outPath, pages: result.pages })}\n`)
  process.exit(0)
} catch (err) {
  const message = err instanceof UserError ? err.message : `内部错误：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
  process.stderr.write(`${message}\n`)
  process.stdout.write(`${JSON.stringify({ ok: false, error: message.split('\n')[0] })}\n`)
  process.exit(1)
}
