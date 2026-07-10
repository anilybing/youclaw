// [XJC] 子代理委派工具测试（自主 P0）：注入假 runner，验证专员解析/工具过滤/防套娃/错误。
// 不跑真实模型（runSubagentTask 走 SDK+模型）；隔离 runner 逻辑靠类型与手测覆盖。
import { describe, expect, test } from 'bun:test'
import './setup.ts'
import { createSubagentTool, type SubagentToolDeps } from '../src/agent/subagent-mcp.ts'
import type { SubagentRunSpec, SubagentRunResult } from '../src/agent/subagent.ts'
import type { AgentEntry } from '../src/agent/schema.ts'

const INLINE_AGENTS: Record<string, AgentEntry> = {
  'long-doc-processor': {
    description: '长文档专员',
    prompt: '你是长文档专员',
    tools: ['read', 'mcp__document__parse_document'],
    disallowedTools: ['WebSearch'],
    maxTurns: 40,
  },
  'ref-worker': { ref: 'some-top-level-agent', description: '引用型' } as AgentEntry,
}

// 假工具池：内置 read/bash + 自定义 doc/knowledge
const builtinPool = [
  { name: 'Read', label: 'Read', description: '', parameters: {}, execute: async () => ({}) },
  { name: 'Bash', label: 'Bash', description: '', parameters: {}, execute: async () => ({}) },
] as unknown as SubagentToolDeps['builtinPool']
const customPool = [
  { name: 'mcp__document__parse_document', label: '', description: '', parameters: {}, execute: async () => ({}) },
  { name: 'mcp__knowledge__search_knowledge', label: '', description: '', parameters: {}, execute: async () => ({}) },
] as unknown as SubagentToolDeps['customPool']

function makeDeps(overrides: Partial<SubagentToolDeps> = {}): { deps: SubagentToolDeps; calls: Array<{ spec: SubagentRunSpec; task: string }> } {
  const calls: Array<{ spec: SubagentRunSpec; task: string }> = []
  const runTask = async (spec: SubagentRunSpec, task: string): Promise<SubagentRunResult> => {
    calls.push({ spec, task })
    return { text: 'specialist result', toolCalls: 3, aborted: false }
  }
  return {
    deps: {
      subagents: INLINE_AGENTS,
      cwd: '/tmp/xjc-subagent-test',
      builtinPool,
      customPool,
      parentModel: {} as SubagentToolDeps['parentModel'],
      runTask,
      ...overrides,
    },
    calls,
  }
}

async function callDelegate(tool: NonNullable<ReturnType<typeof createSubagentTool>>, args: Record<string, unknown>) {
  return tool.execute('id', args as { agent: string; task: string })
}

describe('createSubagentTool', () => {
  test('无内联专员时返回 null（不挂工具）', () => {
    const tool = createSubagentTool(makeDeps({ subagents: {} }).deps)
    expect(tool).toBeNull()
  })

  test('工具描述列出可用内联专员（不含 ref 型）', () => {
    const tool = createSubagentTool(makeDeps().deps)!
    expect(tool.name).toBe('mcp__agent__delegate')
    expect(tool.description).toContain('long-doc-processor')
    expect(tool.description).not.toContain('ref-worker')
  })

  test('委派已知专员：按白名单过滤工具池并调用 runner，返回专员结果', async () => {
    const { deps, calls } = makeDeps()
    const tool = createSubagentTool(deps)!
    const res = await callDelegate(tool, { agent: 'long-doc-processor', task: '处理这份 PDF' })

    expect(calls).toHaveLength(1)
    const spec = calls[0]!.spec
    // 白名单 read + mcp__document__parse_document → 各池只留匹配项
    expect(spec.builtinTools.map((t) => t.name)).toEqual(['Read'])
    expect(spec.customTools.map((t) => t.name)).toEqual(['mcp__document__parse_document'])
    expect(spec.maxToolCalls).toBe(40) // 来自 def.maxTurns
    expect(spec.systemPrompt).toContain('你是长文档专员')
    expect(spec.systemPrompt).toContain('cannot delegate further') // 前言防套娃
    expect(calls[0]!.task).toBe('处理这份 PDF')
    expect(res.content[0]!.text).toContain('specialist result')
  })

  test('未知专员报错并列出可选', async () => {
    const tool = createSubagentTool(makeDeps().deps)!
    await expect(callDelegate(tool, { agent: 'nope', task: 'x' })).rejects.toThrow(/long-doc-processor/)
  })

  test('ref 引用型专员暂不支持', async () => {
    const tool = createSubagentTool(makeDeps().deps)!
    await expect(callDelegate(tool, { agent: 'ref-worker', task: 'x' })).rejects.toThrow(/暂不支持|ref/)
  })

  test('缺 task 报错', async () => {
    const tool = createSubagentTool(makeDeps().deps)!
    await expect(callDelegate(tool, { agent: 'long-doc-processor', task: '  ' })).rejects.toThrow(/task/)
  })

  test('专员被中止时结果带中止提示', async () => {
    const { deps } = makeDeps({
      runTask: async () => ({ text: 'partial', toolCalls: 41, aborted: true, abortReason: 'maxTurns' }),
    })
    const tool = createSubagentTool(deps)!
    const res = await callDelegate(tool, { agent: 'long-doc-processor', task: 'x' })
    expect(res.content[0]!.text).toContain('partial')
    expect(res.content[0]!.text).toContain('步数上限')
  })

  test('子代理独立 model：resolveModel 命中则用之', async () => {
    const childModel = { id: 'child' } as SubagentToolDeps['parentModel']
    const parentModel = { id: 'parent' } as SubagentToolDeps['parentModel']
    const subs = { worker: { description: 'w', prompt: 'p', model: 'glm-4.6' } as AgentEntry }
    const { deps, calls } = makeDeps({ subagents: subs, parentModel, resolveModel: () => childModel })
    const tool = createSubagentTool(deps)!
    await callDelegate(tool, { agent: 'worker', task: 't' })
    expect(calls[0]!.spec.model).toBe(childModel)
  })

  test('子代理 model 解析失败回退父模型', async () => {
    const parentModel = { id: 'parent' } as SubagentToolDeps['parentModel']
    const subs = { worker: { description: 'w', prompt: 'p', model: 'nonexistent' } as AgentEntry }
    const { deps, calls } = makeDeps({ subagents: subs, parentModel, resolveModel: () => null })
    const tool = createSubagentTool(deps)!
    await callDelegate(tool, { agent: 'worker', task: 't' })
    expect(calls[0]!.spec.model).toBe(parentModel)
  })

  test('未定义 model 的子代理复用父模型（不调 resolveModel）', async () => {
    const parentModel = { id: 'parent' } as SubagentToolDeps['parentModel']
    let resolveCalled = false
    const { deps, calls } = makeDeps({ parentModel, resolveModel: () => { resolveCalled = true; return null } })
    const tool = createSubagentTool(deps)!
    await callDelegate(tool, { agent: 'long-doc-processor', task: 't' })
    expect(calls[0]!.spec.model).toBe(parentModel)
    expect(resolveCalled).toBe(false)
  })

  test('注入父技能快照到子代理系统提示', async () => {
    const { deps, calls } = makeDeps({ skillsPrompt: '<available_skills>\noffice-excel: 表格处理\n</available_skills>' })
    const tool = createSubagentTool(deps)!
    await callDelegate(tool, { agent: 'long-doc-processor', task: 't' })
    expect(calls[0]!.spec.systemPrompt).toContain('<available_skills>')
    expect(calls[0]!.spec.systemPrompt).toContain('office-excel')
  })
})
