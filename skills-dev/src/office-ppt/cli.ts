// office-ppt CLI：deck.json -> .pptx
// 用法：bun render.mjs --spec <deck.json> --out <输出.pptx> [--theme business|minimal|orange] [--overwrite]
// 成功：stdout 单行 {"ok":true,"out":"<绝对路径>","slides":N}，退出码 0
// 失败：stderr 人类可读原因 + stdout {"ok":false,"error":"..."}，退出码 1
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isThemeName, validateDeck, THEME_NAMES } from './schema.ts'
import { renderDeck } from './renderer.ts'

const USAGE =
  '用法：bun render.mjs --spec <deck.json 路径> --out <输出.pptx 路径> [--theme business|minimal|orange] [--overwrite]'

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exit(1)
}

interface CliArgs {
  spec: string
  out: string
  theme?: string
  overwrite: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let spec: string | undefined
  let out: string | undefined
  let theme: string | undefined
  let overwrite = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--spec':
        spec = argv[++i]
        break
      case '--out':
        out = argv[++i]
        break
      case '--theme':
        theme = argv[++i]
        break
      case '--overwrite':
        overwrite = true
        break
      case '--help':
      case '-h':
        process.stdout.write(`${USAGE}\n`)
        process.exit(0)
        break
      default:
        fail(`未知参数：${arg}\n${USAGE}`)
    }
  }

  if (!spec) fail(`缺少 --spec 参数（deck.json 路径）\n${USAGE}`)
  if (!out) fail(`缺少 --out 参数（输出 .pptx 路径）\n${USAGE}`)
  return { spec, out, theme, overwrite }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const specPath = resolve(args.spec)
  if (!existsSync(specPath)) {
    fail(`spec 文件不存在：${specPath}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'))
  } catch (err) {
    fail(`spec 不是合法 JSON：${specPath}\n${err instanceof Error ? err.message : String(err)}`)
  }

  const { deck, errors } = validateDeck(raw)
  if (!deck) {
    fail(`deck.json 校验失败（${errors.length} 处）：\n- ${errors.join('\n- ')}`)
  }

  if (args.theme !== undefined) {
    if (!isThemeName(args.theme)) {
      fail(`--theme 取值 "${args.theme}" 非法，支持：${THEME_NAMES.join(' / ')}`)
    }
    deck.theme = args.theme
  }

  const outPath = resolve(args.out)
  if (!outPath.toLowerCase().endsWith('.pptx')) {
    fail(`--out 必须以 .pptx 结尾：${outPath}`)
  }
  if (existsSync(outPath) && !args.overwrite) {
    fail(`输出文件已存在：${outPath}\n如需覆盖请追加 --overwrite`)
  }

  try {
    const { buffer, slides } = await renderDeck(deck)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buffer)
    process.stdout.write(`${JSON.stringify({ ok: true, out: outPath, slides })}\n`)
    process.exit(0)
  } catch (err) {
    fail(`渲染失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  }
}

void main()
