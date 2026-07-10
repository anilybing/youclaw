import { describe, test, expect, mock } from 'bun:test'
import { parse as parseYaml } from 'yaml'
import { AgentManager } from './manager.ts'
import { AgentConfigSchema } from './schema.ts'
import {
  OFFICE_ASSISTANT_AGENT_YAML, OFFICE_ASSISTANT_SOUL_MD,
  ECOMMERCE_ASSISTANT_AGENT_YAML, ECOMMERCE_ASSISTANT_SOUL_MD,
  CONTENT_CREATOR_AGENT_YAML, CONTENT_CREATOR_SOUL_MD,
  FINANCE_ASSISTANT_AGENT_YAML, FINANCE_ASSISTANT_SOUL_MD,
  HR_ASSISTANT_AGENT_YAML, HR_ASSISTANT_SOUL_MD,
  SUPPORT_ASSISTANT_AGENT_YAML, SUPPORT_ASSISTANT_SOUL_MD,
  RESEARCH_ASSISTANT_AGENT_YAML, RESEARCH_ASSISTANT_SOUL_MD,
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
  test('agent.yaml 模板可解析且挂载全部 13 个办公/简报/数据/联网技能', () => {
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
      'daily-briefing', 'web-monitor', 'data-report', 'web-search', 'agent-browser',
      'office-automation', 'law-skills',
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
  test('agent.yaml 模板可解析且挂载 7 个电商/复用技能', () => {
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
      'office-excel', 'office-doc', 'web-monitor', 'agent-browser',
      'ecommerce-product-selector',
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

// [XJC] 内容创作能力包：预置数字员工「小橘创作助理」模板必须是合法可加载配置
describe('content-creator preset template', () => {
  test('agent.yaml 模板可解析且挂载 4 个创作技能 + web-search', () => {
    const parsed = parseYaml(CONTENT_CREATOR_AGENT_YAML) as {
      id: string
      name: string
      skills: string[]
      memory: { enabled: boolean }
    }
    expect(parsed.id).toBe('content-creator')
    expect(parsed.memory.enabled).toBe(true)
    expect(parsed.skills).toEqual([
      'content-article', 'content-xiaohongshu', 'content-video-script', 'content-calendar',
      'web-search', 'humanizer', 'promptmaster', 'weixin-article-writer',
    ])
  })

  test('agent.yaml 模板整体通过 AgentConfigSchema 校验', () => {
    const parsed = parseYaml(CONTENT_CREATOR_AGENT_YAML)
    const result = AgentConfigSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  })

  test('SOUL 模板包含创作产出目录与原创红线约定', () => {
    expect(CONTENT_CREATOR_SOUL_MD).toContain('创作产出')
    expect(CONTENT_CREATOR_SOUL_MD).toContain('不抄袭')
    expect(CONTENT_CREATOR_SOUL_MD).toContain('需核实')
  })
})

// [XJC] 后台职能能力包：财务/人事/客服助理模板必须是合法可加载配置
describe('back-office preset templates (finance/hr/support)', () => {
  const cases = [
    { name: 'finance-assistant', yaml: FINANCE_ASSISTANT_AGENT_YAML, skills: ['finance-bookkeeping', 'finance-invoice', 'finance-report', 'finance-budget', 'office-excel'] },
    { name: 'hr-assistant', yaml: HR_ASSISTANT_AGENT_YAML, skills: ['hr-jd', 'hr-resume-screen', 'hr-interview', 'hr-docs'] },
    { name: 'support-assistant', yaml: SUPPORT_ASSISTANT_AGENT_YAML, skills: ['support-reply', 'support-faq', 'support-ticket', 'support-review'] },
    { name: 'research-assistant', yaml: RESEARCH_ASSISTANT_AGENT_YAML, skills: ['doc-summarize', 'research-report', 'translate', 'web-extract', 'mind-map', 'web-search', 'agent-browser', 'global-biblio-base'] },
  ]

  for (const c of cases) {
    test(`${c.name} agent.yaml 可解析且挂载预期技能`, () => {
      const parsed = parseYaml(c.yaml) as { id: string; skills: string[]; memory: { enabled: boolean } }
      expect(parsed.id).toBe(c.name)
      expect(parsed.memory.enabled).toBe(true)
      expect(parsed.skills).toEqual(c.skills)
    })

    test(`${c.name} agent.yaml 通过 AgentConfigSchema 校验`, () => {
      expect(AgentConfigSchema.safeParse(parseYaml(c.yaml)).success).toBe(true)
    })
  }

  test('三个后台助理 SOUL 均含产出目录与红线', () => {
    expect(FINANCE_ASSISTANT_SOUL_MD).toContain('财务产出')
    expect(FINANCE_ASSISTANT_SOUL_MD).toContain('需核实')
    expect(HR_ASSISTANT_SOUL_MD).toContain('人事产出')
    expect(HR_ASSISTANT_SOUL_MD).toContain('反歧视')
    expect(SUPPORT_ASSISTANT_SOUL_MD).toContain('客服产出')
  })

  test('研究助理 SOUL 含产出目录与来源可追溯红线', () => {
    expect(RESEARCH_ASSISTANT_SOUL_MD).toContain('研究产出')
    expect(RESEARCH_ASSISTANT_SOUL_MD).toContain('来源')
  })
})
