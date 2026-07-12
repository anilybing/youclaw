// [XJC] 本地智能 Python 工具桥（语义记忆 embedding + 本地 OCR 共用地基）
//
// 布局（<root> = 便携 tools/pytools 或 <数据目录>/pytools，读取时便携优先）：
//   <root>/site-packages/   pip install --target 的依赖（不用 venv：venv 锁绝对路径，U 盘换盘符即废）
//   <root>/models/bge-small-zh-v1.5/{model.onnx,tokenizer.json}
//   <root>/scripts/{ocr_cli.py,embed_worker.py}   由内嵌源码按内容幂等物料化
//   <root>/pytools.json     能力清单（setup 脚本写入）
//
// 一切失败静默降级：没装 pytools / python 缺失 / 脚本崩溃，都不影响主流程（工具不挂载、语义检索不生效）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { resolvePortableToolDir } from '../config/portable-tools.ts'
import { getLogger } from '../logger/index.ts'
import { OCR_CLI_PY, EMBED_WORKER_PY } from './scripts.ts'

const EMBED_MODEL_DIRNAME = 'bge-small-zh-v1.5'
const OCR_TIMEOUT_MS = 90_000
const EMBED_INIT_TIMEOUT_MS = 60_000
const EMBED_REQUEST_TIMEOUT_MS = 20_000
const WORKER_MAX_RESTARTS = 3

export interface PytoolsCapabilities {
  root: string | null
  python: string | null
  ocr: boolean
  embedding: boolean
}

interface PytoolsManifest {
  schemaVersion: number
  ocr?: boolean
  embedding?: boolean
}

function safeLog(level: 'info' | 'warn' | 'debug', fields: Record<string, unknown>, message: string): void {
  try {
    getLogger()[level]({ ...fields, category: 'pytools' }, message)
  } catch { /* logger 未初始化（纯函数单测） */ }
}

/** pytools 根目录：便携 tools 优先，其次数据目录；都不存在返回 null（能力未安装） */
export function resolvePytoolsRoot(): string | null {
  try {
    const portable = resolvePortableToolDir('pytools')
    if (portable && existsSync(resolve(portable, 'pytools.json'))) return portable
  } catch { /* 便携解析失败走数据目录 */ }
  const dataRoot = resolve(getPaths().data, 'pytools')
  if (existsSync(resolve(dataRoot, 'pytools.json'))) return dataRoot
  return null
}

let cachedPython: string | null | undefined

/** python 解释器：便携内嵌 python 绝对路径优先，其次 PATH（进程级缓存，探测一次） */
export function detectPython(): string | null {
  if (cachedPython !== undefined) return cachedPython
  const candidates: string[] = []
  try {
    const portableDir = resolvePortableToolDir('python')
    if (portableDir) {
      candidates.push(resolve(portableDir, process.platform === 'win32' ? 'python.exe' : 'bin/python3'))
    }
  } catch { /* 走 PATH */ }
  candidates.push('python', 'python3')
  for (const cmd of candidates) {
    try {
      const probe = Bun.spawnSync([cmd, '--version'], { stdout: 'pipe', stderr: 'pipe' })
      if (probe.exitCode === 0) {
        cachedPython = cmd
        return cmd
      }
    } catch { /* try next */ }
  }
  cachedPython = null
  return null
}

function readManifest(root: string): PytoolsManifest | null {
  try {
    // 剥 UTF-8 BOM：Windows 下 PowerShell 等工具写出的 JSON 常带 BOM，JSON.parse 会抛错
    const raw = readFileSync(resolve(root, 'pytools.json'), 'utf-8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw) as PytoolsManifest
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === 1) return parsed
  } catch { /* 损坏视为未安装 */ }
  return null
}

export function getEmbedModelDir(root: string): string {
  return resolve(root, 'models', EMBED_MODEL_DIRNAME)
}

/** 能力探测（每次调用现查文件系统；调用频率低无需缓存过期逻辑） */
export function detectPytoolsCapabilities(): PytoolsCapabilities {
  const root = resolvePytoolsRoot()
  if (!root) return { root: null, python: null, ocr: false, embedding: false }
  const python = detectPython()
  if (!python) return { root, python: null, ocr: false, embedding: false }
  const manifest = readManifest(root)
  if (!manifest) return { root, python, ocr: false, embedding: false }
  const sitePackages = resolve(root, 'site-packages')
  const modelDir = getEmbedModelDir(root)
  const ocr = manifest.ocr === true && existsSync(sitePackages) && process.env.XJC_LOCAL_OCR !== 'off'
  const embedding = manifest.embedding === true
    && existsSync(resolve(modelDir, 'model.onnx'))
    && existsSync(resolve(modelDir, 'tokenizer.json'))
    && process.env.XJC_SEMANTIC_MEMORY !== 'off'
  return { root, python, ocr, embedding }
}

/** 物料化内嵌脚本（内容一致则跳过写盘）。返回脚本绝对路径。 */
export function materializeScript(root: string, filename: string, source: string): string {
  const dir = resolve(root, 'scripts')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, filename)
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8') === source) return path
  } catch { /* 读失败直接覆盖写 */ }
  writeFileSync(path, source, 'utf-8')
  return path
}

/** 解析子进程 stdout 中最后一行 JSON（脚本约定：协议 JSON 在 stdout 最后一行） */
export function parseLastJsonLine<T>(stdout: string): T | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as T
    } catch { /* 继续向上找 */ }
  }
  return null
}

function pytoolsEnv(root: string): Record<string, string | undefined> {
  return {
    ...process.env,
    XJC_PYTOOLS_SITE: resolve(root, 'site-packages'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
}

export interface OcrLine {
  text: string
  score: number
}

export interface OcrResult {
  ok: boolean
  lines?: OcrLine[]
  error?: string
  elapsed_ms?: number
}

/** 一次性 OCR 调用（RapidOCR 模型加载 + 推理约 2-5 秒；偶发调用不值得常驻） */
export async function runLocalOcr(imagePath: string): Promise<OcrResult> {
  const caps = detectPytoolsCapabilities()
  if (!caps.root || !caps.python || !caps.ocr) {
    return { ok: false, error: 'OCR_NOT_INSTALLED' }
  }
  const script = materializeScript(caps.root, 'ocr_cli.py', OCR_CLI_PY)
  try {
    const proc = Bun.spawn([caps.python, script, imagePath], {
      env: pytoolsEnv(caps.root),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => { try { proc.kill() } catch { /* 已退出 */ } }, OCR_TIMEOUT_MS)
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    clearTimeout(timeout)
    if (exitCode !== 0) {
      const parsed = parseLastJsonLine<OcrResult>(stdout)
      return parsed ?? { ok: false, error: `ocr exited with code ${exitCode}` }
    }
    return parseLastJsonLine<OcrResult>(stdout) ?? { ok: false, error: 'ocr produced no JSON output' }
  } catch (err) {
    safeLog('warn', { error: err instanceof Error ? err.message : String(err) }, 'Local OCR spawn failed')
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Embedding 常驻 worker（模型加载一次，后续毫秒级） ───────────────────────

interface WorkerRequest {
  resolvePromise: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

class EmbedWorker {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private nextId = 1
  private pending = new Map<number, WorkerRequest>()
  private restarts = 0
  private starting: Promise<boolean> | null = null
  private stdoutBuffer = ''

  /** 确保 worker 就绪（spawn + ping）。失败返回 false，超过重启上限后不再尝试。 */
  private ensureStarted(): Promise<boolean> {
    if (this.proc) return Promise.resolve(true)
    if (this.starting) return this.starting
    if (this.restarts >= WORKER_MAX_RESTARTS) return Promise.resolve(false)

    this.starting = (async () => {
      const caps = detectPytoolsCapabilities()
      if (!caps.root || !caps.python || !caps.embedding) return false
      const script = materializeScript(caps.root, 'embed_worker.py', EMBED_WORKER_PY)
      try {
        const proc = Bun.spawn([caps.python, script, getEmbedModelDir(caps.root)], {
          env: pytoolsEnv(caps.root),
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        this.proc = proc
        this.consumeStdout(proc)
        void proc.exited.then(() => this.handleExit())
        const pong = await this.request({ op: 'ping' }, EMBED_INIT_TIMEOUT_MS)
        if (!pong || (pong as { ok?: boolean }).ok !== true) {
          this.killProc()
          this.restarts += 1
          return false
        }
        safeLog('info', {}, 'Embedding worker ready')
        return true
      } catch (err) {
        safeLog('warn', { error: err instanceof Error ? err.message : String(err) }, 'Embedding worker spawn failed')
        this.killProc()
        this.restarts += 1
        return false
      }
    })()

    const result = this.starting
    void result.finally(() => { this.starting = null })
    return result
  }

  private consumeStdout(proc: ReturnType<typeof Bun.spawn>): void {
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          this.stdoutBuffer += decoder.decode(value, { stream: true })
          let newlineIdx = this.stdoutBuffer.indexOf('\n')
          while (newlineIdx >= 0) {
            const line = this.stdoutBuffer.slice(0, newlineIdx).trim()
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1)
            if (line.startsWith('{')) this.dispatchLine(line)
            newlineIdx = this.stdoutBuffer.indexOf('\n')
          }
        }
      } catch { /* 进程退出时流关闭属正常 */ }
    })()
  }

  private dispatchLine(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number }
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolvePromise(message)
    } catch { /* 非协议行忽略 */ }
  }

  private handleExit(): void {
    this.proc = null
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolvePromise(null)
      this.pending.delete(id)
    }
  }

  private killProc(): void {
    try { this.proc?.kill() } catch { /* 已退出 */ }
    this.proc = null
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const proc = this.proc
    if (!proc || !proc.stdin) return Promise.resolve(null)
    const id = this.nextId++
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolvePromise(null)
      }, timeoutMs)
      this.pending.set(id, { resolvePromise, timer })
      try {
        const writer = proc.stdin as { write(chunk: string): unknown }
        writer.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        resolvePromise(null)
      }
    })
  }

  /** 批量向量化。不可用/失败返回 null（调用方静默降级到词面检索）。 */
  async embed(texts: string[], timeoutMs = EMBED_REQUEST_TIMEOUT_MS): Promise<number[][] | null> {
    if (texts.length === 0) return []
    const ready = await this.ensureStarted()
    if (!ready) return null
    const response = await this.request({ op: 'embed', texts }, timeoutMs) as
      | { ok?: boolean; vectors?: number[][]; error?: string }
      | null
    if (!response || response.ok !== true || !Array.isArray(response.vectors)) {
      if (response?.error) safeLog('warn', { error: response.error }, 'Embedding request failed')
      return null
    }
    return response.vectors
  }

  dispose(): void {
    this.killProc()
  }
}

let sharedWorker: EmbedWorker | null = null

export function getEmbedWorker(): EmbedWorker {
  if (!sharedWorker) sharedWorker = new EmbedWorker()
  return sharedWorker
}

/** 归一化向量点积（BGE 输出已 L2 归一化，点积即余弦相似度） */
export function dotSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < len; i++) sum += (a[i] as number) * (b[i] as number)
  return sum
}
