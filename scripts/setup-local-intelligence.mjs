// [XJC] 本地智能组件安装脚本（语义记忆 embedding + 本地 OCR）
//
// 用法（bun 运行）：
//   bun scripts/setup-local-intelligence.mjs                     # 装到当前用户数据目录（开发/单机）
//   bun scripts/setup-local-intelligence.mjs --target <dir>      # 装到指定目录（如便携 U 盘 tools/pytools）
//   可选：--python <exe> --pip-mirror <url> --hf-mirror <url> --skip-ocr --skip-embedding
//
// 产物布局（<root>）：
//   site-packages/                pip --target 依赖（不用 venv：venv 锁绝对路径，U 盘换盘符即废）
//   models/bge-small-zh-v1.5/     model.onnx + tokenizer.json
//   pytools.json                  能力清单（应用据此挂载 OCR 工具 / 启用语义记忆）
//
// 国内网络默认走清华 PyPI 镜像 + hf-mirror.com。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const readArg = (name) => {
  const idx = args.indexOf(name)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null
}
const hasFlag = (name) => args.includes(name)

const PIP_MIRROR = readArg('--pip-mirror') ?? 'https://pypi.tuna.tsinghua.edu.cn/simple'
const HF_MIRROR = (readArg('--hf-mirror') ?? 'https://hf-mirror.com').replace(/\/$/, '')
const SKIP_OCR = hasFlag('--skip-ocr')
const SKIP_EMBEDDING = hasFlag('--skip-embedding')

const MODEL_REPO = 'Xenova/bge-small-zh-v1.5'
const MODEL_FILES = [
  { remote: 'onnx/model_quantized.onnx', local: 'model.onnx', minBytes: 5 * 1024 * 1024 },
  { remote: 'tokenizer.json', local: 'tokenizer.json', minBytes: 10 * 1024 },
]
const PIP_PACKAGES = ['rapidocr-onnxruntime', 'onnxruntime', 'tokenizers', 'numpy']

async function defaultTarget() {
  // 优先跟随应用真实数据目录（dev=仓库 data/，Tauri 生产=平台数据目录），失败回退 APPDATA
  try {
    process.env.LOG_LEVEL ??= 'error'
    const config = await import('../src/config/index.ts')
    config.loadEnv()
    return resolve(config.getPaths().data, 'pytools')
  } catch { /* 独立运行场景 */ }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return resolve(process.env.APPDATA, 'com.youclaw.app', 'pytools')
  }
  const home = process.env.HOME ?? process.cwd()
  return resolve(home, '.local', 'share', 'com.youclaw.app', 'pytools')
}

function detectPython() {
  const explicit = readArg('--python')
  const candidates = explicit ? [explicit] : ['python', 'python3']
  for (const cmd of candidates) {
    try {
      const probe = Bun.spawnSync([cmd, '--version'], { stdout: 'pipe', stderr: 'pipe' })
      if (probe.exitCode === 0) return cmd
    } catch { /* try next */ }
  }
  return null
}

async function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd.join(' ')}`)
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', ...opts })
  const code = await proc.exited
  if (code !== 0) throw new Error(`命令退出码 ${code}: ${cmd.join(' ')}`)
}

async function download(url, dest, minBytes) {
  if (existsSync(dest) && statSync(dest).size >= minBytes) {
    console.log(`  已存在，跳过下载: ${dest}`)
    return
  }
  console.log(`  下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength < minBytes) throw new Error(`下载内容过小（${buf.byteLength} 字节），疑似错误页: ${url}`)
  await Bun.write(dest, buf)
  console.log(`  完成（${(buf.byteLength / 1024 / 1024).toFixed(1)} MB）→ ${dest}`)
}

async function main() {
  const root = resolve(readArg('--target') ?? await defaultTarget())
  const python = detectPython()
  if (!python) {
    console.error('未找到 python（请安装 Python 3.10+ 或用 --python 指定，便携版可指向 tools/python/python.exe）')
    process.exit(1)
  }
  console.log(`目标目录: ${root}`)
  console.log(`Python:   ${python}`)
  mkdirSync(root, { recursive: true })

  const sitePackages = resolve(root, 'site-packages')
  if (!SKIP_OCR || !SKIP_EMBEDDING) {
    const packages = [
      ...(!SKIP_OCR ? ['rapidocr-onnxruntime'] : []),
      ...(!SKIP_EMBEDDING ? ['onnxruntime', 'tokenizers', 'numpy'] : []),
    ]
    console.log(`\n[1/3] 安装 Python 依赖（--target 模式，可整体搬运）: ${packages.join(', ')}`)
    await run([python, '-m', 'pip', 'install', '--target', sitePackages, '--upgrade', '-i', PIP_MIRROR, ...packages])
  }

  if (!SKIP_EMBEDDING) {
    console.log(`\n[2/3] 下载 embedding 模型（${MODEL_REPO}）`)
    const modelDir = resolve(root, 'models', 'bge-small-zh-v1.5')
    mkdirSync(modelDir, { recursive: true })
    try {
      for (const file of MODEL_FILES) {
        await download(`${HF_MIRROR}/${MODEL_REPO}/resolve/main/${file.remote}`, resolve(modelDir, file.local), file.minBytes)
      }
    } catch (err) {
      console.error(`  模型下载失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('  hf-mirror 不可达时的替代路径：')
      console.error('  1) 从 ModelScope 下载原始权重并本地转换（需 torch，一次性）：')
      console.error('     python -m pip install --target <临时目录> torch transformers onnx onnxruntime tokenizers -i ' + PIP_MIRROR)
      console.error('     python -S scripts/convert-bge-to-onnx.py  （产物 out/model.onnx 复制到 ' + modelDir + '）')
      console.error('  2) 或从另一台机器拷贝整个 pytools/models 目录。')
      throw err
    }
  }

  console.log('\n[3/3] 冒烟自检')
  const smokeEnv = { ...process.env, PYTHONPATH: sitePackages, PYTHONIOENCODING: 'utf-8' }
  if (!SKIP_EMBEDDING) {
    await run([python, '-c', 'import onnxruntime, tokenizers, numpy; print("embedding deps OK")'], { env: smokeEnv })
  }
  if (!SKIP_OCR) {
    await run([python, '-c', 'import rapidocr_onnxruntime; print("rapidocr OK")'], { env: smokeEnv })
  }

  writeFileSync(resolve(root, 'pytools.json'), JSON.stringify({
    schemaVersion: 1,
    ocr: !SKIP_OCR,
    embedding: !SKIP_EMBEDDING,
    modelRepo: SKIP_EMBEDDING ? undefined : MODEL_REPO,
    installedAt: new Date().toISOString(),
  }, null, 2))

  console.log(`\n安装完成。清单已写入 ${resolve(root, 'pytools.json')}`)
  console.log('重启 XiaoJuClaw 后生效：OCR 工具自动挂载，语义记忆自动启用。')
  console.log('便携版制盘：把整个 pytools 目录放到 XiaoJuClawRuntime/tools/pytools（或平台子目录下）。')
}

main().catch((err) => {
  console.error(`\n安装失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
