// [XJC] 数字员工创建 MCP 工具（自主能力强化 · 对话式建员工）
//
// 此前新建顶层数字员工只能走 UI/HTTP API——用户说"帮我建一个专管发票的员工"无法闭环。
// 本工具让 agent 在征得用户同意后直接创建：写 agent.yaml + SOUL.md + 工作区骨架并热重载，
// 与 POST /api/agents 同语义（复用 ensureAgentWorkspace/reloadAgents）。
// 运行时依赖经 configureEmployeeMcpRuntime 单例装配（与 skills-mcp 同款）。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { ensureAgentWorkspace } from './workspace.ts'
import { DEFAULT_BROWSER_PROFILE_ID } from '../browser/index.ts'
import type { AgentManager } from './manager.ts'

/** 与 manager.seedRemoteStaff / MVP capabilityAgentService 保持一致 */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const RESERVED_IDS = new Set([
  'default', '_global',
  'office-assistant', 'ecommerce-assistant', 'content-creator',
  'finance-assistant', 'hr-assistant', 'support-assistant', 'research-assistant', 'xianyu-cs',
])
const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PERSONA_MAX_CHARS = 4000

interface EmployeeMcpRuntimeDeps {
  agentManager: AgentManager
}

let runtimeDeps: EmployeeMcpRuntimeDeps | null = null

export function configureEmployeeMcpRuntime(deps: EmployeeMcpRuntimeDeps): void {
  runtimeDeps = deps
}

/** Test-only */
export function resetEmployeeMcpRuntime(): void {
  runtimeDeps = null
}

function requireDeps(): EmployeeMcpRuntimeDeps {
  if (!runtimeDeps) throw new Error('员工管理服务尚未初始化，请稍后重试')
  return runtimeDeps
}

const CreateEmployeeParams = Type.Object({
  id: Type.String({ description: 'URL-safe slug id for the new employee (lowercase letters/digits/hyphens, e.g. "invoice-assistant"). Must not collide with existing employees.' }),
  name: Type.String({ description: 'Display name shown to the user (e.g. "小橘发票助理").' }),
  persona: Type.String({ description: 'The employee\'s SOUL: role positioning, duties, working style, red lines. Written in Markdown, Chinese preferred. This becomes its SOUL.md.' }),
  skills: Type.Optional(Type.Array(Type.String(), { description: 'Optional skill whitelist (slugs of installed skills). Omit for none; the employee can still enable skills conversationally later.' })),
})

export function createEmployeeTools(): ToolDefinition[] {
  return [
    {
      name: 'mcp__agent__create_employee',
      label: 'mcp__agent__create_employee',
      description:
        'Create a NEW top-level digital employee (agent) with its own workspace, persona (SOUL.md) and optional skill whitelist. '
        + 'Use when the user wants a dedicated employee for a recurring domain (e.g. "帮我建一个专门管发票的员工"). '
        + 'POLICY: you MUST first tell the user the proposed id / name / duties and get their explicit consent before calling. '
        + 'After creation the employee appears in the employee list and can be chatted with immediately. '
        + 'Do NOT use for one-off tasks (do those yourself) and do NOT recreate roles that already exist (check the employee list first).',
      parameters: CreateEmployeeParams,
      async execute(_toolCallId, args: { id: string; name: string; persona: string; skills?: string[] }) {
        const deps = requireDeps()
        const id = (args.id ?? '').trim().toLowerCase()
        const name = (args.name ?? '').trim()
        const persona = (args.persona ?? '').trim()

        if (!AGENT_ID_RE.test(id)) throw new Error(`id「${id}」不合法：需为小写字母/数字/连字符（2-64 位，如 invoice-assistant）`)
        if (RESERVED_IDS.has(id)) throw new Error(`id「${id}」是内置保留员工，不可占用`)
        if (!name) throw new Error('需要提供 name（员工显示名）')
        if (!persona) throw new Error('需要提供 persona（员工职责/人设，将写入 SOUL.md）')
        if (deps.agentManager.getAgent(id)) throw new Error(`员工「${id}」已存在；如需调整请直接修改该员工`)

        const skills = (args.skills ?? [])
          .map((s) => String(s).trim().toLowerCase())
          .filter((s) => SKILL_SLUG_RE.test(s))
          .slice(0, 30)

        const agentDir = resolve(getPaths().agents, id)
        if (existsSync(agentDir)) throw new Error(`员工目录「${id}」已存在，换一个 id`)

        mkdirSync(agentDir, { recursive: true })
        const config: Record<string, unknown> = {
          id,
          name,
          browser: { defaultProfile: DEFAULT_BROWSER_PROFILE_ID },
          memory: { enabled: true },
          skills,
        }
        writeFileSync(resolve(agentDir, 'agent.yaml'), stringifyYaml(config))
        writeFileSync(resolve(agentDir, 'SOUL.md'), `# Soul\n\n${persona.slice(0, PERSONA_MAX_CHARS)}\n`)
        ensureAgentWorkspace(agentDir, { ensureBootstrap: true })
        await deps.agentManager.reloadAgents()

        getLogger().info({ id, name, skills: skills.length, category: 'agent' }, 'Employee created via conversation')
        return {
          content: [{
            type: 'text' as const,
            text: `已创建数字员工「${name}」（id: ${id}${skills.length ? `，技能：${skills.join(', ')}` : ''}）。`
              + '告知用户：可在左侧「数字员工」列表找到并直接对话；后续可在对话中让它自行启用/安装更多技能。',
          }],
          details: {},
        }
      },
    },
  ]
}
