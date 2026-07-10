// [XJC] 对话式技能自管理：让 agent 在对话中查看/启用/停用/按需安装技能，
// 用户无需进设置页勾选。写回 agent.yaml + reloadAgents 的语义与
// PUT /api/agents/:id 保持一致（见 src/routes/agents.ts）。
import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import type { AgentManager } from './manager.ts'
import type { SkillsLoader } from '../skills/loader.ts'
import type { RegistryManager } from '../skills/registry.ts'
import {
  INSTALL_SOURCE_LABELS,
  resolveInstallSource,
  type MarketplaceInstallSource,
} from '../skills/install-source-policy.ts'

export type { MarketplaceInstallSource }

export interface SkillsToolContext {
  agentId: string
}

/** 提供给工具层的技能摘要（默认实现由 SkillsLoader 的 Skill 映射而来） */
export interface AgentSkillSummary {
  name: string
  description: string
  path: string
  registrySlug?: string
  usable: boolean
}

export interface AgentSkillsState {
  /** agent.yaml 中的 skills 白名单（加载时已归一化：通配符恒为 ["*"]） */
  whitelist: string[] | undefined
  /** 本机对该 agent 可见的全部已安装技能（builtin/user/workspace 三层合并后） */
  installed: AgentSkillSummary[]
}

/** 推荐目录里"尚未安装"的可发现技能（离线本地目录，供 agent 按需发现/推荐） */
export interface DiscoverableSkill {
  slug: string
  displayName: string
  summary: string
}

export interface SkillsMcpService {
  getAgentSkillsState(agentId: string): Promise<AgentSkillsState> | AgentSkillsState
  /** 将新的 skills 白名单写回 agent.yaml 并热重载所有 agent */
  setAgentSkills(agentId: string, skills: string[]): Promise<void> | void
  installSkillFromMarketplace(source: MarketplaceInstallSource, slug: string): Promise<void> | void
  /** 第三方技能源是否开放（默认关，只留自有源） */
  isThirdPartySourcesEnabled(): boolean
  /** 按关键词检索"推荐但尚未安装"的技能目录（离线，供 discover_skills 工具） */
  discoverRecommendedSkills(query: string, limit: number): Promise<DiscoverableSkill[]> | DiscoverableSkill[]
}

export interface SkillsMcpOptions {
  service?: SkillsMcpService
}

type SkillsToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

type RegisteredSkillsTool = {
  handler: (args: Record<string, unknown>) => Promise<SkillsToolResult>
}

export type SkillsMcpServer = {
  instance: {
    _registeredTools: Record<string, RegisteredSkillsTool>
  }
}

// ─── 运行时依赖注册（index.ts 启动时装配，与 channel/outbound-service 同款单例风格）───

export interface SkillsMcpRuntimeDeps {
  agentManager: AgentManager
  skillsLoader: SkillsLoader
  registryManager: RegistryManager
}

let runtimeDeps: SkillsMcpRuntimeDeps | null = null

export function configureSkillsMcpRuntime(deps: SkillsMcpRuntimeDeps): void {
  runtimeDeps = deps
}

/** Test-only: clear registered deps so tests do not leak state into each other. */
export function resetSkillsMcpRuntime(): void {
  runtimeDeps = null
}

function requireRuntimeDeps(): SkillsMcpRuntimeDeps {
  if (!runtimeDeps) {
    throw new Error('技能管理服务尚未初始化，请稍后重试')
  }
  return runtimeDeps
}

// 第三方技能源开关（远程配置 skills.thirdparty_enabled）短 TTL 缓存：
// install_skill 才触发，且 30s 内复用，避免每次调用都读盘解析。
// 用户本地偏好存在前端 Tauri store，后端读不到；只认远程配置缓存（默认 false）——
// 宁可保守拒绝，也不放行默认隐藏的第三方源。
const THIRDPARTY_FLAG_TTL_MS = 30_000
let thirdPartyFlagCache: { value: boolean; at: number } | null = null

function readThirdPartySourcesFlag(): boolean {
  const now = Date.now()
  if (thirdPartyFlagCache && now - thirdPartyFlagCache.at < THIRDPARTY_FLAG_TTL_MS) {
    return thirdPartyFlagCache.value
  }
  let value = false
  try {
    const cachePath = resolve(getPaths().data, 'remote-config-cache.json')
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      configs?: Record<string, unknown>
    }
    value = parsed?.configs?.['skills.thirdparty_enabled'] === true
  } catch {
    value = false
  }
  thirdPartyFlagCache = { value, at: now }
  return value
}

function createDefaultService(): SkillsMcpService {
  return {
    getAgentSkillsState(agentId: string): AgentSkillsState {
      const deps = requireRuntimeDeps()
      const instance = deps.agentManager.getAgent(agentId)
      if (!instance) {
        throw new Error(`当前助理（${agentId}）不存在或尚未加载`)
      }
      const installed = deps.skillsLoader.loadAllSkillsForAgent(instance.config).map((skill) => ({
        name: skill.name,
        description: skill.frontmatter.description ?? '',
        path: skill.path,
        registrySlug: skill.registryMeta?.slug,
        usable: skill.usable,
      }))
      return { whitelist: instance.config.skills, installed }
    },
    async setAgentSkills(agentId: string, skills: string[]): Promise<void> {
      const deps = requireRuntimeDeps()
      const instance = deps.agentManager.getAgent(agentId)
      if (!instance) {
        throw new Error(`当前助理（${agentId}）不存在或尚未加载`)
      }
      const configPath = resolve(instance.workspaceDir, 'agent.yaml')
      if (!existsSync(configPath)) {
        throw new Error('当前助理缺少 agent.yaml 配置文件，无法调整技能')
      }
      // 与 PUT /api/agents/:id 相同语义：读现有 yaml → 改 skills 键 → 整体写回 → 热重载
      const existingConfig = parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      writeFileSync(configPath, stringifyYaml({ ...existingConfig, skills }))
      await deps.agentManager.reloadAgents()
    },
    async installSkillFromMarketplace(source: MarketplaceInstallSource, slug: string): Promise<void> {
      const deps = requireRuntimeDeps()
      await deps.registryManager.installSkillFromSource(source, slug)
    },
    isThirdPartySourcesEnabled(): boolean {
      return readThirdPartySourcesFlag()
    },
    discoverRecommendedSkills(query: string, limit: number): DiscoverableSkill[] {
      const deps = requireRuntimeDeps()
      const needle = query.trim().toLowerCase()
      // getRecommended 已过滤掉"本机已安装"的条目，返回的天然是"可新增"的技能
      const all = deps.registryManager.getRecommended()
      const matched = needle
        ? all.filter((s) => `${s.slug} ${s.displayName} ${s.summary}`.toLowerCase().includes(needle))
        : all
      return matched.slice(0, Math.max(1, limit)).map((s) => ({
        slug: s.slug,
        displayName: s.displayName,
        summary: s.summary,
      }))
    },
  }
}

// ─── 参数 schema ───────────────────────────────────────────────────────────

const ListSkillsParams = Type.Object({
  query: Type.Optional(Type.String({ description: 'Optional keyword filter matched against skill name, description, and marketplace slug' })),
})

const SetSkillEnabledParams = Type.Object({
  slug: Type.String({ description: 'Skill name or marketplace slug exactly as shown by mcp__skills__list_skills' }),
  enabled: Type.Boolean({ description: 'true to enable the skill for the current agent, false to disable it' }),
})

const InstallSkillParams = Type.Object({
  slug: Type.String({ description: 'Marketplace slug of the skill to install' }),
  source: Type.Optional(Type.String({ description: 'Marketplace source id. Defaults to "xiaojuclaw" (the first-party skill library). Third-party sources are rejected unless enabled by configuration.' })),
})

const DiscoverSkillsParams = Type.Object({
  query: Type.String({ description: 'A capability/need keyword to look up in the recommended skill catalog (e.g. "PDF", "翻译", "股票", "notion", "海报"). Use the core noun of what the user wants.' }),
})

// ─── 内部工具函数 ──────────────────────────────────────────────────────────

function textResult(text: string, isError = false): SkillsToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  }
}

function hasWildcard(whitelist: string[] | undefined): boolean {
  return Boolean(whitelist?.includes('*'))
}

function normalizeSlugInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function findInstalledSkill(installed: AgentSkillSummary[], slug: string): AgentSkillSummary | undefined {
  const needle = slug.toLowerCase()
  return installed.find(
    (skill) => skill.name.toLowerCase() === needle || skill.registrySlug?.toLowerCase() === needle,
  )
}

function matchesQuery(skill: AgentSkillSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [skill.name, skill.description, skill.registrySlug ?? '']
    .some((text) => text.toLowerCase().includes(needle))
}

function toListEntry(skill: AgentSkillSummary): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.registrySlug && skill.registrySlug !== skill.name ? { slug: skill.registrySlug } : {}),
    ...(skill.usable ? {} : { usable: false }),
  }
}

// ─── MCP server 工厂 ───────────────────────────────────────────────────────

export function createSkillsMcpServer(context: SkillsToolContext, options?: SkillsMcpOptions): SkillsMcpServer {
  const service = options?.service ?? createDefaultService()

  /** 启用逻辑复用：install_skill 安装成功后同样走这里 */
  async function enableSkill(skill: AgentSkillSummary, state: AgentSkillsState): Promise<string> {
    // 技能文档在下一次消息处理时才会注入 system prompt（runtime.process 每轮
    // 重新 buildSnapshotForAgent），本轮如需立即使用可直接 Read 其 SKILL.md。
    const usageHint = `技能说明将从下一条消息开始自动加载；如需在本轮继续任务，可直接用 Read 工具阅读 ${skill.path} 并按其指引操作。`

    if (hasWildcard(state.whitelist)) {
      return `当前助理的技能白名单为 ["*"]（已启用全部本机技能），「${skill.name}」无需单独启用；` +
        `如当前上下文未包含其说明，可直接用 Read 工具阅读 ${skill.path} 后继续任务。`
    }
    if (state.whitelist?.includes(skill.name)) {
      return `技能「${skill.name}」已在当前助理的启用列表中，无需重复启用。${usageHint}`
    }
    const nextSkills = [...(state.whitelist ?? []), skill.name]
    await service.setAgentSkills(context.agentId, nextSkills)
    return `已为当前助理启用技能「${skill.name}」。${usageHint}`
  }

  const registeredTools: Record<string, RegisteredSkillsTool> = {
    list_skills: {
      handler: async (rawArgs: Record<string, unknown>) => {
        const logger = getLogger()
        const query = typeof rawArgs.query === 'string' ? rawArgs.query : ''

        try {
          const state = await service.getAgentSkillsState(context.agentId)
          const wildcard = hasWildcard(state.whitelist)
          const whitelistSet = new Set(state.whitelist ?? [])
          const matched = state.installed.filter((skill) => matchesQuery(skill, query))

          const enabled = wildcard ? matched : matched.filter((skill) => whitelistSet.has(skill.name))
          const notEnabled = wildcard ? [] : matched.filter((skill) => !whitelistSet.has(skill.name))

          return textResult(JSON.stringify({
            ...(query.trim() ? { query: query.trim() } : {}),
            all_enabled_wildcard: wildcard,
            ...(wildcard ? { note: '当前助理技能白名单为 ["*"]，本机已安装的全部技能均已启用。' } : {}),
            enabled: enabled.map(toListEntry),
            installed_not_enabled: notEnabled.map(toListEntry),
          }, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ error: msg, agentId: context.agentId, category: 'skills' }, 'list_skills failed')
          return textResult(`查询技能列表失败：${msg}`, true)
        }
      },
    },
    set_skill_enabled: {
      handler: async (rawArgs: Record<string, unknown>) => {
        const logger = getLogger()
        const slug = normalizeSlugInput(rawArgs.slug)
        const enabled = rawArgs.enabled

        try {
          if (!slug) {
            return textResult('set_skill_enabled 需要提供 slug（技能名或市场 slug）', true)
          }
          if (typeof enabled !== 'boolean') {
            return textResult('set_skill_enabled 需要提供布尔类型的 enabled 参数', true)
          }

          const state = await service.getAgentSkillsState(context.agentId)
          const target = findInstalledSkill(state.installed, slug)

          if (enabled) {
            if (!target) {
              return textResult(
                `本机未安装技能「${slug}」。请先用 mcp__skills__list_skills 确认可启用的技能；` +
                `若确实需要新技能，可在征得用户同意后用 mcp__skills__install_skill 从技能市场安装。`,
                true,
              )
            }
            return textResult(await enableSkill(target, state))
          }

          // 停用
          if (hasWildcard(state.whitelist)) {
            if (!target) {
              return textResult(`本机未安装技能「${slug}」，无从停用。可用 mcp__skills__list_skills 查看当前技能。`, true)
            }
            // 物化语义：["*"] 是「全部已安装技能」的隐式清单。要停用其中一个，
            // 必须先把白名单落成当前全部已安装技能的显式列表，再移除目标技能。
            // 副作用（预期内）：此后新安装的技能不会再被该助理自动启用。
            const materialized = state.installed
              .map((skill) => skill.name)
              .filter((name) => name !== target.name)
            await service.setAgentSkills(context.agentId, materialized)
            return textResult(
              `已停用技能「${target.name}」。原白名单为 ["*"]，已转换为显式技能列表（共 ${materialized.length} 项）后移除该技能，下一条消息开始生效。`,
            )
          }

          const removeNames = new Set<string>([slug])
          if (target) removeNames.add(target.name)
          const currentWhitelist = state.whitelist ?? []
          const nextSkills = currentWhitelist.filter((name) => !removeNames.has(name))

          if (nextSkills.length === currentWhitelist.length) {
            if (!target) {
              return textResult(`未找到技能「${slug}」（既未安装也不在启用列表中），请先用 mcp__skills__list_skills 确认名称。`, true)
            }
            return textResult(`技能「${target.name}」当前未启用，无需停用。`)
          }

          await service.setAgentSkills(context.agentId, nextSkills)
          return textResult(`已停用技能「${target?.name ?? slug}」，下一条消息开始生效。`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ error: msg, slug, enabled, agentId: context.agentId, category: 'skills' }, 'set_skill_enabled failed')
          return textResult(`调整技能启用状态失败：${msg}`, true)
        }
      },
    },
    discover_skills: {
      handler: async (rawArgs: Record<string, unknown>) => {
        const logger = getLogger()
        const query = typeof rawArgs.query === 'string' ? rawArgs.query.trim() : ''
        try {
          if (!query) {
            return textResult('discover_skills 需要提供 query（用户需求的核心能力关键词）', true)
          }
          const results = await service.discoverRecommendedSkills(query, 8)
          if (results.length === 0) {
            return textResult(JSON.stringify({
              query,
              recommended: [],
              note: '推荐目录里没有匹配的技能。请改用 mcp__skills__list_skills 看本机已装技能能否胜任，或直接用现有工具/技能完成任务。',
            }, null, 2))
          }
          return textResult(JSON.stringify({
            query,
            recommended: results,
            note: '这些是「推荐但本机尚未安装」的技能。若某个正好匹配用户需求：先用一句话向用户说明它的用途并征得同意，再用 mcp__skills__install_skill 安装（自有源可直接装；第三方源需用户在 设置 中开启「第三方技能源」）。若本机已装技能即可胜任，则无需安装。',
          }, null, 2))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ error: msg, query, agentId: context.agentId, category: 'skills' }, 'discover_skills failed')
          return textResult(`检索推荐技能失败：${msg}`, true)
        }
      },
    },
    install_skill: {
      handler: async (rawArgs: Record<string, unknown>) => {
        const logger = getLogger()
        const slug = normalizeSlugInput(rawArgs.slug)
        const requestedSource = typeof rawArgs.source === 'string' ? rawArgs.source : undefined

        try {
          if (!slug) {
            return textResult('install_skill 需要提供 slug（技能市场 slug）', true)
          }

          const resolved = resolveInstallSource(requestedSource, service.isThirdPartySourcesEnabled())
          if (!resolved.ok) {
            return textResult(resolved.error, true)
          }

          try {
            await service.installSkillFromMarketplace(resolved.source, slug)
          } catch (installErr) {
            const msg = installErr instanceof Error ? installErr.message : String(installErr)
            // 已安装过：不算失败路径的死胡同，直接指路 set_skill_enabled
            if (msg.includes('already installed')) {
              return textResult(`技能「${slug}」此前已安装过，无需重复安装；直接用 mcp__skills__set_skill_enabled 启用即可。`, true)
            }
            // 其余错误（未登录/套餐不足等 registry 已是友好中文文案）原样透传
            return textResult(`安装技能「${slug}」失败：${msg}`, true)
          }

          // 安装成功后自动为当前助理启用（复用 set_skill_enabled 的启用语义）
          const state = await service.getAgentSkillsState(context.agentId)
          const installedSkill = findInstalledSkill(state.installed, slug)
          if (!installedSkill) {
            return textResult(
              `技能「${slug}」已从${INSTALL_SOURCE_LABELS[resolved.source]}安装成功，但在本机技能列表中暂未识别到，` +
              `请用 mcp__skills__list_skills 复查后再启用。`,
              true,
            )
          }

          const enableMessage = await enableSkill(installedSkill, state)
          return textResult(`已从${INSTALL_SOURCE_LABELS[resolved.source]}安装技能「${installedSkill.name}」。${enableMessage}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ error: msg, slug, source: requestedSource, agentId: context.agentId, category: 'skills' }, 'install_skill failed')
          return textResult(`安装技能失败：${msg}`, true)
        }
      },
    },
  }

  return {
    instance: {
      _registeredTools: registeredTools,
    },
  }
}

// ─── 运行时 ToolDefinition 工厂 ────────────────────────────────────────────

function createJsonSkillsTool<T extends Record<string, unknown>>(
  name: 'list_skills' | 'set_skill_enabled' | 'install_skill' | 'discover_skills',
  description: string,
  parameters: ToolDefinition['parameters'],
  handler: (args: T) => Promise<SkillsToolResult>,
): ToolDefinition {
  return {
    name: `mcp__skills__${name}`,
    label: `mcp__skills__${name}`,
    description,
    parameters,
    async execute(_toolCallId, args: T) {
      const result = await handler(args)
      if (result.isError) {
        throw new Error(result.content[0]?.text || `Skills tool ${name} failed`)
      }
      return {
        content: result.content,
        details: {},
      }
    },
  }
}

const SELF_SERVE_FLOW = 'When the user asks for something your current skills cannot handle: (1) call mcp__skills__list_skills to check locally installed skills and enable a fit with mcp__skills__set_skill_enabled; (2) if nothing installed fits, call mcp__skills__discover_skills with the core need keyword to find recommended skills, and if one matches, install it (with the user\'s consent) via mcp__skills__install_skill; then immediately continue the user\'s original request yourself. Never tell the user to open the settings page to toggle skills.'

export function createSkillsTools(context: SkillsToolContext, options?: SkillsMcpOptions): ToolDefinition[] {
  const server = createSkillsMcpServer(context, options)
  const listSkillsHandler = server.instance._registeredTools.list_skills!.handler
  const setSkillEnabledHandler = server.instance._registeredTools.set_skill_enabled!.handler
  const installSkillHandler = server.instance._registeredTools.install_skill!.handler
  const discoverSkillsHandler = server.instance._registeredTools.discover_skills!.handler

  return [
    createJsonSkillsTool(
      'list_skills',
      `List skills for the current agent in two groups: skills already enabled for this agent, and skills installed on this machine but not yet enabled. Supports an optional keyword query. A whitelist of ["*"] means every installed skill is already enabled. ${SELF_SERVE_FLOW}`,
      ListSkillsParams,
      (args) => listSkillsHandler(args),
    ),
    createJsonSkillsTool(
      'discover_skills',
      `Search the recommended skill catalog for skills that are NOT yet installed on this machine, matching a capability keyword. Use this when the user needs a capability that mcp__skills__list_skills shows no installed skill for, to find something installable. Returns recommended skills (slug/name/summary). Installing them still requires user consent (and third-party sources may need to be enabled in settings). ${SELF_SERVE_FLOW}`,
      DiscoverSkillsParams,
      (args) => discoverSkillsHandler(args),
    ),
    createJsonSkillsTool(
      'set_skill_enabled',
      `Enable or disable an installed skill for the current agent only (cross-agent operations are not supported). Enabling adds the skill to this agent's whitelist in agent.yaml and hot-reloads agents; the skill instructions are injected starting from the next message, and the tool result includes the SKILL.md path so you can read it right away and keep working. Enabling is a no-op when the whitelist is ["*"]. Disabling with a ["*"] whitelist first materializes the wildcard into the explicit list of currently installed skills, then removes the target. ${SELF_SERVE_FLOW}`,
      SetSkillEnabledParams,
      (args) => setSkillEnabledHandler(args),
    ),
    createJsonSkillsTool(
      'install_skill',
      `Install a skill from the skill marketplace and automatically enable it for the current agent. Only trusted/visible sources are allowed (defaults to the first-party "xiaojuclaw" library; third-party sources require configuration). POLICY: before calling this tool you MUST tell the user what skill you want to install, from which source, and why, and only call it after the user agrees. After installing, immediately continue the user's original request. ${SELF_SERVE_FLOW}`,
      InstallSkillParams,
      (args) => installSkillHandler(args),
    ),
  ]
}
