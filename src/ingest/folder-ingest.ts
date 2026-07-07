// [XJC-PATCH] T-G6 本地文档摄取一期：白名单目录扫描 → 摘要进当日记忆
//
// 设计要点（隐私红线写死在实现里）：
// - 只扫用户在设置里显式添加的白名单目录，且只扫第一层（不递归，避免误扫整盘）；
// - 只把「确定性截断摘要」写进当日记忆，绝不复制原文副本；
// - 游标文件 ingest-state.json 只记录 path + mtime，不含任何文件内容；
// - 目录从白名单移除后，其游标条目随之清理（pruneIngestStateToFolders）。
//
// 扫描采用轮询比对 mtime 而非 fs.watch——U 盘/网络盘上 watch 不可靠，
// 轮询由 ingest-scheduler.ts 的 interval 驱动（默认每 15 分钟）。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { extractDocxText, extractPptxText, extractXlsxText } from '../document/parsers/office.ts'
import { getIngestSettings } from './settings.ts'

/** 支持的文档扩展名（与 document parsers 能力对齐 + 纯文本） */
export const SUPPORTED_EXTENSIONS = ['.docx', '.xlsx', '.pptx', '.pdf', '.txt', '.md'] as const

/**
 * 摘要截断长度。一期用确定性截断（前 N 字）做零成本摘要，不调 LLM。
 * [G1-HANDOFF] 真正的语义提炼交给 T-G1 每日蒸馏任务——它在 23:50 读取
 * 当日 memory/YYYY-MM-DD.md（含本模块写入的「文档摄取」段）并归纳成当日纪要。
 */
export const EXCERPT_MAX_CHARS = 4000

/** 优先绑定预置数字员工，缺席时回退默认 agent（与 memory/distill-scheduler.ts 同款约定） */
const PREFERRED_AGENT_ID = 'office-assistant'
const FALLBACK_AGENT_ID = 'default'

export interface FolderIngestDeps {
  /** agent 判存（index.ts 传 agentManager.getAgent 的布尔包装）；缺省时按 agent 工作区目录是否存在判断 */
  hasAgent?: (agentId: string) => boolean
  /** 测试注入时间 */
  now?: Date
}

export interface IngestedFile {
  path: string
  filename: string
  kind: 'new' | 'changed'
}

export interface FolderIngestResult {
  enabled: boolean
  agentId: string | null
  scannedFolders: number
  ingested: IngestedFile[]
  failures: Array<{ path: string; error: string }>
}

/** 游标条目：只存 mtime（隐私红线：不含文件内容/摘要） */
interface IngestStateEntry {
  mtimeMs: number
}

interface IngestState {
  version: 1
  files: Record<string, IngestStateEntry>
}

export function getIngestStatePath(): string {
  return resolve(getPaths().data, 'ingest-state.json')
}

function loadIngestState(): IngestState {
  const path = getIngestStatePath()
  if (!existsSync(path)) return { version: 1, files: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IngestState>
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      return { version: 1, files: parsed.files as Record<string, IngestStateEntry> }
    }
  } catch {
    // 损坏则重建（代价只是重扫一轮）
  }
  return { version: 1, files: {} }
}

function saveIngestState(state: IngestState): void {
  const path = getIngestStatePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isUnderFolder(filePath: string, folder: string): boolean {
  const parent = pathKey(resolve(folder))
  return pathKey(dirname(filePath)) === parent
}

/**
 * 隐私红线：目录从白名单移除后清理其游标条目。
 * 保留策略取反向——凡不在现有白名单第一层之下的条目一律删除。
 * 返回清理的条目数。设置更新（routes/ingest.ts）与每轮扫描开头都会调用。
 */
export function pruneIngestStateToFolders(folders: string[]): number {
  const state = loadIngestState()
  let pruned = 0
  for (const filePath of Object.keys(state.files)) {
    if (!folders.some((folder) => isUnderFolder(filePath, folder))) {
      delete state.files[filePath]
      pruned++
    }
  }
  if (pruned > 0) saveIngestState(state)
  return pruned
}

function resolveIngestAgentId(hasAgent?: (agentId: string) => boolean): string {
  if (hasAgent) {
    return hasAgent(PREFERRED_AGENT_ID) ? PREFERRED_AGENT_ID : FALLBACK_AGENT_ID
  }
  // 无注入时退化为工作区目录判存（scheduler 独立触发的场景）
  return existsSync(resolve(getPaths().agents, PREFERRED_AGENT_ID)) ? PREFERRED_AGENT_ID : FALLBACK_AGENT_ID
}

/** 提取文档纯文本。pdf 解析器模块加载重（pdfjs 顶层 await），仅在遇到 .pdf 时按需加载 */
async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.txt':
    case '.md':
      return readFileSync(filePath, 'utf8')
    case '.docx':
      return (await extractDocxText(readFileSync(filePath))).text
    case '.xlsx':
      return (await extractXlsxText(readFileSync(filePath))).text
    case '.pptx':
      return (await extractPptxText(readFileSync(filePath))).text
    case '.pdf': {
      const { extractPdfText } = await import('../document/parsers/pdf.ts')
      return (await extractPdfText(readFileSync(filePath))).text
    }
    default:
      throw new Error(`Unsupported extension: ${ext}`)
  }
}

/** 确定性截断摘要：合并空白后取前 EXCERPT_MAX_CHARS 字（一期不调 LLM，零成本） */
export function buildExcerpt(text: string, maxChars: number = EXCERPT_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return '（未提取到文本内容）'
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars)}…（全文约 ${collapsed.length} 字，仅存此摘要）`
}

/** 当日记忆文件用本地日期——与 G1 每日蒸馏（23:50 本地时区读 memory/<日期>.md）对齐 */
function localDateStr(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getDailyMemoryPath(agentId: string, now: Date): string {
  return resolve(getPaths().agents, agentId, 'memory', `${localDateStr(now)}.md`)
}

/**
 * 把本轮摄取条目追加到当日记忆的「文档摄取」段。
 * 只追加不改写既有内容（G1 蒸馏的幂等标记在文件头部，不能动）。
 * [G1-HANDOFF] 此处写入的摘要即日蒸馏的素材来源之一。
 */
function appendIngestEntries(
  agentId: string,
  entries: Array<{ filename: string; folder: string; kind: 'new' | 'changed'; excerpt: string }>,
  now: Date,
): void {
  if (entries.length === 0) return

  const filePath = getDailyMemoryPath(agentId, now)
  mkdirSync(dirname(filePath), { recursive: true })
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : `# ${localDateStr(now)}\n`
  const time = now.toTimeString().slice(0, 5)

  const lines = entries.map((entry) => {
    const verb = entry.kind === 'new' ? '新增文档' : '更新文档'
    // 隐私红线：仅存摘要，不复制原文副本
    return `- [${time}] ${verb}《${entry.filename}》（来源：本地文件夹 ${entry.folder}，仅存摘要不复制原文）：${entry.excerpt}`
  })
  const block = `\n## 文档摄取\n${lines.join('\n')}\n`
  writeFileSync(filePath, existing + block, 'utf8')
}

interface ScanCandidate {
  path: string
  filename: string
  folder: string
  mtimeMs: number
  kind: 'new' | 'changed'
}

/** 列出单个白名单目录第一层的受支持文档（跳过隐藏文件与 Office 锁文件 ~$xxx） */
function listFolderDocuments(folder: string): Array<{ path: string; filename: string; mtimeMs: number }> {
  const out: Array<{ path: string; filename: string; mtimeMs: number }> = []
  const dirEntries = readdirSync(folder, { withFileTypes: true })
  for (const entry of dirEntries) {
    if (!entry.isFile()) continue // 只扫第一层：子目录一律跳过
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue
    const ext = extname(entry.name).toLowerCase()
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) continue
    const path = resolve(folder, entry.name)
    try {
      out.push({ path, filename: entry.name, mtimeMs: statSync(path).mtimeMs })
    } catch {
      // 文件在列目录与 stat 之间被删除/锁定：跳过，下一轮再看
    }
  }
  return out
}

/**
 * 执行一轮白名单目录扫描：
 * 新增/修改的文档 → 解析文本 → 截断摘要 → 追加当日记忆 → 更新游标。
 * 单文件异常只记 failures 并跳过（游标不推进，下一轮自动重试），不中断整批。
 */
export async function runFolderIngest(deps: FolderIngestDeps = {}): Promise<FolderIngestResult> {
  const logger = getLogger()
  const settings = getIngestSettings()

  if (!settings.ingestEnabled) {
    return { enabled: false, agentId: null, scannedFolders: 0, ingested: [], failures: [] }
  }

  const now = deps.now ?? new Date()
  const agentId = resolveIngestAgentId(deps.hasAgent)

  // 白名单可能在两轮扫描之间被缩减：先清理已移除目录的游标条目（隐私红线）
  pruneIngestStateToFolders(settings.ingestFolders)

  const state = loadIngestState()
  const candidates: ScanCandidate[] = []
  const seenPaths = new Set<string>()
  let scannedFolders = 0

  for (const folder of settings.ingestFolders) {
    if (!existsSync(folder)) {
      logger.debug({ folder, category: 'folder-ingest' }, 'Ingest folder missing, skipped')
      continue
    }
    scannedFolders++
    for (const doc of listFolderDocuments(folder)) {
      seenPaths.add(doc.path)
      const cursor = state.files[doc.path]
      if (!cursor) {
        candidates.push({ ...doc, folder, kind: 'new' })
      } else if (cursor.mtimeMs !== doc.mtimeMs) {
        candidates.push({ ...doc, folder, kind: 'changed' })
      }
    }
  }

  // 清理已删除文件的游标条目（文件不在了，条目也不留）
  for (const knownPath of Object.keys(state.files)) {
    if (!seenPaths.has(knownPath)) delete state.files[knownPath]
  }

  const ingested: IngestedFile[] = []
  const failures: FolderIngestResult['failures'] = []
  const memoryEntries: Array<{ filename: string; folder: string; kind: 'new' | 'changed'; excerpt: string }> = []

  for (const candidate of candidates) {
    try {
      const text = await extractText(candidate.path)
      memoryEntries.push({
        filename: candidate.filename,
        folder: candidate.folder,
        kind: candidate.kind,
        excerpt: buildExcerpt(text),
      })
      state.files[candidate.path] = { mtimeMs: candidate.mtimeMs }
      ingested.push({ path: candidate.path, filename: candidate.filename, kind: candidate.kind })
    } catch (err) {
      // 单文件失败跳过不中断；游标不推进 → 传输中/被锁定的文件下一轮自动重试
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ path: candidate.path, error: message })
      logger.warn({ file: candidate.path, error: message, category: 'folder-ingest' }, 'Ingest file failed, skipped')
    }
  }

  appendIngestEntries(agentId, memoryEntries, now)
  saveIngestState(state)

  if (ingested.length > 0 || failures.length > 0) {
    logger.info(
      { agentId, scannedFolders, ingested: ingested.length, failures: failures.length, category: 'folder-ingest' },
      'Folder ingest scan finished',
    )
  }

  return { enabled: true, agentId, scannedFolders, ingested, failures }
}
