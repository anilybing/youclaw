// [XJC] 语义记忆（本地智能 B 轮）：本地 embedding 让记忆检索从「词面匹配」升级为「语义匹配」。
//
// 此前 FTS5 检索"发票"永远找不到"报销单据"——零词面重叠。本模块用本地 BGE 模型
// （pytools/runtime 的常驻 worker，模型只加载一次）把记忆文件切块向量化存 SQLite，
// 查询时向量点积取 top-k，与 FTS 命中互补合并。
//
// 边界：
// - embedding 全程本机，无网络；未安装 pytools（模型缺失）时一切函数静默降级为空结果；
// - 索引为懒同步：查询前按内容哈希增量向量化（只嵌入新/变更块），同一员工 5 分钟内不重复扫盘；
// - 每员工块数上限防膨胀，超限优先保长期记忆/日记，日志/会话归档靠后。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDatabase } from '../db/index.ts'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { detectPytoolsCapabilities, dotSimilarity, getEmbedWorker } from '../pytools/runtime.ts'

/** 单块目标大小（字符）：BGE-small 512 token 上限内，中文 ~480 字符是安全水位 */
const CHUNK_MAX_CHARS = 480
/** 碎块合并阈值：低于该长度的段落与相邻段合并 */
const CHUNK_MIN_CHARS = 40
/** 每员工向量块数上限（超限按文件类型优先级保留） */
const MAX_CHUNKS_PER_AGENT = 600
/** 同一员工两次扫盘同步的最小间隔 */
const SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000
/** 每次 embed 批大小（worker 单请求） */
const EMBED_BATCH_SIZE = 12
/** 语义命中的相似度门槛（BGE 归一化点积；低于此值视为不相关） */
const SIMILARITY_THRESHOLD = 0.42
/** 命中片段截断长度 */
const SNIPPET_MAX_CHARS = 220

/** 文件类型优先级（超限裁剪时序号小的优先保留） */
const FILE_TYPE_PRIORITY: Record<string, number> = {
  memory: 0,
  note: 1,
  summary: 2,
  conversation: 3,
  log: 4,
}

export interface SemanticHit {
  agentId: string
  fileType: string
  filePath: string
  snippet: string
  score: number
}

interface MemoryFileEntry {
  filePath: string
  fileType: string
  content: string
}

/** 按空行→单行的层级切块，碎段向前合并，超长段硬切 */
export function chunkMemoryText(content: string): string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''
  const flush = () => {
    const trimmed = current.trim()
    if (trimmed) chunks.push(trimmed)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > CHUNK_MAX_CHARS) flush()
    if (paragraph.length > CHUNK_MAX_CHARS) {
      flush()
      for (let i = 0; i < paragraph.length; i += CHUNK_MAX_CHARS) {
        chunks.push(paragraph.slice(i, i + CHUNK_MAX_CHARS))
      }
      continue
    }
    current = current ? `${current}\n${paragraph}` : paragraph
    if (current.length >= CHUNK_MAX_CHARS - CHUNK_MIN_CHARS) flush()
  }
  flush()

  return chunks.filter((chunk) => chunk.length >= CHUNK_MIN_CHARS)
}

function hashChunk(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 32)
}

function vectorToBlob(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer)
}

function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4))
}

/** 枚举与 FTS 索引同源的记忆文件（MEMORY.md + 日记 + 摘要 + 会话归档 + 日志） */
function enumerateMemoryFiles(agentId: string): MemoryFileEntry[] {
  const agentsDir = getPaths().agents
  const memoryDir = resolve(agentsDir, agentId, 'memory')
  const entries: MemoryFileEntry[] = []

  const pushFile = (filePath: string, fileType: string): void => {
    try {
      if (!existsSync(filePath)) return
      const content = readFileSync(filePath, 'utf-8')
      if (content.trim()) entries.push({ filePath, fileType, content })
    } catch { /* 单文件读失败跳过 */ }
  }

  pushFile(resolve(agentsDir, agentId, 'MEMORY.md'), 'memory')
  if (!existsSync(memoryDir)) return entries

  const safeList = (dir: string): string[] => {
    try { return readdirSync(dir) } catch { return [] }
  }

  for (const file of safeList(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))) {
    pushFile(resolve(memoryDir, file), 'note')
  }
  for (const file of safeList(resolve(memoryDir, 'summaries')).filter((f) => f.endsWith('.md'))) {
    pushFile(resolve(memoryDir, 'summaries', file), 'summary')
  }
  for (const entry of safeList(resolve(memoryDir, 'conversations'))) {
    const entryPath = resolve(memoryDir, 'conversations', entry)
    try {
      if (statSync(entryPath).isDirectory()) {
        for (const nested of safeList(entryPath).filter((f) => f.endsWith('.md'))) {
          pushFile(resolve(entryPath, nested), 'conversation')
        }
      } else if (entry.endsWith('.md')) {
        pushFile(entryPath, 'conversation')
      }
    } catch { /* skip */ }
  }
  for (const file of safeList(resolve(memoryDir, 'logs')).filter((f) => f.endsWith('.md'))) {
    pushFile(resolve(memoryDir, 'logs', file), 'log')
  }

  return entries
}

const lastSyncAt = new Map<string, number>()

/**
 * 懒同步某员工的语义索引：按内容哈希增量嵌入（只调 worker 处理新/变更块），删除失效行。
 * 未安装 embedding 能力时直接返回；异常静默（语义层永不影响主流程）。
 */
export async function syncAgentSemanticIndex(agentId: string, force = false): Promise<void> {
  const caps = detectPytoolsCapabilities()
  if (!caps.embedding) return
  const now = Date.now()
  if (!force && now - (lastSyncAt.get(agentId) ?? 0) < SYNC_MIN_INTERVAL_MS) return
  lastSyncAt.set(agentId, now)

  try {
    const db = getDatabase()
    const files = enumerateMemoryFiles(agentId)

    // 期望块集合（带上限裁剪：优先级小者先保留，同优先级新文件在前）
    const desired: Array<{ filePath: string; fileType: string; ord: number; content: string; hash: string }> = []
    const sortedFiles = [...files].sort((a, b) =>
      (FILE_TYPE_PRIORITY[a.fileType] ?? 9) - (FILE_TYPE_PRIORITY[b.fileType] ?? 9) || b.filePath.localeCompare(a.filePath))
    for (const file of sortedFiles) {
      if (desired.length >= MAX_CHUNKS_PER_AGENT) break
      const chunks = chunkMemoryText(file.content)
      for (let ord = 0; ord < chunks.length && desired.length < MAX_CHUNKS_PER_AGENT; ord++) {
        const content = chunks[ord]!
        desired.push({ filePath: file.filePath, fileType: file.fileType, ord, content, hash: hashChunk(content) })
      }
    }

    const existingRows = db
      .query('SELECT file_path, chunk_ord, hash FROM memory_semantic_chunks WHERE agent_id = ?')
      .all(agentId) as Array<{ file_path: string; chunk_ord: number; hash: string }>
    const existing = new Map(existingRows.map((row) => [`${row.file_path}#${row.chunk_ord}`, row.hash]))
    const desiredKeys = new Set(desired.map((chunk) => `${chunk.filePath}#${chunk.ord}`))

    // 删除失效行（文件删除 / 块数缩减 / 超限被裁）
    for (const row of existingRows) {
      if (!desiredKeys.has(`${row.file_path}#${row.chunk_ord}`)) {
        db.run('DELETE FROM memory_semantic_chunks WHERE agent_id = ? AND file_path = ? AND chunk_ord = ?', [agentId, row.file_path, row.chunk_ord])
      }
    }

    const pending = desired.filter((chunk) => existing.get(`${chunk.filePath}#${chunk.ord}`) !== chunk.hash)
    if (pending.length === 0) return

    const worker = getEmbedWorker()
    const nowIso = new Date().toISOString()
    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const batch = pending.slice(i, i + EMBED_BATCH_SIZE)
      const vectors = await worker.embed(batch.map((chunk) => chunk.content), 60_000)
      if (!vectors || vectors.length !== batch.length) return // worker 不可用/失败：本轮放弃，下次再补
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!
        db.run(
          `INSERT INTO memory_semantic_chunks (agent_id, file_path, chunk_ord, file_type, content, hash, vector, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, file_path, chunk_ord) DO UPDATE SET
             file_type = excluded.file_type, content = excluded.content,
             hash = excluded.hash, vector = excluded.vector, updated_at = excluded.updated_at`,
          [agentId, chunk.filePath, chunk.ord, chunk.fileType, chunk.content, chunk.hash, vectorToBlob(vectors[j]!), nowIso],
        )
      }
    }
    getLogger().info({ agentId, embedded: pending.length, total: desired.length, category: 'pytools' }, 'Semantic memory index synced')
  } catch (err) {
    try {
      getLogger().warn({ agentId, error: err instanceof Error ? err.message : String(err), category: 'pytools' }, 'Semantic index sync failed')
    } catch { /* logger 未初始化 */ }
  }
}

/**
 * 语义检索：查询向量 vs 员工全部记忆块点积 top-k。
 * 能力未安装 / worker 失败 / 无命中 → 空数组（调用方回退词面检索结果）。
 */
export async function searchSemanticMemory(agentId: string, query: string, limit = 5): Promise<SemanticHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const caps = detectPytoolsCapabilities()
  if (!caps.embedding) return []

  try {
    void syncAgentSemanticIndex(agentId) // 后台补索引，不阻塞本次查询
    const vectors = await getEmbedWorker().embed([trimmed])
    if (!vectors || vectors.length === 0) return []
    const queryVector = Float32Array.from(vectors[0]!)

    const rows = getDatabase()
      .query('SELECT file_type, file_path, content, vector FROM memory_semantic_chunks WHERE agent_id = ?')
      .all(agentId) as Array<{ file_type: string; file_path: string; content: string; vector: Uint8Array }>
    if (rows.length === 0) return []

    const scored = rows
      .map((row) => ({
        agentId,
        fileType: row.file_type,
        filePath: row.file_path,
        snippet: row.content.length > SNIPPET_MAX_CHARS ? `${row.content.slice(0, SNIPPET_MAX_CHARS)}…` : row.content,
        score: dotSimilarity(queryVector, blobToVector(row.vector)),
      }))
      .filter((hit) => hit.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)

    return scored.slice(0, Math.max(1, limit))
  } catch (err) {
    try {
      getLogger().warn({ agentId, error: err instanceof Error ? err.message : String(err), category: 'pytools' }, 'Semantic memory search failed')
    } catch { /* logger 未初始化 */ }
    return []
  }
}

/**
 * 合并词面与语义命中（供 recall 工具）：FTS 在前，语义补充在后，
 * 按「文件 + 片段前缀」去重，总数不超过 limit。
 */
export function mergeMemoryHits<T extends { filePath: string; snippet: string }>(
  ftsHits: T[],
  semanticHits: SemanticHit[],
  limit: number,
): Array<T | SemanticHit> {
  const merged: Array<T | SemanticHit> = []
  const seen = new Set<string>()
  const keyOf = (hit: { filePath: string; snippet: string }): string =>
    `${hit.filePath}#${hit.snippet.replace(/[>\s<.…]+/g, '').slice(0, 40)}`

  for (const hit of ftsHits) {
    const key = keyOf(hit)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(hit)
    if (merged.length >= limit) return merged
  }
  for (const hit of semanticHits) {
    const key = keyOf(hit)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(hit)
    if (merged.length >= limit) return merged
  }
  return merged
}

/**
 * 每轮注入的语义命中块（runtime 调用，带总预算超时）。
 * 与 memoryContext 已有内容按片段前缀去重；无新增命中返回 null（零开销）。
 */
export async function buildSemanticMemoryBlock(
  agentId: string,
  query: string,
  options?: { timeoutMs?: number; existingContext?: string },
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? 1500
  const hits = await Promise.race([
    searchSemanticMemory(agentId, query, 4),
    new Promise<SemanticHit[]>((resolvePromise) => setTimeout(() => resolvePromise([]), timeoutMs)),
  ])
  if (hits.length === 0) return null

  const existing = options?.existingContext ?? ''
  const fresh = hits.filter((hit) => {
    const probe = hit.snippet.replace(/…$/, '').slice(0, 60)
    return probe.length < 8 || !existing.includes(probe)
  })
  if (fresh.length === 0) return null

  return [
    '<semantic_memory_hits>',
    '以下是与当前请求语义相关的历史记忆片段（本地向量检索，无需向用户提及）：',
    ...fresh.map((hit) => `- [${hit.fileType}] ${hit.snippet}`),
    '</semantic_memory_hits>',
  ].join('\n')
}
