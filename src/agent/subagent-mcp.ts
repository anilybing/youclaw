// [XJC] 子代理委派 MCP 工具（自主能力 P0）：mcp__agent__delegate
//
// 让主代理把一个明确、可隔离的子任务派给 agent.yaml 里定义的"专员"（config.agents），
// 专员在独立上下文里分治处理，返回结构化结果。核心价值：长文档/复杂表格等大任务不再
// 污染主对话上下文，且专员只带自己需要的工具、聚焦守则。
//
// 边界：
//  - 仅支持内联子代理定义（AgentDefinitionSchema，有 prompt/tools）；ref 引用型暂不支持。
//  - 子代理不再获得 delegate 工具（防套娃：customPool 本就不含 delegate）。
//  - MVP：子代理复用父模型；不注入父 SOUL/记忆/技能（保持隔离精简，靠自身 prompt+工具）。

import { Type } from '@mariozechner/pi-ai'
import type { Api, Model } from '@mariozechner/pi-ai'
import { createCodingTools } from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { AgentEntry } from './schema.ts'

/** pi-coding-agent 未在包根导出 Tool 类型，从 createCodingTools 返回值推导 */
type Tool = ReturnType<typeof createCodingTools>[number]
import { filterConfiguredTools } from './runtime-tools.ts'
import {
  runSubagentTask,
  SUBAGENT_DEFAULT_MAX_TOOL_CALLS,
  SUBAGENT_DEFAULT_TIMEOUT_MS,
  type SubagentRunResult,
  type SubagentRunSpec,
} from './subagent.ts'
import { getLogger } from '../logger/index.ts'

/** 子代理系统提示前言：说明其为专员、单任务、不得再派生下级 */
const SUBAGENT_PREAMBLE = [
  'You are a specialist sub-agent invoked by a lead agent to handle ONE delegated subtask in an isolated context.',
  'Work autonomously to completion, then return a concise, structured result (findings / output file paths / conclusions) as your final message.',
  'You cannot delegate further. Do not ask the lead agent questions — make reasonable assumptions and note them.',
  '',
].join('\n')

export interface SubagentToolDeps {
  /** 父代理的 config.agents（子代理定义表）*/
  subagents: Record<string, AgentEntry>
  cwd: string
  /** 可供子代理过滤的内置工具池（父已构建）*/
  builtinPool: Tool[]
  /** 可供子代理过滤的自定义工具池（父已构建，且不含 delegate 本身）*/
  customPool: ToolDefinition[]
  /** 父代理已解析模型（子代理未指定 model 或解析失败时回退用）*/
  parentModel: Model<Api>
  /** 解析子代理独立 model（返回 null 则回退父模型）；不传则子代理一律复用父模型 */
  resolveModel?: (modelId: string) => Model<Api> | null
  /** 父代理已构建的技能快照 prompt（<available_skills> 段）；注入子代理系统提示，
   *  让专员也能用父的技能脚本（如 sheet-processor 用 office-excel）。空则不注入。*/
  skillsPrompt?: string
  /** 可注入的执行器（测试用；默认真实 runSubagentTask）*/
  runTask?: (spec: SubagentRunSpec, task: string) => Promise<SubagentRunResult>
}

const DelegateParams = Type.Object({
  agent: Type.String({ description: 'Name of the specialist sub-agent to delegate to (must be one of the configured sub-agents listed in this tool\'s description).' }),
  task: Type.String({ description: 'A complete, self-contained description of the subtask for the specialist: the goal, the input (file paths / data), and the expected output. The specialist has NO access to this conversation, so include everything it needs.' }),
})

/** 仅内联定义可委派（有 prompt/description，无 ref） */
function isInlineDefinition(entry: AgentEntry): entry is Extract<AgentEntry, { prompt?: string }> {
  return !('ref' in entry) || (entry as { ref?: string }).ref === undefined
}

/**
 * 构造 delegate 工具。无可委派的内联子代理时返回 null（不挂工具）。
 */
export function createSubagentTool(deps: SubagentToolDeps): ToolDefinition | null {
  const inlineNames = Object.entries(deps.subagents)
    .filter(([, def]) => isInlineDefinition(def))
    .map(([name, def]) => ({ name, description: (def as { description?: string }).description ?? '' }))

  if (inlineNames.length === 0) return null

  const runTask = deps.runTask ?? runSubagentTask
  const roster = inlineNames.map((s) => `- ${s.name}: ${s.description}`).join('\n')

  return {
    name: 'mcp__agent__delegate',
    label: 'mcp__agent__delegate',
    description:
      'Delegate a well-scoped, self-contained subtask to a specialist sub-agent that runs in an ISOLATED context (it cannot see this conversation). '
      + 'Use this to divide-and-conquer large tasks — e.g. very long documents/PDFs or multi-step spreadsheet processing — so heavy work does not pollute your own context. '
      + 'The specialist returns a structured result you then integrate. Provide everything the specialist needs in `task` (goal + input paths/data + expected output).\n\n'
      + `Available specialists:\n${roster}`,
    parameters: DelegateParams,
    async execute(_id, args: { agent: string; task: string }) {
      const name = (args.agent ?? '').trim()
      const task = (args.task ?? '').trim()
      const available = inlineNames.map((s) => s.name).join(', ')

      if (!name) throw new Error(`delegate 需要提供 agent（专员名）。可选：${available}`)
      if (!task) throw new Error('delegate 需要提供 task（给专员的完整子任务描述）')

      const def = deps.subagents[name]
      if (!def) throw new Error(`没有名为「${name}」的专员。可选专员：${available}`)
      if (!isInlineDefinition(def)) throw new Error(`专员「${name}」是引用型（ref），暂不支持委派；可选内联专员：${available}`)

      const inline = def as { prompt?: string; description?: string; tools?: string[]; disallowedTools?: string[]; maxTurns?: number; model?: string }
      const persona = (inline.prompt || inline.description || '').trim()
      // 注入父技能快照，专员也能用父的技能脚本（office-excel 等）
      const skillsBlock = deps.skillsPrompt?.trim() ? `\n\n${deps.skillsPrompt.trim()}` : ''
      const systemPrompt = `${SUBAGENT_PREAMBLE}${persona}${skillsBlock}`

      // 按子代理白名单过滤父工具池；delegate 本就不在 customPool 里 → 天然防套娃
      const filterCfg = { allowedTools: inline.tools, disallowedTools: inline.disallowedTools }
      const builtinTools = filterConfiguredTools(deps.builtinPool, filterCfg)
      const customTools = filterConfiguredTools(deps.customPool, filterCfg)

      const maxToolCalls = typeof inline.maxTurns === 'number' && inline.maxTurns > 0 ? inline.maxTurns : SUBAGENT_DEFAULT_MAX_TOOL_CALLS

      // 子代理独立模型：定义了 model 且能解析则用之，否则回退父模型
      let model = deps.parentModel
      if (inline.model && deps.resolveModel) {
        const resolved = deps.resolveModel(inline.model)
        if (resolved) model = resolved
        else getLogger().warn({ subagent: name, model: inline.model, category: 'subagent' }, 'Sub-agent model unresolved, falling back to parent model')
      }

      getLogger().info({ subagent: name, tools: builtinTools.length + customTools.length, maxToolCalls, ownModel: model !== deps.parentModel, category: 'subagent' }, 'Delegating to sub-agent')

      const result = await runTask({
        systemPrompt,
        model,
        cwd: deps.cwd,
        builtinTools,
        customTools,
        maxToolCalls,
        timeoutMs: SUBAGENT_DEFAULT_TIMEOUT_MS,
      }, task)

      const abortNote = result.aborted
        ? `\n\n[注意：专员因${result.abortReason === 'timeout' ? '超时' : '达到步数上限'}被中止，以下为其已产出的部分结果，请据此判断是否需要补充或换方式处理]`
        : ''
      const body = result.text || '（专员未产出文本结果）'

      return {
        content: [{ type: 'text' as const, text: `专员「${name}」返回：\n\n${body}${abortNote}` }],
        details: {},
      }
    },
  }
}
