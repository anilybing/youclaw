// [XJC] 知识库存储（通用能力对齐 · T-A1 底座）
// 三张表：knowledge_docs（文档元信息）、knowledge_chunks（分块正文）、
// knowledge_fts（FTS5 全文索引，unicode61，与 memory/indexer.ts 同款风格）。
// FTS5 BM25 是检索基线（零依赖、离线永远可用）；向量增强见任务书 T-B2。

import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'

let initialized = false

export function initKnowledgeTables(): void {
  if (initialized) return
  const db = getDatabase()
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      doc_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (doc_id, chunk_index)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      doc_id, chunk_index, content, tokenize='unicode61'
    );
  `)
  initialized = true
  getLogger().debug('knowledge tables initialized')
}
