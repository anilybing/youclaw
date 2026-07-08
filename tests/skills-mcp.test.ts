/**
 * 对话式技能自管理工具（mcp__skills__*）测试
 * mock service 注入风格与 tests/task-mcp.test.ts 保持一致。
 */

import { describe, test, expect, mock } from 'bun:test'
import './setup.ts'
import {
  createSkillsMcpServer,
  createSkillsTools,
  type AgentSkillSummary,
  type AgentSkillsState,
  type SkillsMcpService,
} from '../src/agent/skills-mcp.ts'
import { resolveInstallSource } from '../src/skills/install-source-policy.ts'

function getToolHandler(server: any, name: string) {
  return server.instance._registeredTools[name].handler as (args: Record<string, unknown>) => Promise<any>
}

function makeSkill(name: string, extra: Partial<AgentSkillSummary> = {}): AgentSkillSummary {
  return {
    name,
    description: `${name} 的一句话描述`,
    path: `C:/skills/${name}/SKILL.md`,
    usable: true,
    ...extra,
  }
}

function makeService(state: AgentSkillsState, overrides: Partial<SkillsMcpService> = {}): SkillsMcpService & {
  getAgentSkillsState: ReturnType<typeof mock>
  setAgentSkills: ReturnType<typeof mock>
  installSkillFromMarketplace: ReturnType<typeof mock>
  isThirdPartySourcesEnabled: ReturnType<typeof mock>
} {
  return {
    getAgentSkillsState: mock(() => state),
    setAgentSkills: mock(async () => {}),
    installSkillFromMarketplace: mock(async () => {}),
    isThirdPartySourcesEnabled: mock(() => false),
    ...overrides,
  } as any
}

describe('skills-mcp list_skills', () => {
  test('splits skills into enabled vs installed-not-enabled by whitelist', async () => {
    const service = makeService({
      whitelist: ['office-doc', 'web-search'],
      installed: [makeSkill('office-doc'), makeSkill('office-ppt'), makeSkill('web-search')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'list_skills')({})
    expect(service.getAgentSkillsState).toHaveBeenCalledWith('agent-a')

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.all_enabled_wildcard).toBe(false)
    expect(parsed.enabled.map((s: any) => s.name)).toEqual(['office-doc', 'web-search'])
    expect(parsed.installed_not_enabled.map((s: any) => s.name)).toEqual(['office-ppt'])
  })

  test('query keyword filters both groups (name/description/slug)', async () => {
    const service = makeService({
      whitelist: ['office-doc'],
      installed: [
        makeSkill('office-doc'),
        makeSkill('office-ppt', { description: '生成 PPT 演示文稿' }),
        makeSkill('web-search'),
        makeSkill('ppt-master-local', { registrySlug: 'ppt-master' }),
      ],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'list_skills')({ query: 'PPT' })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.query).toBe('PPT')
    expect(parsed.enabled).toEqual([])
    expect(parsed.installed_not_enabled.map((s: any) => s.name)).toEqual(['office-ppt', 'ppt-master-local'])
  })

  test('wildcard whitelist reports all skills as enabled', async () => {
    const service = makeService({
      whitelist: ['*'],
      installed: [makeSkill('office-doc'), makeSkill('office-ppt')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'list_skills')({})
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.all_enabled_wildcard).toBe(true)
    expect(parsed.enabled.map((s: any) => s.name)).toEqual(['office-doc', 'office-ppt'])
    expect(parsed.installed_not_enabled).toEqual([])
  })
})

describe('skills-mcp set_skill_enabled', () => {
  test('enable appends skill to whitelist and reports next-turn effectiveness with SKILL.md path', async () => {
    const service = makeService({
      whitelist: ['office-doc'],
      installed: [makeSkill('office-doc'), makeSkill('office-ppt')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'office-ppt', enabled: true })

    expect(service.setAgentSkills).toHaveBeenCalledTimes(1)
    expect(service.setAgentSkills).toHaveBeenCalledWith('agent-a', ['office-doc', 'office-ppt'])
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('已为当前助理启用技能「office-ppt」')
    expect(result.content[0].text).toContain('下一条消息')
    expect(result.content[0].text).toContain('C:/skills/office-ppt/SKILL.md')
  })

  test('enable resolves marketplace slug to installed local skill name', async () => {
    const service = makeService({
      whitelist: [],
      installed: [makeSkill('ppt-master-local', { registrySlug: 'ppt-master' })],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'ppt-master', enabled: true })
    expect(service.setAgentSkills).toHaveBeenCalledWith('agent-a', ['ppt-master-local'])
    expect(result.isError).toBeUndefined()
  })

  test('enable is a no-op when whitelist is ["*"]', async () => {
    const service = makeService({
      whitelist: ['*'],
      installed: [makeSkill('office-ppt')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'office-ppt', enabled: true })

    expect(service.setAgentSkills).not.toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('已启用全部本机技能')
  })

  test('enable rejects a skill that is not installed locally', async () => {
    const service = makeService({
      whitelist: ['office-doc'],
      installed: [makeSkill('office-doc')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'no-such-skill', enabled: true })

    expect(service.setAgentSkills).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('本机未安装技能「no-such-skill」')
    expect(result.content[0].text).toContain('mcp__skills__install_skill')
  })

  test('disable with ["*"] whitelist materializes explicit list minus target', async () => {
    const service = makeService({
      whitelist: ['*'],
      installed: [makeSkill('office-doc'), makeSkill('office-ppt'), makeSkill('web-search')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'office-ppt', enabled: false })

    expect(service.setAgentSkills).toHaveBeenCalledTimes(1)
    expect(service.setAgentSkills).toHaveBeenCalledWith('agent-a', ['office-doc', 'web-search'])
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('已停用技能「office-ppt」')
    expect(result.content[0].text).toContain('显式技能列表')
  })

  test('disable removes skill from explicit whitelist', async () => {
    const service = makeService({
      whitelist: ['office-doc', 'office-ppt'],
      installed: [makeSkill('office-doc'), makeSkill('office-ppt')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'office-ppt', enabled: false })

    expect(service.setAgentSkills).toHaveBeenCalledWith('agent-a', ['office-doc'])
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('已停用技能「office-ppt」')
  })

  test('disable of an installed skill that is not enabled is a friendly no-op', async () => {
    const service = makeService({
      whitelist: ['office-doc'],
      installed: [makeSkill('office-doc'), makeSkill('office-ppt')],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'set_skill_enabled')({ slug: 'office-ppt', enabled: false })

    expect(service.setAgentSkills).not.toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('当前未启用')
  })
})

describe('skills-mcp install_skill', () => {
  test('successful install defaults to first-party source and auto-enables for current agent', async () => {
    const service = makeService({
      whitelist: ['office-doc'],
      installed: [makeSkill('office-doc'), makeSkill('ppt-master-local', { registrySlug: 'ppt-master' })],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'install_skill')({ slug: 'ppt-master' })

    expect(service.installSkillFromMarketplace).toHaveBeenCalledTimes(1)
    expect(service.installSkillFromMarketplace).toHaveBeenCalledWith('xiaojuclaw', 'ppt-master')
    expect(service.setAgentSkills).toHaveBeenCalledWith('agent-a', ['office-doc', 'ppt-master-local'])
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('已从小橘技能库安装技能「ppt-master-local」')
    expect(result.content[0].text).toContain('已为当前助理启用技能「ppt-master-local」')
  })

  test('untrusted third-party source is rejected before download when flag is off', async () => {
    const service = makeService({
      whitelist: [],
      installed: [],
    })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'install_skill')({ slug: 'anything', source: 'tencent' })

    expect(service.installSkillFromMarketplace).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('第三方技能源（tencent）当前未开放')
  })

  test('recommended source maps to tencent when third-party sources are enabled', async () => {
    const service = makeService(
      {
        whitelist: ['*'],
        installed: [makeSkill('ppt-master')],
      },
      { isThirdPartySourcesEnabled: mock(() => true) },
    )
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'install_skill')({ slug: 'ppt-master', source: 'recommended' })

    expect(service.installSkillFromMarketplace).toHaveBeenCalledWith('tencent', 'ppt-master')
    expect(result.isError).toBeUndefined()
    // 白名单是 ["*"]：安装后无需写白名单，启用为 no-op
    expect(service.setAgentSkills).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain('无需单独启用')
  })

  test('unknown source id is rejected', async () => {
    const service = makeService({ whitelist: [], installed: [] })
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'install_skill')({ slug: 'x', source: 'evil-market' })

    expect(service.installSkillFromMarketplace).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('未知或不受信任的技能源：evil-market')
  })

  test('registry errors (login/plan) pass through as friendly text', async () => {
    const service = makeService(
      { whitelist: [], installed: [] },
      {
        installSkillFromMarketplace: mock(async () => {
          throw new Error('请先登录后再使用小橘技能库')
        }),
      },
    )
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'install_skill')({ slug: 'ppt-master' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('安装技能「ppt-master」失败：请先登录后再使用小橘技能库')
  })

  test('already-installed error redirects to set_skill_enabled', async () => {
    const service = makeService(
      { whitelist: [], installed: [] },
      {
        installSkillFromMarketplace: mock(async () => {
          throw new Error('Skill "ppt-master" is already installed')
        }),
      },
    )
    const server = createSkillsMcpServer({ agentId: 'agent-a' }, { service }) as any

    const result = await getToolHandler(server, 'install_skill')({ slug: 'ppt-master' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('无需重复安装')
    expect(result.content[0].text).toContain('mcp__skills__set_skill_enabled')
  })
})

describe('install source policy', () => {
  test('resolveInstallSource trust matrix', () => {
    expect(resolveInstallSource(undefined, false)).toEqual({ ok: true, source: 'xiaojuclaw' })
    expect(resolveInstallSource('xiaojuclaw', false)).toEqual({ ok: true, source: 'xiaojuclaw' })
    expect(resolveInstallSource('tencent', true)).toEqual({ ok: true, source: 'tencent' })
    expect(resolveInstallSource('clawhub', true)).toEqual({ ok: true, source: 'clawhub' })
    expect(resolveInstallSource('recommended', true)).toEqual({ ok: true, source: 'tencent' })
    expect(resolveInstallSource('tencent', false).ok).toBe(false)
    expect(resolveInstallSource('clawhub', false).ok).toBe(false)
    expect(resolveInstallSource('recommended', false).ok).toBe(false)
    expect(resolveInstallSource('evil', true).ok).toBe(false)
  })
})

describe('skills-mcp runtime tools', () => {
  test('createSkillsTools exposes the three runtime tool names', () => {
    const tools = createSkillsTools(
      { agentId: 'agent-runtime' },
      { service: makeService({ whitelist: [], installed: [] }) },
    )

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__skills__list_skills',
      'mcp__skills__set_skill_enabled',
      'mcp__skills__install_skill',
    ])
  })

  test('install_skill tool description carries the user-consent policy', () => {
    const tools = createSkillsTools(
      { agentId: 'agent-runtime' },
      { service: makeService({ whitelist: [], installed: [] }) },
    )
    const installTool = tools.find((tool) => tool.name === 'mcp__skills__install_skill')!
    expect(installTool.description).toContain('only call it after the user agrees')
    const setTool = tools.find((tool) => tool.name === 'mcp__skills__set_skill_enabled')!
    expect(setTool.description).toContain('current agent only')
  })
})
