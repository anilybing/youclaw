// [XJC] 本地智能组件验收脚本：经由 src/pytools/runtime.ts 真实桥代码端到端验证
//   bun scripts/verify-local-intelligence.mjs [--image <path>]
// 验证项：
//   1. 能力探测（pytools.json / python / 模型文件）
//   2. embedding 常驻 worker：向量维度 + 语义排序 sanity（发票 vs 报销单据 vs 无关句）
//   3. 本地 OCR：识别指定图片（默认取图文手册第一张真实 UI 截图）
// 需要先运行 setup-local-intelligence 完成安装；未安装时本脚本如实报告缺失项后退出 1。

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

process.env.LOG_LEVEL ??= 'error'

const { loadEnv } = await import('../src/config/index.ts')
const { initLogger } = await import('../src/logger/index.ts')
loadEnv()
initLogger()

const { detectPytoolsCapabilities, getEmbedWorker, runLocalOcr, dotSimilarity } = await import('../src/pytools/runtime.ts')

const args = process.argv.slice(2)
const imageArgIdx = args.indexOf('--image')
const imagePath = imageArgIdx >= 0 && args[imageArgIdx + 1]
  ? resolve(args[imageArgIdx + 1])
  : resolve(import.meta.dir, '../web/public/user-guide/assets/ui/01-login.png')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

console.log('== 1. 能力探测 ==')
const caps = detectPytoolsCapabilities()
check('pytools 根目录', !!caps.root, caps.root ?? '未找到（先运行 setup-local-intelligence）')
check('python 可用', !!caps.python, caps.python ?? '')
check('embedding 能力', caps.embedding)
check('OCR 能力', caps.ocr)
if (!caps.root || !caps.python) process.exit(1)

if (caps.embedding) {
  console.log('\n== 2. embedding worker（经 runtime 桥） ==')
  const worker = getEmbedWorker()
  const t0 = Date.now()
  const vectors = await worker.embed(['发票', '这个月的报销单据在哪里', '一只可爱的小猫在晒太阳'], 90_000)
  const coldMs = Date.now() - t0
  check('批量向量化返回', !!vectors && vectors.length === 3, `冷启动 ${coldMs}ms`)
  if (vectors) {
    check('向量维度 512', vectors[0].length === 512, `dims=${vectors[0].length}`)
    const simRelated = dotSimilarity(vectors[0], vectors[1])
    const simUnrelated = dotSimilarity(vectors[0], vectors[2])
    check(
      '语义排序（发票↔报销 > 发票↔小猫）',
      simRelated > simUnrelated + 0.1,
      `related=${simRelated.toFixed(4)} unrelated=${simUnrelated.toFixed(4)}`,
    )
    const t1 = Date.now()
    await worker.embed(['热身后的第二次请求'])
    check('常驻 worker 热请求 <1s', Date.now() - t1 < 1000, `${Date.now() - t1}ms`)
  }
  worker.dispose()
}

if (caps.ocr) {
  console.log('\n== 3. 本地 OCR ==')
  if (!existsSync(imagePath)) {
    check('测试图片存在', false, imagePath)
  } else {
    const t0 = Date.now()
    const result = await runLocalOcr(imagePath)
    check('OCR 执行成功', result.ok === true, result.ok ? `${Date.now() - t0}ms` : result.error)
    if (result.ok) {
      const lines = result.lines ?? []
      check('识别出文字行', lines.length > 0, `${lines.length} 行`)
      const joined = lines.map((line) => line.text).join(' ')
      console.log(`  样例: ${joined.slice(0, 120)}${joined.length > 120 ? '…' : ''}`)
    }
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
