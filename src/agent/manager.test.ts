import { describe, test, expect, mock } from 'bun:test'
import { parse as parseYaml } from 'yaml'
import { AgentManager } from './manager.ts'
import { AgentConfigSchema } from './schema.ts'
import {
  OFFICE_ASSISTANT_AGENT_YAML, OFFICE_ASSISTANT_SOUL_MD,
  ECOMMERCE_ASSISTANT_AGENT_YAML, ECOMMERCE_ASSISTANT_SOUL_MD,
} from './templates.ts'

// Minimal mock dependencies
const mockEventBus = {} as any
const mockPromptBuilder = {} as any

// Create an AgentManager with preset agents
function createManager(agents: Array<{ id: string; chatIds?: string[] }>) {
  const manager = new AgentManager(mockEventBus, mockPromptBuilder)
  // Write directly to internal Map to avoid actual disk loading
  const map = (manager as any).agents as Map<string, any>
  for (const a of agents) {
    map.set(a.id, {
      config: {
        id: a.id,
        name: a.id,
        model: 'claude-sonnet-4-6',
        workspaceDir: '/tmp',
        telegram: a.chatIds ? { chatIds: a.chatIds } : undefined,
      },
      workspaceDir: '/tmp',
      runtime: {},
      state: {},
    })
  }
  return manager
}

describe('AgentManager.resolveAgent', () => {
  test('exact match on telegram chatId', () => {
    const manager = createManager([
      { id: 'agent-a', chatIds: ['tg:111'] },
      { id: 'agent-b', chatIds: ['tg:222'] },
    ])
    const result = manager.resolveAgent('tg:222')
    expect(result?.config.id).toBe('agent-b')
  })

  test('falls back to default agent when telegram chatId is not configured', () => {
    const manager = createManager([
      { id: 'default' },
    ])
    const result = manager.resolveAgent('tg:999')
    expect(result?.config.id).toBe('default')
  })

  test('web chatId falls back to default agent', () => {
    const manager = createManager([
      { id: 'default' },
    ])
    const result = manager.resolveAgent('web:abc-123')
    expect(result?.config.id).toBe('default')
  })

  test('falls back to first agent when no default agent exists', () => {
    const manager = createManager([
      { id: 'custom-agent' },
    ])
    const result = manager.resolveAgent('tg:999')
    expect(result?.config.id).toBe('custom-agent')
  })

  test('returns undefined when no agents exist', () => {
    const manager = createManager([])
    const result = manager.resolveAgent('tg:999')
    expect(result).toBeUndefined()
  })
})

// [XJC] T-D7：预置数字员工模板本身必须是合法可加载的配置
describe('office-assistant preset template', () => {
  test('agent.yaml 模板可解析且挂载全部 8 个办公技能', () => {
    const parsed = parseYaml(OFFICE_ASSISTANT_AGENT_YAML) as {
      id: string
      name: string
      skills: string[]
      memory: { enabled: boolean }
    }
    expect(parsed.id).toBe('office-assistant')
    expect(parsed.memory.enabled).toBe(true)
    expect(parsed.skills).toEqual([
      'office-ppt', 'office-doc', 'office-excel', 'office-pdf',
      'meeting-notes', 'weekly-report', 'email-draft', 'file-organizer',
    ])
  })

  test('SOUL 模板包含产出目录与 dry-run 红线约定', () => {
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('办公产出')
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('dry-run')
  })

  // [XJC] T-G4 编排一期：内联专员子代理配置合法且 SOUL 带派生守则
  test('agent.yaml 含 long-doc-processor 与 sheet-processor 两个内联子代理', () => {
    const parsed = parseYaml(OFFICE_ASSISTANT_AGENT_YAML) as {
      agents: Record<string, { description?: string; prompt?: string; tools?: string[]; disallowedTools?: string[] }>
    }
    expect(parsed.agents).toBeDefined()
    expect(Object.keys(parsed.agents)).toEqual(['long-doc-processor', 'sheet-processor'])

    const longDoc = parsed.agents['long-doc-processor']!
    expect(longDoc.description).toContain('长文档')
    expect(longDoc.prompt).toContain('分段')
    expect(longDoc.tools).toContain('mcp__document__parse_document')
    expect(longDoc.disallowedTools).toContain('WebSearch')

    const sheet = parsed.agents['sheet-processor']!
    expect(sheet.description).toContain('Excel')
    expect(sheet.prompt).toContain('office-excel')
    expect(sheet.tools).toContain('bash')
    expect(sheet.disallowedTools).toContain('WebSearch')
  })

  test('agent.yaml 模板整体通过 AgentConfigSchema 校验（内联子代理合法可加载）', () => {
    const parsed = parseYaml(OFFICE_ASSISTANT_AGENT_YAML)
    const result = AgentConfigSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(Object.keys(result.data.agents ?? {})).toEqual(['long-doc-processor', 'sheet-processor'])
    }
  })

  test('SOUL 模板包含派生守则与禁止套娃约束', () => {
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('派生')
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('禁止套娃')
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('不得再派生')
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('long-doc-processor')
    expect(OFFICE_ASSISTANT_SOUL_MD).toContain('sheet-processor')
  })
})

// [XJC] 电商能力包：预置数字员工「小橘电商助理」模板必须是合法可加载配置
describe('ecommerce-assistant preset template', () => {
  test('agent.yaml 模板可解析且挂载 6 个电商/复用技能', () => {
    const parsed = parseYaml(ECOMMERCE_ASSISTANT_AGENT_YAML) as {
      id: string
      name: string
      skills: string[]
      memory: { enabled: boolean }
    }
    expect(parsed.id).toBe('ecommerce-assistant')
    expect(parsed.memory.enabled).toBe(true)
    expect(parsed.skills).toEqual([
      'ecom-copywriter', 'ecom-compliance', 'ecom-image', 'ecom-analytics',
      'office-excel', 'office-doc',
    ])
  })

  test('agent.yaml 模板整体通过 AgentConfigSchema 校验', () => {
    const parsed = parseYaml(ECOMMERCE_ASSISTANT_AGENT_YAML)
    const result = AgentConfigSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  })

  test('SOUL 模板包含电商产出目录与合规红线约定', () => {
    expect(ECOMMERCE_ASSISTANT_SOUL_MD).toContain('电商产出')
    expect(ECOMMERCE_ASSISTANT_SOUL_MD).toContain('ecom-compliance')
    expect(ECOMMERCE_ASSISTANT_SOUL_MD).toContain('不覆盖原图')
  })
})
