// [XJC] 知识库服务（通用能力对齐 · T-A1）
// addDocument：txt/md 直接解码，pdf/docx 复用 src/document/parsers 的既有解析
//   （与 src/agent/document-converter.ts 同源），chunkText（1600/160）分块后
//   knowledge_docs/knowledge_chunks/knowledge_fts 三表同事务写入。
// search：FTS5 MATCH + bm25 排序为基线。unicode61 不切中文词——入库与查询两侧
//   统一做 CJK 逐字切分（空格分隔），查询词包成 content:"…" 短语后 AND 连接：
//   既让中文任意子串可命中（短语 = 连续单字 token），又天然防 FTS5 语法注入。
//   snippet 从 knowledge_chunks 原文截取命中上下文（≤200 字），不用 FTS 侧的切分文本。
// TODO(T-B2)：向量增强接口位——配置 embedding provider（OpenAI 兼容 /embeddings）
//   + sqlite-vec 后做混合检索；本期按任务书只做纯 FTS5，离线永远可用。

import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'
import { chunkText } from '../document/chunker.ts'
import { initKnowledgeTables } from './store.ts'
import {
  KnowledgeError,
  KNOWLEDGE_UNSUPPORTED_TYPE,
  type KnowledgeDoc,
  type KnowledgeSearchHit,
} from './types.ts'

export interface AddDocumentInput {
  /** 原始文件名 */
  filename: string
  mediaType: string
  /** 原始文件二进制 */
  data: Uint8Array
}

/** 命中片段（含上下文）最大长度 */
const SNIPPET_MAX_CHARS = 200

// CJK 字符（中文 + 扩展 A + 兼容区 + 日文假名 + 韩文音节）：
// unicode61 会把连续 CJK 字符当成一个 token，导致「工资」搜不到「员工工资表」。
// 入库与查询两侧统一逐字切分后，短语查询即可实现中文子串匹配。
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** 把文本中的 CJK 字符切成空格分隔的单字（非 CJK 内容原样保留） */
function segmentForFts(text: string): string {
  let out = ''
  for (const ch of text) {
    out += CJK_CHAR_RE.test(ch) ? ` ${ch} ` : ch
  }
  return out.replace(/\s+/g, ' ').trim()
}

// 把用户查询编译成安全的 FTS5 MATCH 表达式：
// 每个空白分隔的词 → 剥引号 → CJK 逐字切分 → 包成 content:"…" 短语，AND 连接。
// 双引号短语内部 FTS5 语法全部失效（AND、OR、NOT、NEAR、星号、脱字符、括号等），
// 加上引号本身已被剥离，用户输入无法逃逸出短语边界——防注入报错。
// 列过滤 content: 是必须的：knowledge_fts 的 doc_id/chunk_index 列同样被索引，
// 不加过滤时英文查询可能误命中 UUID 片段。
function buildFtsMatchQuery(query: string): string | null {
  const phrases: string[] = []
  for (const term of query.trim().split(/\s+/)) {
    const segmented = segmentForFts(term.replace(/"/g, ' '))
    // 全标点的词（unicode61 会 token 化成空短语，引发语法错误）直接丢弃
    if (!/[\p{L}\p{N}]/u.test(segmented)) continue
    phrases.push(`content:"${segmented}"`)
  }
  return phrases.length > 0 ? phrases.join(' AND ') : null
}

/** 从原文分块中截取命中词的前后文摘录（总长 ≤ SNIPPET_MAX_CHARS，含省略号） */
function extractSnippet(content: string, terms: string[]): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= SNIPPET_MAX_CHARS) return normalized

  const lower = normalized.toLowerCase()
  let hitIndex = -1
  for (const term of terms) {
    if (!term) continue
    const idx = lower.indexOf(term.toLowerCase())
    if (idx >= 0 && (hitIndex < 0 || idx < hitIndex)) hitIndex = idx
  }
  if (hitIndex < 0) hitIndex = 0

  // 命中位置前留约 1/3 上文、后留约 2/3 下文
  let start = Math.max(0, hitIndex - Math.floor(SNIPPET_MAX_CHARS / 3))
  let end = start + SNIPPET_MAX_CHARS
  if (end > normalized.length) {
    end = normalized.length
    start = Math.max(0, end - SNIPPET_MAX_CHARS)
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < normalized.length ? '…' : ''
  return prefix + normalized.slice(start + prefix.length, end - suffix.length) + suffix
}

/** 按扩展名/MIME 提取纯文本；pdf/docx 解析器按需动态加载（pdfjs 较重） */
async function extractText(input: AddDocumentInput): Promise<string> {
  const ext = extname(input.filename).toLowerCase()
  const media = (input.mediaType || '').toLowerCase()

  if (media === 'application/pdf' || ext === '.pdf') {
    const { extractPdfText } = await import('../document/parsers/pdf.ts')
    return (await extractPdfText(input.data)).text
  }
  if (
    media === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || ext === '.docx'
  ) {
    const { extractDocxText } = await import('../document/parsers/office.ts')
    return (await extractDocxText(input.data)).text
  }
  if (ext === '.txt' || ext === '.md' || ext === '.markdown' || media.startsWith('text/')) {
    return new TextDecoder('utf-8').decode(input.data).replace(/^\uFEFF/, '')
  }
  throw new KnowledgeError(KNOWLEDGE_UNSUPPORTED_TYPE, '不支持的文件类型，请上传 txt / md / pdf / docx 文档')
}

function rowToDoc(row: Record<string, unknown>): KnowledgeDoc {
  return {
    id: String(row.id),
    title: String(row.title),
    mediaType: String(row.media_type || ''),
    sizeBytes: Number(row.size_bytes || 0),
    chunkCount: Number(row.chunk_count || 0),
    createdAt: String(row.created_at || ''),
  }
}

interface SearchRow {
  doc_id: string
  chunk_index: number
  bm25_score: number
  title: string
  content: string
}

export class KnowledgeService {
  constructor() {
    initKnowledgeTables()
  }

  listDocs(): KnowledgeDoc[] {
    const db = getDatabase()
    const rows = db.query('SELECT * FROM knowledge_docs ORDER BY created_at DESC LIMIT 500').all() as Record<string, unknown>[]
    return rows.map(rowToDoc)
  }

  deleteDoc(docId: string): boolean {
    const db = getDatabase()
    const existing = db.query('SELECT id FROM knowledge_docs WHERE id = ?').get(docId)
    if (!existing) return false
    // 三表同事务删除，避免中途失败留下孤儿分块/索引
    db.transaction(() => {
      db.run('DELETE FROM knowledge_docs WHERE id = ?', [docId])
      db.run('DELETE FROM knowledge_chunks WHERE doc_id = ?', [docId])
      db.run('DELETE FROM knowledge_fts WHERE doc_id = ?', [docId])
    })()
    return true
  }

  async addDocument(input: AddDocumentInput): Promise<KnowledgeDoc> {
    const text = (await extractText(input)).trim()
    const docId = randomUUID()
    const chunks = chunkText(text, { documentId: docId })
    if (!text || chunks.length === 0) {
      throw new KnowledgeError(KNOWLEDGE_UNSUPPORTED_TYPE, '未能从文档中提取到文本内容')
    }

    const doc: KnowledgeDoc = {
      id: docId,
      title: input.filename.trim() || 'document',
      mediaType: input.mediaType || '',
      sizeBytes: input.data.byteLength,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
    }

    const db = getDatabase()
    const insertAll = db.transaction(() => {
      db.run(
        `INSERT INTO knowledge_docs (id, title, media_type, size_bytes, chunk_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [doc.id, doc.title, doc.mediaType, doc.sizeBytes, doc.chunkCount, doc.createdAt],
      )
      const insertChunk = db.prepare(
        'INSERT INTO knowledge_chunks (doc_id, chunk_index, content) VALUES (?, ?, ?)',
      )
      const insertFts = db.prepare(
        'INSERT INTO knowledge_fts (doc_id, chunk_index, content) VALUES (?, ?, ?)',
      )
      for (const chunk of chunks) {
        insertChunk.run(docId, chunk.ordinal, chunk.content)
        insertFts.run(docId, String(chunk.ordinal), segmentForFts(chunk.content))
      }
    })
    insertAll()

    getLogger().info({
      docId,
      title: doc.title,
      chunkCount: doc.chunkCount,
      sizeBytes: doc.sizeBytes,
      category: 'knowledge',
    }, 'Knowledge document added')
    return doc
  }

  async search(query: string, topK = 8): Promise<KnowledgeSearchHit[]> {
    const match = buildFtsMatchQuery(query)
    if (!match) return []
    const limit = Math.min(Math.max(Math.floor(topK) || 8, 1), 20)

    const db = getDatabase()
    let rows: SearchRow[]
    try {
      // 别名避开 FTS5 保留的隐藏列名 rank；bm25 越小越相关，升序即最相关在前
      rows = db.query(
        `SELECT knowledge_fts.doc_id AS doc_id,
                CAST(knowledge_fts.chunk_index AS INTEGER) AS chunk_index,
                bm25(knowledge_fts) AS bm25_score,
                d.title AS title,
                c.content AS content
         FROM knowledge_fts
         JOIN knowledge_docs d ON d.id = knowledge_fts.doc_id
         JOIN knowledge_chunks c
           ON c.doc_id = knowledge_fts.doc_id
          AND c.chunk_index = CAST(knowledge_fts.chunk_index AS INTEGER)
         WHERE knowledge_fts MATCH ?
         ORDER BY bm25_score
         LIMIT ?`,
      ).all(match, limit) as SearchRow[]
    } catch (err) {
      // buildFtsMatchQuery 已保证语法安全，此处兜底：任何异常都不打断调用方
      getLogger().warn({
        query,
        error: err instanceof Error ? err.message : String(err),
        category: 'knowledge',
      }, 'Knowledge search failed')
      return []
    }

    const snippetTerms = query.trim().split(/\s+/)
      .map((term) => term.replace(/"/g, ' ').trim())
      .filter(Boolean)

    return rows.map((row) => ({
      docId: row.doc_id,
      docTitle: row.title,
      chunkIndex: row.chunk_index,
      snippet: extractSnippet(row.content, snippetTerms),
      // bm25 越小（负得越多）越相关，取反使「越大越相关」
      score: Math.round(-row.bm25_score * 1000) / 1000,
    }))
  }
}

let singleton: KnowledgeService | null = null

export function getKnowledgeService(): KnowledgeService {
  if (!singleton) singleton = new KnowledgeService()
  return singleton
}
