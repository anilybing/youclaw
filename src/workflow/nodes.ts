// [XJC] 工作流·tool 节点注册表（对标扣子"插件节点"：确定性执行、零模型消耗）
// 与 agent/llm 节点的分工：能用确定性代码完成的步骤绝不烧模型 token。
// 注册表刻意白名单化——节点直接吃模板渲染后的参数，不经过任何模型审读，
// 因此只放行只读/安全操作；有副作用的能力（发货/渠道发消息）不进注册表。

import { getKnowledgeService } from '../knowledge/service.ts'
import { listSkus } from '../fulfillment/store.ts'
import { fetchRemoteMediaToBuffer } from '../channel/media-fetch.ts'
import type { ToolEffectClass } from '../agentops/types.ts'
import {
  getTodayBusinessSnapshot,
  renderTodayBusinessBrief,
  type TodayBusinessSnapshot,
} from '../business/dashboard.ts'

export interface WorkflowNodeContext {
  workflowId: string
  workflowRunId: string
  traceId: string
  stepId: string
  stepIndex: number
  itemIndex?: number
  signal: AbortSignal
}

export interface WorkflowNodeTool {
  name: string
  description: string
  effect: ToolEffectClass
  /** args 为模板渲染后的纯字符串键值；context 由 runner 注入且不可由用户伪造。 */
  execute: (args: Record<string, string>, context: WorkflowNodeContext) => Promise<string>
}

const HTTP_GET_MAX_BYTES = 512 * 1024
const HTTP_GET_TIMEOUT_MS = 15_000
const HTTP_GET_DEFAULT_TEXT_CAP = 20_000
const HTTP_GET_MAX_TEXT_CAP = 50_000

const TOOLS: WorkflowNodeTool[] = [
  {
    name: 'knowledge_search',
    description: '检索本机知识库，args: { query, topK? } → 命中片段 JSON（含来源 docTitle）',
    effect: 'read',
    async execute(args) {
      const query = (args.query ?? '').trim()
      if (!query) throw new Error('knowledge_search 需要 args.query')
      const topK = Math.min(Math.max(1, Number(args.topK) || 8), 20)
      const hits = await getKnowledgeService().search(query, topK)
      return JSON.stringify(hits.map((h) => ({ docTitle: h.docTitle, snippet: h.snippet, score: h.score })), null, 2)
    },
  },
  {
    name: 'http_get',
    description: '抓取一个公网 URL 的文本内容（SSRF 防护：拒内网/保留地址；512KB/15s 上限），args: { url, maxChars? }',
    effect: 'network',
    async execute(args) {
      const url = (args.url ?? '').trim()
      if (!url) throw new Error('http_get 需要 args.url')
      const requestedCap = Number(args.maxChars)
      const textCap = Number.isFinite(requestedCap) && requestedCap > 0
        ? Math.min(Math.max(1_000, Math.floor(requestedCap)), HTTP_GET_MAX_TEXT_CAP)
        : HTTP_GET_DEFAULT_TEXT_CAP
      const { buffer } = await fetchRemoteMediaToBuffer(url, { maxBytes: HTTP_GET_MAX_BYTES, timeoutMs: HTTP_GET_TIMEOUT_MS })
      return buffer.toString('utf8').slice(0, textCap)
    },
  },
  {
    name: 'fulfillment_list_stock',
    description: '查询虚拟商品卡密库存概览（只读），args: {}',
    effect: 'read',
    async execute() {
      return JSON.stringify(listSkus().map((s) => ({ id: s.id, title: s.title, available: s.available, delivered: s.delivered })), null, 2)
    },
  },
  {
    name: 'today_business_snapshot',
    description: '读取本机经营画像、今日工作流/定时任务/计划/AI 用量，生成脱敏只读快照，args: {}',
    effect: 'read',
    async execute(_args, context) {
      return JSON.stringify(getTodayBusinessSnapshot({
        excludeWorkflowRunId: context.workflowRunId,
      }))
    },
  },
  {
    name: 'render_today_business_brief',
    description: '校验候选行动 ID，并用经营快照确定性渲染今日简报；模型不能改写事实，args: { snapshot, ranking }',
    effect: 'read',
    async execute(args) {
      let snapshot: TodayBusinessSnapshot
      try {
        snapshot = JSON.parse(args.snapshot ?? '') as TodayBusinessSnapshot
      } catch {
        throw new Error('render_today_business_brief 需要有效的 args.snapshot JSON')
      }
      return renderTodayBusinessBrief(snapshot, args.ranking ?? '')
    },
  },
]

const REGISTRY = new Map(TOOLS.map((t) => [t.name, t]))

export function hasWorkflowNodeTool(name: string): boolean {
  return REGISTRY.has(name.trim())
}

export function getWorkflowNodeTool(name: string): WorkflowNodeTool | null {
  return REGISTRY.get(name.trim()) ?? null
}

export function listWorkflowNodeTools(): Array<{ name: string; description: string; effect: ToolEffectClass }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, effect: t.effect }))
}
