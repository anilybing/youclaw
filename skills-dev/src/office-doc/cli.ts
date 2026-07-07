// office-doc CLI：bun render.mjs --spec <doc.json> --out <输出.docx>
// 成功：stdout 单行 JSON {"ok":true,"out":"<绝对路径>","sections":N}，退出码 0
// 失败：stderr 原因（stdout 输出 {"ok":false,"error":"..."} 便于程序化解析），退出码 1
// 零网络、零交互；契约见 doc/技能包开发规范.md 第 4 节

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { validateSpec } from './schema.ts'
import { renderDoc } from './render.ts'

const USAGE = '用法：bun render.mjs --spec <doc.json> --out <输出.docx> [--overwrite]'

interface CliArgs {
  spec: string
  out: string
  overwrite: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let spec: string | undefined
  let out: string | undefined
  let overwrite = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--spec') {
      spec = argv[++i]
    } else if (arg === '--out') {
      out = argv[++i]
    } else if (arg === '--overwrite') {
      overwrite = true
    } else {
      throw new Error(`无法识别的参数：${arg}。${USAGE}`)
    }
  }

  if (!spec) throw new Error(`缺少 --spec 参数（doc.json 文件路径）。${USAGE}`)
  if (!out) throw new Error(`缺少 --out 参数（输出 .docx 路径）。${USAGE}`)

  return { spec, out, overwrite }
}

function fail(message: string): never {
  console.error(message)
  console.log(JSON.stringify({ ok: false, error: message }))
  process.exit(1)
}

async function main(): Promise<void> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const specPath = resolve(args.spec)
  if (!existsSync(specPath)) {
    fail(`spec 文件不存在：${specPath}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'))
  } catch (error) {
    fail(`spec 文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }

  let spec
  try {
    spec = validateSpec(raw)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const outPath = resolve(args.out)
  if (existsSync(outPath) && !args.overwrite) {
    fail(`输出文件已存在：${outPath}。如需覆盖请追加 --overwrite 参数`)
  }

  try {
    const buffer = await renderDoc(spec)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, buffer)
  } catch (error) {
    fail(`生成 docx 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(JSON.stringify({ ok: true, out: outPath, sections: spec.sections.length }))
  process.exit(0)
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
