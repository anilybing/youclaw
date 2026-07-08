import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { buildRuntimeCustomTools, filterConfiguredTools, normalizeToolName } from './runtime-tools.ts'

describe('runtime-tools', () => {
  test('normalizeToolName trims and lowercases names', () => {
    expect(normalizeToolName('  MCP__Task__List_Tasks  ')).toBe('mcp__task__list_tasks')
  })

  test('filterConfiguredTools respects allowedTools and disallowedTools', () => {
    const tools = [
      { name: 'Bash' },
      { name: 'Read' },
      { name: 'mcp__task__list_tasks' },
    ]

    const filtered = filterConfiguredTools(tools, {
      allowedTools: ['bash', 'mcp__task__list_tasks'],
      disallowedTools: ['bash'],
    } as any)

    expect(filtered).toEqual([
      { name: 'mcp__task__list_tasks' },
    ])
  })

  test('buildRuntimeCustomTools includes built-in task tools', async () => {
    const result = await buildRuntimeCustomTools({
      config: {} as any,
      browserManager: null,
      secretsManager: null,
      chatId: 'chat-1',
      agentId: 'agent-1',
    })

    const names = (result.tools as ToolDefinition[]).map((tool) => tool.name)
    expect(names).toContain('mcp__task__list_tasks')
    expect(names).toContain('mcp__task__update_task')
    expect(names).toContain('mcp__skills__list_skills')
    expect(names).toContain('mcp__skills__set_skill_enabled')
    expect(names).toContain('mcp__skills__install_skill')

    await result.dispose()
  })
})
