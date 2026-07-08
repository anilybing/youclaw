// [XJC] 知识库类型（通用能力对齐 · T-A1 底座）
// 用户上传资料 → 分块入库 → agent 检索并带来源引用回答。

export interface KnowledgeDoc {
  id: string
  /** 原始文件名（展示用） */
  title: string
  /** 原始文件 MIME */
  mediaType: string
  /** 原始文件大小（字节） */
  sizeBytes: number
  /** 分块数 */
  chunkCount: number
  createdAt: string
}

export interface KnowledgeChunk {
  docId: string
  chunkIndex: number
  content: string
}

export interface KnowledgeSearchHit {
  docId: string
  docTitle: string
  chunkIndex: number
  /** 命中片段（含上下文的摘录） */
  snippet: string
  /** 相关性分数（越大越相关） */
  score: number
}

/** 知识库错误码：不支持的文件类型 */
export const KNOWLEDGE_UNSUPPORTED_TYPE = 'KNOWLEDGE_UNSUPPORTED_TYPE'
/** 知识库错误码：功能尚未启用（底座骨架期） */
export const KNOWLEDGE_NOT_IMPLEMENTED = 'KNOWLEDGE_NOT_IMPLEMENTED'

export class KnowledgeError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
