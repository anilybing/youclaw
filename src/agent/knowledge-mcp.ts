// [XJC] 知识库检索 MCP 工具（通用能力对齐 · T-A1）
// 让 agent 在对话中检索用户上传的知识库文档（FTS5 BM25，离线可用），
// 返回带来源文档名的片段；server/tool 结构与 skills-mcp.ts 保持同款。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { getKnowledgeService } from '../knowledge/service.ts'
import { getLogger } from '../logger/index.ts'

const SEARCH_TOPK_MAX = 8
const SEARCH_TOPK_DEFAULT = 5

const SearchKnowledgeParams = Type.Object({
  query: Type.String({ description: 'Keywords or a short question to search for in the user\'s knowledge base (matches document chunks via full-text search)' }),
  topK: Type.Optional(Type.Number({ description: `Maximum number of snippets to return (1-${SEARCH_TOPK_MAX}, default ${SEARCH_TOPK_DEFAULT})` })),
})

type KnowledgeToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

type RegisteredKnowledgeTool = {
  handler: (args: Record<string, unknown>) => Promise<KnowledgeToolResult>
}

export type KnowledgeMcpServer = {
  instance: {
    _registeredTools: Record<string, RegisteredKnowledgeTool>
  }
}

function textResult(text: string, isError = false): KnowledgeToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}

function clampTopK(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : SEARCH_TOPK_DEFAULT
  return Math.min(Math.max(n, 1), SEARCH_TOPK_MAX)
}

// ─── MCP server 工厂（与 skills-mcp.ts 同款结构） ─────────────────────────

export function createKnowledgeMcpServer(): KnowledgeMcpServer {
  const registeredTools: Record<string, RegisteredKnowledgeTool> = {
    search_knowledge: {
      handler: async (rawArgs: Record<string, unknown>) => {
        const logger = getLogger()
        const query = typeof rawArgs.query === 'string' ? rawArgs.query.trim() : ''
        const topK = clampTopK(rawArgs.topK)

        if (!query) {
          return textResult('search_knowledge 需要提供 query（检索关键词或问题）', true)
        }

        try {
          const service = getKnowledgeService()
          const hits = await service.search(query, topK)
          if (hits.length === 0) {
            const docCount = service.listDocs().length
            return textResult(JSON.stringify({
              query,
              hits: [],
              note: docCount === 0
                ? 'The knowledge base is empty. Tell the user they can upload documents on the Knowledge page.'
                : 'No matching content found in the knowledge base. Answer from your own knowledge and say the knowledge base had no relevant material.',
            }, null, 2))
          }
          return textResult(JSON.stringify({
            query,
            hits: hits.map((hit) => ({
              docTitle: hit.docTitle,
              snippet: hit.snippet,
              chunkIndex: hit.chunkIndex,
              score: hit.score,
            })),
            note: 'When you use these snippets in your answer, you MUST cite the source document title (docTitle) for each fact, e.g. 「according to <docTitle>」.',
          }, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ error: msg, query, category: 'knowledge' }, 'search_knowledge failed')
          return textResult(`检索知识库失败：${msg}`, true)
        }
      },
    },
  }

  return {
    instance: {
      _registeredTools: registeredTools,
    },
  }
}

// ─── 运行时 ToolDefinition 工厂（挂载见 runtime-tools.ts） ─────────────────

export function createKnowledgeTools(): ToolDefinition[] {
  const server = createKnowledgeMcpServer()
  const searchHandler = server.instance._registeredTools.search_knowledge!.handler

  return [
    {
      name: 'mcp__knowledge__search_knowledge',
      label: 'mcp__knowledge__search_knowledge',
      description:
        'Search the user\'s personal knowledge base (documents they uploaded on the Knowledge page) and return the most relevant text snippets, each with its source document title (docTitle). '
        + 'Use this tool whenever the user asks about their own documents, files, internal materials, or anything likely covered by uploaded content. '
        + `Results are ranked by relevance; topK caps the number of snippets (max ${SEARCH_TOPK_MAX}). `
        + 'IMPORTANT: answers based on these snippets MUST cite the source document title (docTitle) so the user knows where each fact came from. '
        + 'If the knowledge base has no relevant content, say so instead of inventing citations.',
      parameters: SearchKnowledgeParams,
      async execute(_toolCallId, args: { query: string; topK?: number }) {
        const result = await searchHandler(args)
        if (result.isError) {
          throw new Error(result.content[0]?.text || 'search_knowledge failed')
        }
        return {
          content: result.content,
          details: {},
        }
      },
    },
  ]
}
