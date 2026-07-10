// [XJC] 记忆 MCP 工具（学习能力强化）：把「用户显式教学」做成确定性动作。
// 此前 agent 只能靠 prompt 自觉去 Write MEMORY.md，经常漏记/误记（三方调研并列 P0）。
// 现提供两工具，落到既有分层记忆栈（结构化去重 + FTS 重建索引）：
//   mcp__memory__remember —— 记住一条长期事实/偏好（用户说「记住…」时必调）
//   mcp__memory__recall   —— 跨会话检索已记住的内容（回答涉及用户历史偏好/背景时用）
// 结构/风格对齐 knowledge-mcp / media-mcp。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { MemoryManager } from '../memory/index.ts'
import { getLogger } from '../logger/index.ts'

const GLOBAL_AGENT_ID = '_global'
const RECALL_LIMIT_MAX = 8
const RECALL_LIMIT_DEFAULT = 5

const RememberParams = Type.Object({
  content: Type.String({ description: 'The fact / preference / background to remember, phrased as a concise standalone statement (e.g. "用户是跨境电商卖家，主营北美站").' }),
  label: Type.Optional(Type.String({ description: 'Short key/label for this memory (e.g. "业务类型"). Recommended: makes the memory tidy and lets a later remember with the same label update it in place.' })),
  category: Type.Optional(Type.String({ description: 'One of: profile | schedule | preferences | relationships | projects | notes. Defaults to preferences. Controls which MEMORY.md section it lands in.' })),
  scope: Type.Optional(Type.String({ description: '"agent" (default) stores under the current employee; "global" stores in shared memory visible to all employees (use for cross-role facts like the user\'s name/company).' })),
})

const RecallParams = Type.Object({
  query: Type.String({ description: 'Keywords or a short question to look up in what you have previously remembered about this user (full-text search over long-term memory).' }),
  limit: Type.Optional(Type.Number({ description: `Max snippets to return (1-${RECALL_LIMIT_MAX}, default ${RECALL_LIMIT_DEFAULT}).` })),
})

type MemoryToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, never>
}

function ok(text: string): MemoryToolResult {
  return { content: [{ type: 'text', text }], details: {} }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : RECALL_LIMIT_DEFAULT
  return Math.min(Math.max(n, 1), RECALL_LIMIT_MAX)
}

export function createMemoryTools(params: { agentId: string; memoryManager: MemoryManager }): ToolDefinition[] {
  const { agentId, memoryManager } = params

  return [
    {
      name: 'mcp__memory__remember',
      label: 'mcp__memory__remember',
      description:
        'Persist a durable fact, preference, or background detail about the user to long-term memory so future conversations benefit. '
        + 'CALL THIS whenever the user says "记住/remember ..." or reveals a stable fact (their role, company, tools, preferences, recurring needs). '
        + 'It writes structured, de-duplicated memory (same label updates in place) — far more reliable than editing files yourself. '
        + 'Use scope="global" for cross-role facts (name, company, language). Do NOT store secrets, passwords, or one-off task details.',
      parameters: RememberParams,
      async execute(_id, args: { content: string; label?: string; category?: string; scope?: string }) {
        const content = (args.content ?? '').trim()
        if (!content) throw new Error('remember 需要提供 content（要记住的内容）')
        const targetAgent = args.scope === 'global' ? GLOBAL_AGENT_ID : agentId
        try {
          const changed = memoryManager.rememberFact(targetAgent, {
            section: args.category,
            key: args.label,
            value: content,
          })
          return ok(JSON.stringify({
            remembered: content,
            scope: args.scope === 'global' ? 'global' : 'agent',
            status: changed ? 'saved' : 'already_known',
            note: changed ? '已写入长期记忆，后续对话会自动带上。' : '这条记忆此前已存在，无需重复记录。',
          }, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          getLogger().error({ error: msg, agentId: targetAgent, category: 'memory' }, 'remember failed')
          throw new Error(`写入记忆失败：${msg}`)
        }
      },
    },
    {
      name: 'mcp__memory__recall',
      label: 'mcp__memory__recall',
      description:
        'Search your long-term memory of this user (things previously remembered or distilled from past chats) and return the most relevant snippets. '
        + 'Use when the user references earlier context ("上次说的…"), asks about their own preferences/history, or when personalization would help. '
        + 'Recent memory is already injected into your context automatically — use recall to reach older or specific facts.',
      parameters: RecallParams,
      async execute(_id, args: { query: string; limit?: number }) {
        const query = (args.query ?? '').trim()
        if (!query) throw new Error('recall 需要提供 query（检索关键词）')
        const limit = clampLimit(args.limit)
        try {
          const hits = memoryManager.recallMemory(agentId, query, limit)
          if (hits.length === 0) {
            return ok(JSON.stringify({ query, hits: [], note: '长期记忆中没有相关内容（可能尚未记录）。' }, null, 2))
          }
          return ok(JSON.stringify({
            query,
            hits: hits.map((h) => ({ snippet: h.snippet, source: h.fileType })),
          }, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          getLogger().error({ error: msg, agentId, category: 'memory' }, 'recall failed')
          throw new Error(`检索记忆失败：${msg}`)
        }
      },
    },
  ]
}
