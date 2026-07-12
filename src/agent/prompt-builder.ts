// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { inferChannelType } from '../channel/config-schema.ts'
import { getLogger } from '../logger/index.ts'
import type { SkillsLoader } from '../skills/index.ts'
import type { MemoryManager } from '../memory/index.ts'
import type { MediaStatus } from '../media/types.ts'
import type { AgentConfig } from './types.ts'
import { getOrLoadBootstrapDocs } from './bootstrap-cache.ts'
import type { BrowserDriver, BrowserTarget } from '../browser/index.ts'

const WORKSPACE_FILES = [
  { filename: 'AGENTS.md' },
  { filename: 'SOUL.md' },
  { filename: 'TOOLS.md' },
  { filename: 'IDENTITY.md' },
  { filename: 'USER.md' },
  { filename: 'HEARTBEAT.md' },
  { filename: 'BOOTSTRAP.md' },
] as const

// [XJC] 精简层级（lean，供分级意图路由的闲聊档）：只注入身份/风格/红线，
// 跳过体量最大的 AGENTS.md 操作手册、技能清单、记忆与各类工具规则块。
const LEAN_WORKSPACE_FILES = [
  { filename: 'SOUL.md' },
  { filename: 'IDENTITY.md' },
  { filename: 'USER.md' },
] as const

type LoadedWorkspaceDoc = {
  filePath: string
  content: string
}

export class PromptBuilder {
  constructor(
    private skillsLoader: SkillsLoader | null,
    private memoryManager: MemoryManager | null,
  ) {
    void this.skillsLoader
  }

  /**
   * Build the complete system prompt.
   * Loading order: workspace docs -> browser -> skills -> memory -> env -> channel.
   */
  build(
    workspaceDir: string,
    config: AgentConfig,
    context?: {
      agentId: string
      chatId: string
      requestedSkills?: string[]
      skillsPrompt?: string
      memoryContext?: string
      browserProfileId?: string
      browserDisabled?: boolean
      browserTarget?: BrowserTarget
      mediaStatus?: MediaStatus
      mediaTurnInstruction?: string | null
      availableToolNames?: string[]
      promptTier?: 'lean' | 'full'
      browserProfile?: {
        id: string
        driver: BrowserDriver
        userDataDir: string | null
      }
    },
  ): string {
    const parts: string[] = []

    const agentMemoryDir = resolve(workspaceDir, 'memory')
    const agentMemoryPath = resolve(workspaceDir, 'MEMORY.md')
    const globalMemoryPath = resolve(getPaths().agents, '_global', 'memory', 'MEMORY.md')
    const agentId = context?.agentId ?? 'default'

    // [XJC] 精简层级快路径：闲聊等零工具场景只发身份/风格/红线 + 当前上下文，
    // 跳过 AGENTS.md 操作手册 / 技能清单 / 记忆 / 各类规则块（大头）。无可用精简文档时回退完整构建。
    if ((context?.promptTier ?? 'full') === 'lean') {
      const leanDocs = this.loadWorkspaceDocs(workspaceDir, {
        agentMemoryDir,
        agentMemoryPath,
        globalMemoryPath,
      }, LEAN_WORKSPACE_FILES)
      if (leanDocs.length > 0) {
        const leanParts: string[] = ['# Project Context', '']
        for (const doc of leanDocs) {
          leanParts.push(`## ${doc.filePath}`, '', doc.content, '')
        }
        if (context) {
          leanParts.push(`\n## Current Context\n- Agent ID: ${context.agentId}\n- Chat ID: ${context.chatId}`)
        }
        return leanParts.join('\n\n')
      }
    }

    const workspaceDocs = context?.chatId
      ? getOrLoadBootstrapDocs({
          cacheKey: this.getBootstrapCacheKey(agentId, context.chatId),
          loader: () => this.loadWorkspaceDocs(workspaceDir, {
            agentMemoryDir,
            agentMemoryPath,
            globalMemoryPath,
          }),
        })
      : this.loadWorkspaceDocs(workspaceDir, {
          agentMemoryDir,
          agentMemoryPath,
          globalMemoryPath,
        })

    if (workspaceDocs.length > 0) {
      parts.push(
        '## Workspace Files (injected)',
        'These user-editable files are loaded from the agent workspace and included below in Project Context.',
        'They are already fully present in this context. Never use Read/tools to re-open these injected files, and treat any "Session Startup: read these files first" instructions inside them as already satisfied.',
        '',
        '# Project Context',
        '',
      )

      for (const doc of workspaceDocs) {
        parts.push(`## ${doc.filePath}`, '', doc.content, '')
      }

      // [XJC] 行动优先原则：中和历史模板/员工 SOUL 里过密的"先确认再动手"约束——
      // 模型被几十条禁令包围后会过度追问、不敢拿主意，体感"笨、被动"。安全红线保持不变。
      parts.push(
        `## Operating Principles (行动优先)\n` +
        `- 信息足够就直接动手：优先交付结果或初稿，而不是先抛出一串确认问题。\n` +
        `- 资料不全时，用合理默认假设完成主体工作，并在结尾用一两行列出所采用的关键假设，供用户纠正后迭代。\n` +
        `- 人设中"先确认需求"类要求的正确执行方式：只在关键信息真正缺失、错了会浪费大量工作时才问，且一次问全；绝不挤牙膏式反复追问。\n` +
        `- 仍必须先征求确认的只有两类：不可逆/破坏性操作（删除、覆盖原件、对外发送/发布/付款/下单），以及明确涉及真实资金、账号安全、隐私外发的动作。\n` +
        `- 回答要有主见：用户要方案时给出你的推荐及理由，而不是罗列选项让用户自己挑。`
      )
    } else {
      const fallback = this.loadGlobalSystemPrompt()
      if (fallback) {
        parts.push(fallback)
      }
    }

    if (context?.browserDisabled) {
      parts.push(
        `## Browser Policy\n` +
        `Browser use is explicitly disabled for this request. ` +
        `Do NOT use the built-in \`mcp__browser__*\` tools. ` +
        `Do NOT invoke the legacy \`agent-browser\` skill and do NOT run \`agent-browser\` from Bash. ` +
        `Solve the task without browser automation by default. ` +
        `If web search, WebFetch, or other non-browser methods are blocked by login walls, CAPTCHA, 2FA, device verification, bot checks, or other site verification, stop trying browser tools and reply with a short, user-facing explanation that browser mode is currently off and can be enabled by configuring a browser profile for this agent or request, then retrying in browser mode.`
      )
    } else if (context?.browserProfileId) {
      const fallbackHint = context.browserProfile?.driver === 'managed' && context.browserProfile.userDataDir
        ? `\nIf you must use legacy \`agent-browser\` for unsupported operations, reuse this managed profile:\n` +
          '```bash\n' +
          `agent-browser --session ${context.browserProfile.id} --profile ${context.browserProfile.userDataDir} <command>\n` +
          '```'
        : '\nIf you must use legacy `agent-browser` for unsupported operations, prefer the built-in browser MCP tools first because legacy commands may not share the same browser runtime state.'

      parts.push(
        `## Browser Tools\n` +
        `This chat is connected to browser profile "${context.browserProfileId}". ` +
        `Browser tools for this chat are routed to target "${context.browserTarget ?? 'host'}". ` +
        `Prefer the built-in \`mcp__browser__*\` tools for common browser interaction: status, list_tabs, open_tab, navigate, snapshot, act, screenshot, click, type, press_key, and close_tab.\n` +
        `For page interaction, prefer taking a fresh \`snapshot\` first and then using \`act\` with element refs returned by the snapshot. Use raw CSS selector tools only as a fallback when ref-based interaction is insufficient.\n` +
        `If the current browser target reports that it is not implemented, do not keep retrying the same browser tool calls blindly. Explain the limitation briefly and continue with another approach when possible.\n` +
        `Use the legacy \`agent-browser\` skill only when you need capabilities not yet covered by the built-in browser tools, such as interactive element refs, explicit waits, select/check, get text, PDF export, visual diff, or state import/export.\n` +
        `Manual login is the default and recommended flow for sites that require authentication. Do NOT ask the user for credentials, passwords, 2FA codes, recovery codes, or session secrets. Ask the user to sign in manually in the browser profile instead.\n` +
        `Automated login attempts often trigger anti-bot or account-security defenses. If the site shows CAPTCHA, 2FA, device verification, suspicious-login prompts, or other security checks, stop automated login attempts and ask the user to take over manually.\n` +
        `For sensitive or high-impact actions, prepare the page and then ask the user to review, confirm, or complete the final step manually. This includes purchases, payments, transfers, account-security changes, password resets, OAuth consent, message sending, posting, publishing, deleting data, or submitting legal/financial forms.\n` +
        `For strict sites such as social media posting or other anti-bot-sensitive flows, prefer manual user interaction for the final sensitive steps even if navigation succeeds.\n` +
        `Sensitive browser write actions (purchase/pay/submit/publish/delete/account-security) are enforced by a runtime confirmation gate. If a tool call is blocked with BROWSER_CONFIRMATION_REQUIRED, do NOT blindly retry — restate the exact action to the user and ask them to reply "确认" to proceed or "取消" to cancel, then perform it once after they confirm.` +
        fallbackHint
      )
    }

    const skillsSection = this.buildSkillsSection(context?.skillsPrompt)
    if (skillsSection) {
      parts.push(skillsSection)
    }

    const envContext = this.buildEnvContext()
    if (envContext) {
      parts.push(envContext)
    }

    const channelContext = this.buildChannelContext(context?.chatId)
    if (channelContext) {
      parts.push(channelContext)
    }

    // [XJC] 工具规则按需注入：availableToolNames 提供时只发实际挂载工具的规则
    // （意图路由裁剪后无关规则不再占 token）；未提供（子代理编译等旧路径）保持全量注入。
    const availableTools = new Set(context?.availableToolNames ?? [])
    const hasToolInfo = Array.isArray(context?.availableToolNames)
    const ruleApplies = (...toolNames: string[]): boolean =>
      !hasToolInfo || toolNames.some((name) => availableTools.has(name))

    const mediaRule = this.buildMediaGenerationRule(context?.mediaStatus, availableTools)
    if (mediaRule) parts.push(mediaRule)

    if (availableTools.has('mcp__minimax__understand_image')) {
      parts.push(
        `## Image Understanding Rule\n` +
        `When the task requires analyzing, describing, or extracting information from an image, use \`mcp__minimax__understand_image\`.\n` +
        `Do not use the \`Read\` tool on image files. For an explicit image-edit request, \`mcp__media__edit_image\` may operate directly from the user's instruction; call the understanding tool first only when visual inspection is actually needed.`
      )
    }

    if (availableTools.has('mcp__ocr__extract_text')) {
      parts.push(
        `## Local OCR Rule\n` +
        `\`mcp__ocr__extract_text\` runs fully on this machine (the image never leaves it). ` +
        `Prefer it whenever the user needs the TEXT of an image — invoices, receipts, screenshots, scanned pages — it is free, offline, and character-accurate.\n` +
        `Use a vision model only when you must understand layout, objects, or visual style beyond plain text. Lines marked 【低置信】 must be verified with the user before being used in deliverables.`
      )
    }

    if (ruleApplies('mcp__document__search_document', 'mcp__document__parse_document')) {
      parts.push(
        `## Document Handling Rule\n` +
        `When parsed document ids are available, you MUST use the \`mcp__document__search_document\` and \`mcp__document__read_document_chunk\` tools first.\n` +
        `Do NOT use the \`Read\` tool on the original document file when a parsed document is available.\n` +
        `If document parsing fails, be explicit about the failure instead of pretending the document was read.`
      )
    }

    if (ruleApplies('mcp__task__list_tasks', 'mcp__task__update_task')) {
      parts.push(
        `## Scheduled Task Rule\n` +
        `Use \`mcp__task__list_tasks\` and \`mcp__task__update_task\` for persistent scheduled tasks.\n` +
        `Always call \`mcp__task__list_tasks\` before any \`mcp__task__update_task\` write operation.\n` +
        `Do NOT rely on built-in session-only cron/task tools or write raw IPC task files manually.\n` +
        `When a scheduled task run produces files and its result is pushed to a channel, list each file at the end of your reply on its own line as \`[[attach:<absolute path>]]\` so the files are delivered together with the result. Attached files must live inside your own agent workspace directory.`
      )
    }

    // [XJC] 对话式技能自管理规则（覆盖已有安装的旧 AGENTS.md，见 skills-mcp.ts）
    if (ruleApplies('mcp__skills__list_skills')) {
      parts.push(
        `## Skill Self-Service Rule\n` +
        `When a user request needs a capability your current skills do not cover, first call \`mcp__skills__list_skills\`; enable an installed skill yourself with \`mcp__skills__set_skill_enabled\`, or — only after explaining what/where-from/why and getting the user's consent — install one with \`mcp__skills__install_skill\`. Then continue the user's original request immediately. Never ask the user to toggle skills in the settings UI.\n` +
        `This rule does NOT apply to built-in runtime tools that are actually listed as available in this prompt, including media tools; use those tools under their dedicated rules.`
      )
    }

    if (context) {
      parts.push(
        `\n## Current Context\n- Agent ID: ${context.agentId}\n- Chat ID: ${context.chatId}`,
      )
    }

    // [XJC] 缓存前缀稳定化：易变内容统一后置。记忆（含按当前消息检索的命中）与本轮媒体指令
    // 每轮都变，放最后可让前面的静态前缀（工作区文档/技能/规则）持续命中 provider 提示缓存。
    if (context?.memoryContext) {
      parts.push(context.memoryContext)
    } else if (this.memoryManager && context && config.memory?.enabled !== false) {
      const memoryContext = this.memoryManager.getMemoryContext(context.agentId, {
        recentDays: config.memory?.recentDays,
        maxContextChars: config.memory?.maxContextChars,
      })
      if (memoryContext) {
        parts.push(memoryContext)
      }
    }

    if (context?.mediaTurnInstruction) parts.push(context.mediaTurnInstruction)

    return parts.join('\n\n')
  }

  private buildMediaGenerationRule(status: MediaStatus | undefined, availableTools: ReadonlySet<string>): string | null {
    const hasGenerateImage = availableTools.has('mcp__media__generate_image')
    const hasEditImage = availableTools.has('mcp__media__edit_image')
    const hasGenerateVideo = availableTools.has('mcp__media__generate_video')
    if (!hasGenerateImage && !hasEditImage && !hasGenerateVideo) return null
    const imageState = status ? (status.imageConfigured ? 'configured' : 'not configured') : 'unknown'
    const editState = status ? (status.imageEditConfigured ? 'configured' : 'not configured') : 'unknown'
    const videoState = status ? (status.videoConfigured ? 'configured' : 'not configured') : 'unknown'

    return (
      `## Built-in Media Generation Rule\n` +
      `Image and video generation are built-in runtime tools, NOT skills. ` +
      `Never call skill list/discovery/install tools merely to look for an image-generation capability.\n` +
      `Available media tools: ${[...availableTools].filter((name) => name.startsWith('mcp__media__')).join(', ')}.\n` +
      `Current media configuration: text-to-image=${hasGenerateImage ? imageState : 'tool-unavailable'}, image-edit=${hasEditImage ? editState : 'tool-unavailable'}, video=${hasGenerateVideo ? videoState : 'tool-unavailable'}.\n` +
      `- Tool execution enforces per-turn authorization and call limits. Never infer billing authorization from capability questions, tutorials, troubleshooting, or prompt-writing requests.\n` +
      `- If requested visual content is missing, ask only for the missing subject/style/use details; do not claim that an image skill is missing.\n` +
      `- Video generation requires an explicit billed-call confirmation that is enforced by the runtime before the tool can execute.\n` +
      `- If the corresponding configuration is not configured or a media tool returns MEDIA_NOT_CONFIGURED, guide the user to 设置 → 语音与媒体. Never ask them to paste secrets into chat.`
    )
  }

  private loadWorkspaceDocs(
    workspaceDir: string,
    replacements: Record<string, string>,
    fileset: readonly { filename: string }[] = WORKSPACE_FILES,
  ): LoadedWorkspaceDoc[] {
    const loaded: LoadedWorkspaceDoc[] = []

    for (const spec of fileset) {
      const filePath = resolve(workspaceDir, spec.filename)
      if (!existsSync(filePath)) continue

      try {
        let content = readFileSync(filePath, 'utf-8').trim()
        if (!content) continue

        for (const [key, value] of Object.entries(replacements)) {
          content = content.replaceAll(`{{${key}}}`, value)
        }

        getLogger().debug({ filename: spec.filename, source: 'workspace' }, 'Prompt file loaded')
        loaded.push({ filePath, content })
      } catch (err) {
        getLogger().warn(
          { filename: spec.filename, error: err instanceof Error ? err.message : String(err) },
          'Failed to read prompt file',
        )
      }
    }

    return loaded
  }

  private getBootstrapCacheKey(agentId: string, chatId: string): string {
    return `${agentId}:${chatId}`
  }

  private buildSkillsSection(skillsPrompt?: string): string | null {
    const trimmed = skillsPrompt?.trim()
    if (!trimmed) {
      return null
    }

    // [XJC] 从"每轮回复前强制扫描技能"仪式软化为按需参考：普通请求直接回答，
    // 只有请求明确落在某技能领域时才读它的 SKILL.md（省一轮工具调用，也不再拖慢普通对话）。
    return [
      '## Skills (on-demand)',
      'The <available_skills> list below is a reference library, not a mandatory step.',
      '- For ordinary requests, answer directly without reading any SKILL.md.',
      '- Only when the request clearly falls into one skill\'s domain: read that SKILL.md at <location> with `Read`, then follow it. Pick the single most specific skill; never read more than one up front.',
      '- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.',
      trimmed,
    ].join('\n')
  }

  private loadGlobalSystemPrompt(): string | null {
    const systemPath = resolve(getPaths().prompts, 'system.md')
    if (!existsSync(systemPath)) return null

    try {
      return readFileSync(systemPath, 'utf-8').trim()
    } catch {
      return null
    }
  }

  private buildEnvContext(): string | null {
    const envPath = resolve(getPaths().prompts, 'env.md')
    if (!existsSync(envPath)) return null

    try {
      let envPrompt = readFileSync(envPath, 'utf-8')
      envPrompt = envPrompt
        .replace('{{os}}', process.platform)
        .replace('{{platform}}', process.arch)
        .replace('{{cwd}}', process.cwd())
      return envPrompt.trim()
    } catch {
      return null
    }
  }

  private buildChannelContext(chatId?: string): string | null {
    if (!chatId) return null

    const channel = inferChannelType(chatId)
    if (channel !== 'wechat-personal') return null

    const recipientId = this.parseWechatPersonalPeerId(chatId)
    if (!recipientId) return null

    return [
      '## Channel Context',
      '',
      '- Current channel: wechat-personal',
      `- Current recipient WeChat ID: ${recipientId}`,
      '- This channel supports sending text, images, and files back to the current user.',
      '- To send an image or file, use the `mcp__message__send_to_current_chat` tool and set `media` to an absolute local file path or an HTTPS URL.',
      '- To send plain text back to the user without media, use the `mcp__message__send_to_current_chat` tool with `text`.',
      '- For the current conversation, do not claim that WeChat cannot send images or files. Send them directly with `mcp__message__send_to_current_chat` instead.',
      '- You normally do not need to set `to` manually for the current conversation recipient.',
      '- If you generate or save a file before sending it, always use an absolute path such as `/tmp/example.png`.',
    ].join('\n')
  }

  private parseWechatPersonalPeerId(chatId: string): string | null {
    if (!chatId.startsWith('wxp:')) return null
    const rest = chatId.slice(4)
    const firstColon = rest.indexOf(':')
    if (firstColon <= 0 || firstColon === rest.length - 1) return null
    return rest.slice(firstColon + 1)
  }
}
