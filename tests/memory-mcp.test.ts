// [XJC] 记忆 MCP 工具测试（学习强化）：确定性「记住/回忆」全链路
// —— remember 结构化落 MEMORY.md + 去重、scope=global 落 _global、recall FTS 命中。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import './setup.ts'
import { getPaths } from '../src/config/index.ts'
import { MemoryManager } from '../src/memory/manager.ts'
import { MemoryIndexer } from '../src/memory/indexer.ts'
import { createMemoryTools } from '../src/agent/memory-mcp.ts'

const indexer = new MemoryIndexer()
const memoryManager = new MemoryManager(null) // 不需要 LLM extractor
const createdAgentIds = new Set<string>()

function newAgentId(prefix: string) {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  createdAgentIds.add(id)
  return id
}

function memoryFile(agentId: string) {
  return resolve(getPaths().agents, agentId, 'MEMORY.md')
}

function toolsFor(agentId: string) {
  const [remember, recall] = createMemoryTools({ agentId, memoryManager })
  return { remember: remember!, recall: recall! }
}

/** 从工具返回的 content[0].text 解析 JSON */
async function runTool(tool: { execute: (id: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }, args: Record<string, unknown>) {
  const res = await tool.execute('t', args)
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>
}

beforeEach(() => {
  indexer.initTable()
  memoryManager.attachIndexer(indexer)
  createdAgentIds.add('_global')
})

afterEach(() => {
  for (const id of createdAgentIds) {
    rmSync(resolve(getPaths().agents, id), { recursive: true, force: true })
  }
  createdAgentIds.clear()
})

describe('mcp__memory__remember', () => {
  test('写入结构化 MEMORY.md：category→section、label→key', async () => {
    const agentId = newAgentId('mem')
    const { remember } = toolsFor(agentId)
    const out = await runTool(remember, { content: '跨境电商卖家，主营北美站', label: '业务类型', category: 'profile' })
    expect(out.status).toBe('saved')

    const md = readFileSync(memoryFile(agentId), 'utf-8')
    expect(md).toContain('## Profile')
    expect(md).toContain('业务类型')
    expect(md).toContain('跨境电商卖家，主营北美站')
  })

  test('相同内容重复记忆幂等去重（already_known）', async () => {
    const agentId = newAgentId('mem')
    const { remember } = toolsFor(agentId)
    const first = await runTool(remember, { content: '喜欢简洁直接的回答', label: '沟通偏好' })
    expect(first.status).toBe('saved')
    const second = await runTool(remember, { content: '喜欢简洁直接的回答', label: '沟通偏好' })
    expect(second.status).toBe('already_known')
  })

  test('scope=global 落到 _global 共享记忆', async () => {
    const agentId = newAgentId('mem')
    const { remember } = toolsFor(agentId)
    await runTool(remember, { content: '公司名叫小橘科技', label: '公司', scope: 'global' })

    expect(existsSync(memoryFile(agentId))).toBe(false) // 未写 agent 自己的
    const globalMd = readFileSync(resolve(getPaths().agents, '_global', 'memory', 'MEMORY.md'), 'utf-8')
    expect(globalMd).toContain('小橘科技')
  })

  test('空 content 抛错', async () => {
    const agentId = newAgentId('mem')
    const { remember } = toolsFor(agentId)
    await expect(remember.execute('t', { content: '   ' })).rejects.toThrow(/content/)
  })
})

describe('mcp__memory__recall', () => {
  test('能检索到此前 remember 的内容', async () => {
    const agentId = newAgentId('mem')
    const { remember, recall } = toolsFor(agentId)
    await runTool(remember, { content: '主力使用飞书和 Notion 协作', label: '协作工具', category: 'preferences' })

    const out = await runTool(recall, { query: 'Notion' })
    const hits = out.hits as Array<{ snippet: string }>
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.snippet.includes('Notion'))).toBe(true)
  })

  test('无命中返回空 hits', async () => {
    const agentId = newAgentId('mem')
    const { recall } = toolsFor(agentId)
    const out = await runTool(recall, { query: '完全不存在的关键词xyz' })
    expect((out.hits as unknown[]).length).toBe(0)
  })

  test('空 query 抛错', async () => {
    const agentId = newAgentId('mem')
    const { recall } = toolsFor(agentId)
    await expect(recall.execute('t', { query: '' })).rejects.toThrow(/query/)
  })
})
