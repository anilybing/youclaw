// office-excel 技能 CLI 入口（bun build 打包为 skills/office-excel/scripts/excel.mjs）
// 用法: bun excel.mjs --mode <summarize|filter|pivot|split> --input <xlsx|csv> --out <输出.xlsx> [--config <cfg.json>] [--overwrite]
// 成功: stdout 单行 JSON {"ok":true,"out":"<绝对路径>","mode":"...","rows":N}，退出码 0
// 失败: stderr 人类可读原因 + stdout {"ok":false,"error":"..."}，退出码 1

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MODES, UserError, runExcel, type Mode } from './lib.ts'

const USAGE =
  '用法: bun excel.mjs --mode <summarize|filter|pivot|split> --input <文件.xlsx|文件.csv> --out <输出.xlsx> [--config <cfg.json>] [--overwrite]'

interface CliArgs {
  mode: Mode
  input: string
  out: string
  config?: string
  overwrite: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {}
  let overwrite = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--overwrite') {
      overwrite = true
      continue
    }
    if (arg === '--mode' || arg === '--input' || arg === '--out' || arg === '--config') {
      const key = arg.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) {
        throw new UserError(`参数 ${arg} 缺少值。${USAGE}`)
      }
      if (key in values) throw new UserError(`参数 ${arg} 重复`)
      values[key] = val
      i++
      continue
    }
    throw new UserError(`未知参数 "${arg}"。${USAGE}`)
  }
  const missing = ['mode', 'input', 'out'].filter((k) => !(k in values))
  if (missing.length > 0) {
    throw new UserError(`缺少必需参数: ${missing.map((k) => `--${k}`).join('、')}。${USAGE}`)
  }
  if (!(MODES as readonly string[]).includes(values.mode)) {
    throw new UserError(`--mode 无效（"${values.mode}"），可选值: ${MODES.join('|')}`)
  }
  return {
    mode: values.mode as Mode,
    input: values.input,
    out: values.out,
    config: values.config,
    overwrite,
  }
}

function loadConfig(configPath: string): unknown {
  if (!existsSync(configPath)) {
    throw new UserError(`config 文件不存在: ${configPath}`)
  }
  let text = readFileSync(configPath, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new UserError(`config 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const input = path.resolve(args.input)
  const out = path.resolve(args.out)
  if (!existsSync(input)) {
    throw new UserError(`输入文件不存在: ${input}`)
  }
  if (path.extname(out).toLowerCase() !== '.xlsx') {
    throw new UserError(`--out 必须是 .xlsx 文件（收到 "${args.out}"）`)
  }
  if (existsSync(out) && !args.overwrite) {
    throw new UserError(`输出文件已存在: ${out}；确认覆盖请追加 --overwrite`)
  }
  const configRaw = args.config === undefined ? undefined : loadConfig(args.config)
  const result = await runExcel({ mode: args.mode, input, out, configRaw })
  process.stdout.write(JSON.stringify({ ok: true, out: result.out, mode: result.mode, rows: result.rows }) + '\n')
}

main().catch((err: unknown) => {
  const message = err instanceof UserError ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(message + '\n')
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
  process.exit(1)
})
