import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { inferChannelType } from '../channel/config-schema.ts'
import type { EventBus } from '../events/index.ts'
import type { MemoryManager } from '../memory/index.ts'
import { AgentConfigSchema } from './schema.ts'
import { AgentRuntime } from './runtime.ts'
import { PromptBuilder } from './prompt-builder.ts'
import type { HooksManager } from './hooks.ts'
import type { AgentRouter } from './router.ts'
import type { SecretsManager } from './secrets.ts'
import type { SkillsLoader } from '../skills/loader.ts'
import type { BrowserManager } from '../browser/index.ts'
import type { AgentConfig, AgentInstance } from './types.ts'
import {
  DEFAULT_AGENT_YAML, GLOBAL_MEMORY_MD,
  OFFICE_ASSISTANT_AGENT_YAML, OFFICE_ASSISTANT_SOUL_MD,
  OFFICE_ASSISTANT_IDENTITY_MD, OFFICE_ASSISTANT_BOOTSTRAP_MD,
  ECOMMERCE_ASSISTANT_AGENT_YAML, ECOMMERCE_ASSISTANT_SOUL_MD,
  ECOMMERCE_ASSISTANT_IDENTITY_MD, ECOMMERCE_ASSISTANT_BOOTSTRAP_MD,
  CONTENT_CREATOR_AGENT_YAML, CONTENT_CREATOR_SOUL_MD,
  CONTENT_CREATOR_IDENTITY_MD, CONTENT_CREATOR_BOOTSTRAP_MD,
  FINANCE_ASSISTANT_AGENT_YAML, FINANCE_ASSISTANT_SOUL_MD,
  FINANCE_ASSISTANT_IDENTITY_MD, FINANCE_ASSISTANT_BOOTSTRAP_MD,
  HR_ASSISTANT_AGENT_YAML, HR_ASSISTANT_SOUL_MD,
  HR_ASSISTANT_IDENTITY_MD, HR_ASSISTANT_BOOTSTRAP_MD,
  SUPPORT_ASSISTANT_AGENT_YAML, SUPPORT_ASSISTANT_SOUL_MD,
  SUPPORT_ASSISTANT_IDENTITY_MD, SUPPORT_ASSISTANT_BOOTSTRAP_MD,
  RESEARCH_ASSISTANT_AGENT_YAML, RESEARCH_ASSISTANT_SOUL_MD,
  RESEARCH_ASSISTANT_IDENTITY_MD, RESEARCH_ASSISTANT_BOOTSTRAP_MD,
  XIANYU_CS_AGENT_YAML, XIANYU_CS_SOUL_MD,
  XIANYU_CS_IDENTITY_MD, XIANYU_CS_BOOTSTRAP_MD,
} from './templates.ts'
import { ensureAgentWorkspace } from './workspace.ts'

export class AgentManager {
  private agents: Map<string, AgentInstance> = new Map()
  private eventBus: EventBus
  private promptBuilder: PromptBuilder
  private hooksManager: HooksManager | null
  private agentRouter: AgentRouter | null
  private secretsManager: SecretsManager | null
  private skillsLoader: SkillsLoader | null
  private memoryManager: MemoryManager | null
  private browserManager: BrowserManager | null

  constructor(
    eventBus: EventBus,
    promptBuilder: PromptBuilder,
    hooksManager?: HooksManager,
    agentRouter?: AgentRouter,
    secretsManager?: SecretsManager,
    skillsLoader?: SkillsLoader,
    memoryManager?: MemoryManager,
    browserManager?: BrowserManager,
  ) {
    this.eventBus = eventBus
    this.promptBuilder = promptBuilder
    this.hooksManager = hooksManager ?? null
    this.agentRouter = agentRouter ?? null
    this.secretsManager = secretsManager ?? null
    this.skillsLoader = skillsLoader ?? null
    this.memoryManager = memoryManager ?? null
    this.browserManager = browserManager ?? null
  }

  /**
   * Ensure default agent and global memory directory exist
   * Uses agent.yaml as sentinel file; initializes from built-in templates if missing
   */
  ensureDefaultAgent(): void {
    const logger = getLogger()
    const paths = getPaths()
    const defaultDir = resolve(paths.agents, 'default')
    const globalDir = resolve(paths.agents, '_global')

    if (!existsSync(resolve(defaultDir, 'agent.yaml'))) {
      logger.info('Initializing default agent template...')
      mkdirSync(defaultDir, { recursive: true })
      writeFileSync(resolve(defaultDir, 'agent.yaml'), DEFAULT_AGENT_YAML)
    }
    ensureAgentWorkspace(defaultDir, {
      ensureBootstrap: true,
      ensureSkillsDir: true,
      ensurePromptsDir: true,
    })

    // [XJC] 预置数字员工「小橘办公助理」（T-D7）：
    // agent.yaml 为哨兵——用户改过/删过不覆盖；人设文档先于默认模板写入
    // （ensureAgentWorkspace 只补缺失文件，自定义 SOUL/IDENTITY/BOOTSTRAP 得以保留）。
    const officeDir = resolve(paths.agents, 'office-assistant')
    if (!existsSync(resolve(officeDir, 'agent.yaml'))) {
      logger.info('Initializing office-assistant digital staff template...')
      mkdirSync(officeDir, { recursive: true })
      writeFileSync(resolve(officeDir, 'agent.yaml'), OFFICE_ASSISTANT_AGENT_YAML)
      writeFileSync(resolve(officeDir, 'SOUL.md'), OFFICE_ASSISTANT_SOUL_MD)
      writeFileSync(resolve(officeDir, 'IDENTITY.md'), OFFICE_ASSISTANT_IDENTITY_MD)
      writeFileSync(resolve(officeDir, 'BOOTSTRAP.md'), OFFICE_ASSISTANT_BOOTSTRAP_MD)
    }
    ensureAgentWorkspace(officeDir, {
      ensureBootstrap: false,
      ensureSkillsDir: true,
      ensurePromptsDir: true,
    })

    // [XJC] 预置数字员工「小橘电商助理」（电商能力包）：与办公助理同款种子逻辑，
    // agent.yaml 为哨兵，用户改过不覆盖；技能全部随包预置，用户零配置即可用。
    const ecomDir = resolve(paths.agents, 'ecommerce-assistant')
    if (!existsSync(resolve(ecomDir, 'agent.yaml'))) {
      logger.info('Initializing ecommerce-assistant digital staff template...')
      mkdirSync(ecomDir, { recursive: true })
      writeFileSync(resolve(ecomDir, 'agent.yaml'), ECOMMERCE_ASSISTANT_AGENT_YAML)
      writeFileSync(resolve(ecomDir, 'SOUL.md'), ECOMMERCE_ASSISTANT_SOUL_MD)
      writeFileSync(resolve(ecomDir, 'IDENTITY.md'), ECOMMERCE_ASSISTANT_IDENTITY_MD)
      writeFileSync(resolve(ecomDir, 'BOOTSTRAP.md'), ECOMMERCE_ASSISTANT_BOOTSTRAP_MD)
    }
    ensureAgentWorkspace(ecomDir, {
      ensureBootstrap: false,
      ensureSkillsDir: true,
      ensurePromptsDir: true,
    })

    // [XJC] 预置数字员工「小橘创作助理」（内容创作能力包）：与电商助理同款种子逻辑，
    // agent.yaml 为哨兵，用户改过不覆盖；技能全部纯 SKILL.md 随包预置，零配置即可用。
    const contentDir = resolve(paths.agents, 'content-creator')
    if (!existsSync(resolve(contentDir, 'agent.yaml'))) {
      logger.info('Initializing content-creator digital staff template...')
      mkdirSync(contentDir, { recursive: true })
      writeFileSync(resolve(contentDir, 'agent.yaml'), CONTENT_CREATOR_AGENT_YAML)
      writeFileSync(resolve(contentDir, 'SOUL.md'), CONTENT_CREATOR_SOUL_MD)
      writeFileSync(resolve(contentDir, 'IDENTITY.md'), CONTENT_CREATOR_IDENTITY_MD)
      writeFileSync(resolve(contentDir, 'BOOTSTRAP.md'), CONTENT_CREATOR_BOOTSTRAP_MD)
    }
    ensureAgentWorkspace(contentDir, {
      ensureBootstrap: false,
      ensureSkillsDir: true,
      ensurePromptsDir: true,
    })

    // [XJC] 预置数字员工「小橘财务助理/人事助理/客服助理」（后台职能能力包）：
    // 与既有能力包同款种子逻辑——agent.yaml 为哨兵，用户改过不覆盖；技能全部纯 SKILL.md。
    const backOfficeSeeds: Array<{ id: string; yaml: string; soul: string; identity: string; bootstrap: string }> = [
      { id: 'finance-assistant', yaml: FINANCE_ASSISTANT_AGENT_YAML, soul: FINANCE_ASSISTANT_SOUL_MD, identity: FINANCE_ASSISTANT_IDENTITY_MD, bootstrap: FINANCE_ASSISTANT_BOOTSTRAP_MD },
      { id: 'hr-assistant', yaml: HR_ASSISTANT_AGENT_YAML, soul: HR_ASSISTANT_SOUL_MD, identity: HR_ASSISTANT_IDENTITY_MD, bootstrap: HR_ASSISTANT_BOOTSTRAP_MD },
      { id: 'support-assistant', yaml: SUPPORT_ASSISTANT_AGENT_YAML, soul: SUPPORT_ASSISTANT_SOUL_MD, identity: SUPPORT_ASSISTANT_IDENTITY_MD, bootstrap: SUPPORT_ASSISTANT_BOOTSTRAP_MD },
      { id: 'research-assistant', yaml: RESEARCH_ASSISTANT_AGENT_YAML, soul: RESEARCH_ASSISTANT_SOUL_MD, identity: RESEARCH_ASSISTANT_IDENTITY_MD, bootstrap: RESEARCH_ASSISTANT_BOOTSTRAP_MD },
      { id: 'xianyu-cs', yaml: XIANYU_CS_AGENT_YAML, soul: XIANYU_CS_SOUL_MD, identity: XIANYU_CS_IDENTITY_MD, bootstrap: XIANYU_CS_BOOTSTRAP_MD },
    ]
    for (const seed of backOfficeSeeds) {
      const dir = resolve(paths.agents, seed.id)
      if (!existsSync(resolve(dir, 'agent.yaml'))) {
        logger.info(`Initializing ${seed.id} digital staff template...`)
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolve(dir, 'agent.yaml'), seed.yaml)
        writeFileSync(resolve(dir, 'SOUL.md'), seed.soul)
        writeFileSync(resolve(dir, 'IDENTITY.md'), seed.identity)
        writeFileSync(resolve(dir, 'BOOTSTRAP.md'), seed.bootstrap)
      }
      ensureAgentWorkspace(dir, {
        ensureBootstrap: false,
        ensureSkillsDir: true,
        ensurePromptsDir: true,
      })
    }

    if (!existsSync(resolve(globalDir, 'memory', 'MEMORY.md'))) {
      mkdirSync(resolve(globalDir, 'memory'), { recursive: true })
      writeFileSync(resolve(globalDir, 'memory', 'MEMORY.md'), GLOBAL_MEMORY_MD)
    }
  }

  /**
   * 服务端下发的数字员工定义落地（能力与时俱进 · 阶段三）。
   * 与内置种子同款「哨兵」逻辑：agent.yaml 已存在则跳过（尊重用户改动/已有员工）；仅为新的
   * 远程员工创建目录、写人设文档、由 yaml 库安全生成 agent.yaml，并尽力从私有源装配其声明的
   * 技能。防御性校验：坏定义整条跳过、装配失败静默，绝不抛断整体。有落地则热重载。
   */
  async seedRemoteStaff(
    defs: unknown[],
    installSkill?: (slug: string) => Promise<void>,
  ): Promise<{ seeded: string[]; skipped: number }> {
    // 串行化：syncRemoteStaff 可能被 hydrate/登录/激活/断线恢复并发触发，并发 reloadAgents
    // 会破坏 agents 表，故用 promise 链保证逐个执行（每次拿到各自的 defs，不丢种子）。
    const run = this.remoteStaffSeedChain.then(() => this.seedRemoteStaffInner(defs, installSkill))
    this.remoteStaffSeedChain = run.then(() => undefined, () => undefined)
    return run
  }

  private remoteStaffSeedChain: Promise<unknown> = Promise.resolve()

  private async seedRemoteStaffInner(
    defs: unknown[],
    installSkill?: (slug: string) => Promise<void>,
  ): Promise<{ seeded: string[]; skipped: number }> {
    const logger = getLogger()
    const paths = getPaths()
    const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
    const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
    // 内置/保留 id：远程定义不得覆盖（与 MVP capabilityAgentService 保持一致）
    const RESERVED = new Set([
      'default', '_global',
      'office-assistant', 'ecommerce-assistant', 'content-creator',
      'finance-assistant', 'hr-assistant', 'support-assistant', 'research-assistant', 'xianyu-cs',
    ])
    const seeded: string[] = []
    let skipped = 0
    const skillsToInstall = new Set<string>()

    for (const raw of Array.isArray(defs) ? defs : []) {
      try {
        if (!raw || typeof raw !== 'object') { skipped++; continue }
        const def = raw as Record<string, unknown>
        const agentId = typeof def.agentId === 'string' ? def.agentId.trim().toLowerCase() : ''
        if (!AGENT_ID_RE.test(agentId) || RESERVED.has(agentId)) { skipped++; continue }
        const name = typeof def.name === 'string' ? def.name.trim() : ''
        const soul = typeof def.soul === 'string' ? def.soul : ''
        const identity = typeof def.identity === 'string' ? def.identity : ''
        if (!name || !soul || !identity) { skipped++; continue }
        const bootstrap = typeof def.bootstrap === 'string' ? def.bootstrap : ''
        const model = typeof def.model === 'string' ? def.model.trim() : ''
        const skills: string[] = []
        if (Array.isArray(def.skills)) {
          for (const s of def.skills) {
            const slug = String(s || '').trim().toLowerCase()
            if (slug && SKILL_SLUG_RE.test(slug)) skills.push(slug)
          }
        }

        const dir = resolve(paths.agents, agentId)
        const alreadyExists = existsSync(resolve(dir, 'agent.yaml'))
        if (!alreadyExists) {
          logger.info(`Seeding remote digital staff: ${agentId}`)
          mkdirSync(dir, { recursive: true })
          const yamlObj: Record<string, unknown> = {
            id: agentId,
            name,
            memory: {
              enabled: true, recentDays: 2, archiveConversations: true,
              maxLogEntryLength: 500, historyFallbackMessages: 24, maxSessionBytes: 262144,
            },
          }
          if (model) yamlObj.model = model
          if (skills.length) yamlObj.skills = skills
          yamlObj.disallowedTools = ['WebSearch']
          writeFileSync(resolve(dir, 'agent.yaml'), stringifyYaml(yamlObj))
          writeFileSync(resolve(dir, 'SOUL.md'), soul)
          writeFileSync(resolve(dir, 'IDENTITY.md'), identity)
          if (bootstrap) writeFileSync(resolve(dir, 'BOOTSTRAP.md'), bootstrap)
          seeded.push(agentId)
          for (const slug of skills) skillsToInstall.add(slug)
        }
        ensureAgentWorkspace(dir, { ensureBootstrap: false, ensureSkillsDir: true, ensurePromptsDir: true })
      } catch (err) {
        skipped++
        logger.warn({ error: String(err), category: 'commercial' }, 'Seed remote staff entry failed')
      }
    }

    // 尽力装配技能（失败不影响员工可用；员工也可后续对话式安装）
    if (installSkill && skillsToInstall.size > 0) {
      for (const slug of skillsToInstall) {
        try { await installSkill(slug) }
        catch (err) { logger.warn({ slug, error: String(err), category: 'commercial' }, 'Install remote staff skill failed') }
      }
    }

    if (seeded.length > 0) await this.reloadAgents()
    return { seeded, skipped }
  }

  /**
   * Load all agents from the agents/ directory
   * Scans each subdirectory for agent.yaml, validates config with Zod, and creates AgentRuntime
   */
  async loadAgents(): Promise<void> {
    const logger = getLogger()
    const paths = getPaths()
    const agentsDir = paths.agents

    // Ensure default agent exists
    this.ensureDefaultAgent()

    if (!existsSync(agentsDir)) {
      logger.warn({ agentsDir }, 'Agents directory does not exist')
      return
    }

    const entries = readdirSync(agentsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const agentDir = resolve(agentsDir, entry.name)
      const configPath = resolve(agentDir, 'agent.yaml')

      if (!existsSync(configPath)) {
        logger.debug({ agentDir }, 'Skipping directory without agent.yaml')
        continue
      }

      try {
        const rawYaml = readFileSync(configPath, 'utf-8')
        const parsed = parseYaml(rawYaml) as Record<string, unknown>

        // Validate config with Zod
        const result = AgentConfigSchema.safeParse({
          ...parsed,
          id: parsed.id ?? entry.name,
          name: parsed.name ?? entry.name,
        })

        if (!result.success) {
          logger.error({ agentDir, errors: result.error.issues }, 'agent.yaml config validation failed')
          continue
        }

        const config: AgentConfig = {
          ...result.data,
          workspaceDir: agentDir,
          hasExplicitModel: typeof parsed.model === 'string' && parsed.model.trim().length > 0,
        }

        if (this.skillsLoader) {
          const normalizedSkills = this.skillsLoader.normalizeAgentSkillNames(
            config.skills,
            this.skillsLoader.loadAllSkillsForAgent(config),
          )
          if (normalizedSkills.changed) {
            config.skills = normalizedSkills.skills
            const nextYaml = {
              ...parsed,
              id: config.id,
              name: config.name,
              skills: normalizedSkills.skills,
            }
            writeFileSync(configPath, stringifyYaml(nextYaml))
            logger.info({ agentId: config.id, skills: normalizedSkills.skills }, 'Normalized agent skill bindings')
          }
        }

        // Backward compatibility: auto-migrate legacy telegram.chatIds to bindings
        if (config.telegram?.chatIds && !config.bindings) {
          config.bindings = [{
            channel: 'telegram',
            chatIds: config.telegram.chatIds,
            priority: 100,
          }]
        }

        // Load hooks
        if (this.hooksManager && config.hooks) {
          await this.hooksManager.loadHooks(config.id, agentDir, config.hooks)
        }

        // Register security policy as built-in hook
        if (this.hooksManager && config.security) {
          const { createSecurityHook } = await import('./security.ts')
          const securityHandler = createSecurityHook(config.security)
          this.hooksManager.registerBuiltinHook(config.id, 'pre_tool_use', securityHandler, -1000)
        }

        const runtime = new AgentRuntime(
          config,
          this.eventBus,
          this.promptBuilder,
          this.hooksManager ?? undefined,
          this.skillsLoader ?? undefined,
          this.memoryManager ?? undefined,
          this.browserManager ?? undefined,
          this.secretsManager ?? undefined,
        )

        this.agents.set(config.id, {
          config,
          workspaceDir: agentDir,
          runtime,
          state: {
            sessionId: null,
            isProcessing: false,
            lastProcessedAt: null,
            totalProcessed: 0,
            lastError: null,
            queueDepth: 0,
          },
        })

        logger.info({ agentId: config.id, name: config.name }, 'Agent loaded')
      } catch (err) {
        logger.error({ agentDir, error: err instanceof Error ? err.message : String(err) }, 'Failed to load agent')
      }
    }

    // Build route table
    if (this.agentRouter) {
      this.agentRouter.buildRouteTable(this.agents)
    }

    logger.info({ count: this.agents.size }, 'All agents loaded')
  }

  /**
   * Clear loaded agents and reload from disk
   */
  async reloadAgents(): Promise<void> {
    // Clean up hooks
    if (this.hooksManager) {
      for (const agentId of this.agents.keys()) {
        this.hooksManager.unloadHooks(agentId)
      }
    }
    this.agents.clear()
    await this.loadAgents()
  }

  /**
   * Resolve the agent for a given chatId
   */
  resolveAgent(chatId: string): AgentInstance | undefined {
    // Prefer AgentRouter if initialized
    if (this.agentRouter) {
      const channel = inferChannelType(chatId)
      return this.agentRouter.resolve({
        channel,
        chatId,
      })
    }

    // Fall back to legacy logic
    for (const managed of this.agents.values()) {
      const chatIds = managed.config.telegram?.chatIds
      if (chatIds && chatIds.includes(chatId)) {
        return managed
      }
    }
    return this.getDefaultAgent()
  }

  /**
   * Get all agent configs
   */
  getAgents(): AgentConfig[] {
    return Array.from(this.agents.values()).map((m) => m.config)
  }

  /**
   * Get a single agent by ID
   */
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId)
  }

  /**
   * Get the default agent
   */
  getDefaultAgent(): AgentInstance | undefined {
    const defaultAgent = this.agents.get('default')
    if (defaultAgent) return defaultAgent
    const first = this.agents.values().next()
    return first.done ? undefined : first.value
  }

  /**
   * Get the AgentRouter (for API routing)
   */
  getRouter(): AgentRouter | null {
    return this.agentRouter
  }

  /**
   * Get the internal agents Map (for AgentRouter)
   */
  getAgentsMap(): Map<string, AgentInstance> {
    return this.agents
  }

}
