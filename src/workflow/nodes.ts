// [XJC] 工作流·tool 节点注册表（对标扣子"插件节点"：确定性执行、零模型消耗）
// 与 agent/llm 节点的分工：能用确定性代码完成的步骤绝不烧模型 token。
// 注册表刻意白名单化——节点直接吃模板渲染后的参数，不经过任何模型审读，
// 因此只放行只读/安全操作；有副作用的能力（发货/渠道发消息）不进注册表。

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { getKnowledgeService } from '../knowledge/service.ts'
import { listSkus } from '../fulfillment/store.ts'
import { fetchRemoteMediaToBuffer } from '../channel/media-fetch.ts'
import { getPaths } from '../config/paths.ts'
import type { ToolEffectClass } from '../agentops/types.ts'
import {
  getTodayBusinessSnapshot,
  renderTodayBusinessBrief,
  type TodayBusinessSnapshot,
} from '../business/dashboard.ts'

export interface WorkflowNodeContext {
  /** 执行员工 id：文件型输入据此把读取限定在该员工工作区内。 */
  agentId: string
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

export const READ_FILE_MAX_BYTES = 256 * 1024
// 仅放行常见文本/数据类扩展名；二进制或未知类型一律拒绝，读入后再按 NUL 字节兜底判断。
export const READ_FILE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv',
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml',
  '.xml', '.html', '.htm', '.log', '.ini', '.conf',
])

/**
 * 工作流文件型输入的安全读取：把 rawPath 严格限定在给定员工工作区内。
 * - 相对路径按工作区根解析；绝对路径原样解析（越界由下方 realpath 兜底拦截）。
 * - 双侧 realpath 解析 symlink/junction，防软链/junction 逃逸与路径穿越。
 * - 仅放行文本类扩展名；大小 ≤256KB；读入后再按 NUL 字节兜底拒绝二进制。
 * 失败一律抛出带明确原因的错误。返回读取到的文本内容（可选 maxChars 截断）。
 * 独立导出便于直接单测（对齐 document-mcp 的 assertReadableDocumentPath 思路）。
 */
export function readWorkspaceTextFile(
  rawPath: string,
  workspaceDir: string,
  options?: { maxChars?: number },
): string {
  const requested = (rawPath ?? '').trim()
  if (!requested) throw new Error('read_file 需要 args.path（相对当前员工工作区，或工作区内绝对路径）')

  const ext = extname(requested).toLowerCase()
  if (!READ_FILE_TEXT_EXTENSIONS.has(ext)) {
    throw new Error(`read_file 仅支持文本类文件（${[...READ_FILE_TEXT_EXTENSIONS].map((e) => e.slice(1)).join('/')}）`)
  }

  let real: string
  try {
    real = realpathSync(resolve(workspaceDir, requested)) // 解析 symlink/junction + 存在性
  } catch {
    throw new Error('read_file 目标文件不存在或不可读')
  }
  let root: string
  try {
    root = realpathSync(resolve(workspaceDir))
  } catch {
    root = resolve(workspaceDir)
  }
  const normalized = process.platform === 'win32' ? real.toLowerCase() : real
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const insideWorkspace = normalized === normalizedRoot
    || normalized.startsWith(`${normalizedRoot}\\`)
    || normalized.startsWith(`${normalizedRoot}/`)
  if (!insideWorkspace) {
    throw new Error('read_file 只允许读取当前员工工作区内的文件（防止路径穿越/软链逃逸）')
  }

  const stat = statSync(real)
  if (!stat.isFile()) throw new Error('read_file 目标不是常规文件')
  if (stat.size > READ_FILE_MAX_BYTES) {
    throw new Error(`read_file 文件过大（${Math.ceil(stat.size / 1024)}KB，超过 ${READ_FILE_MAX_BYTES / 1024}KB 上限）`)
  }

  const buffer = readFileSync(real)
  if (buffer.includes(0)) {
    throw new Error('read_file 检测到二进制内容，仅支持文本文件')
  }
  const text = buffer.toString('utf8')
  const cap = Number(options?.maxChars)
  return Number.isFinite(cap) && cap > 0 ? text.slice(0, Math.floor(cap)) : text
}

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
    name: 'read_file',
    description: '读取当前员工工作区内一个文本文件的内容作为本步产出，供后续 {{steps.<id>.output}} 引用（仅限工作区内、≤256KB、文本类扩展名），args: { path, maxChars? }',
    effect: 'read',
    async execute(args, context) {
      const agentId = (context.agentId ?? '').trim()
      if (!agentId) throw new Error('read_file 无法确定当前员工工作区')
      const workspaceDir = resolve(getPaths().agents, agentId)
      return readWorkspaceTextFile(args.path ?? '', workspaceDir, { maxChars: Number(args.maxChars) })
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
