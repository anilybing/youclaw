// [XJC] 人设一键优化（需求再优化，对标同行"创建智能体"的 ✨优化 + 技能自动匹配）
//
// 用户创建数字员工时往往只会写一句大白话（"我是做电商女装的，需要爆款文案、卖货视频、
// 套图和海报"）。本服务用一次 LLM 调用把它改写成结构化人设（角色定位/核心职责/工作方式/红线，
// 落 SOUL.md 语义），同时从**本机已安装技能清单**中自动匹配该员工该挂的技能。
//
// 结构对齐 MemoryExtractor：resolveRuntimeModelConfig → resolvePiModel → complete 单发；
// runner 可注入（测试不打真模型）。技能匹配只允许清单内 slug（LLM 幻觉技能被过滤）。

import { complete, type AssistantMessage, type Context } from '@mariozechner/pi-ai'
import { randomUUID } from 'node:crypto'
import { getLogger } from '../logger/index.ts'
import { resolvePiModel } from './model-resolver.ts'
import { getAuthToken } from '../routes/auth.ts'
import { resolveRuntimeModelConfig } from './runtime-model.ts'
import {
  finishAgentOpsTrace,
  isModelPriceKnown,
  markAgentOpsCoverage,
  recordAgentOpsModelUsage,
  startAgentOpsTrace,
  type AgentOpsTraceContext,
} from '../agentops/index.ts'
import { authorizeWorkflowModel, recordWorkflowModelUsage } from '../workflow/budget.ts'

export interface SkillCandidate {
  name: string
  description: string
}

export interface OptimizePersonaResult {
  /** 结构化人设（Markdown，落 SOUL.md） */
  persona: string
  /** 建议的员工显示名（用户没起好名时可采纳） */
  suggestedName: string
  /** 从候选清单匹配到的技能 name（已过滤幻觉项） */
  suggestedSkills: string[]
}

export interface PersonaLlmRunner {
  (systemPrompt: string, userPrompt: string): Promise<string>
}

export interface SingleCompletionOptions {
  /** 员工显式配置的模型；未提供时继承设置中的当前激活模型。 */
  agentModel?: string | null
  agentId?: string
  purpose?: string
  agentOps?: AgentOpsTraceContext
  signal?: AbortSignal
}

const PERSONA_MAX_INPUT_CHARS = 2000
const SKILL_LIST_MAX = 80

const SYSTEM_PROMPT = [
  '你是数字员工人设设计师。用户会给一段随手写的需求描述，你要把它改写成一份专业的数字员工人设。',
  '输出 JSON（只输出 JSON，不要代码块），结构：',
  '{"suggestedName":"≤8字的员工名","persona":"Markdown 人设全文","skills":["技能name",...]}',
  'persona 要求：以「# 角色定位」「## 核心职责」「## 工作方式」「## 红线」四节组织；',
  '- 角色定位一句话；核心职责 3-6 条列表（覆盖用户提到的每类产出）；',
  '- 工作方式 2-4 条（先确认关键信息再动手、产出规格等）；',
  '- 红线 1-3 条（如不虚构数据、平台合规）；',
  '- 全文中文、≤600 字、保留用户的行业与具体诉求，禁止编造用户没提的业务。',
  'skills 要求：只能从下面提供的「可选技能清单」里选 name，选与职责直接相关的 0-8 个；没有合适的就给空数组，禁止编造。',
].join('\n')

function trimInput(text: string): string {
  const t = text.trim()
  return t.length > PERSONA_MAX_INPUT_CHARS ? t.slice(0, PERSONA_MAX_INPUT_CHARS) : t
}

function extractText(response: { content: AssistantMessage['content'] }): string {
  return response.content
    .filter((block): block is Extract<AssistantMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 安全的单发模型直调；可按员工显式模型解析，未指定则使用当前激活模型。 */
export async function runSingleCompletion(
  systemPrompt: string,
  userPrompt: string,
  options?: SingleCompletionOptions,
): Promise<string> {
  return runCompletion(systemPrompt, userPrompt, options)
}

/** 默认 runner：走当前激活模型单发（与 MemoryExtractor 同款链路） */
async function defaultRunner(systemPrompt: string, userPrompt: string): Promise<string> {
  return runCompletion(systemPrompt, userPrompt, { purpose: 'persona_optimization' })
}

async function runCompletion(
  systemPrompt: string,
  userPrompt: string,
  options: SingleCompletionOptions = {},
): Promise<string> {
  const resolved = resolveRuntimeModelConfig({ agentModel: options.agentModel })
  if (!resolved.config) {
    throw new Error(resolved.error ?? '未配置可用模型，请先到 设置 → 模型 配置')
  }
  const model = resolvePiModel(resolved.config)
  const pricingKnown = isModelPriceKnown(model)
  const ownsTrace = !options.agentOps
  const agentOps = options.agentOps ?? { traceId: randomUUID() }
  try {
    if (ownsTrace) {
      startAgentOpsTrace({
        id: agentOps.traceId,
        kind: options.purpose ?? 'single_completion',
        status: 'running',
        agentId: options.agentId,
        workflowId: agentOps.workflowId,
        workflowRunId: agentOps.workflowRunId,
        coverage: pricingKnown ? 'exact' : 'partial',
        coverageNotes: pricingKnown ? [] : ['unknown_model_price'],
      })
    } else if (!pricingKnown) {
      markAgentOpsCoverage({
        traceId: agentOps.traceId,
        spanId: agentOps.spanId,
        coverage: 'partial',
        note: 'unknown_model_price',
      })
    }
  } catch {
    // Tracing is best-effort.
  }
  if (resolved.config.provider === 'builtin') {
    const authToken = getAuthToken()
    if (authToken) model.headers = { ...model.headers, rdxtoken: authToken }
  }
  const context: Context = {
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
  }
  const startedAt = Date.now()
  try {
    if (agentOps.workflowRunId) authorizeWorkflowModel(agentOps.workflowRunId, pricingKnown)
    const response = await complete(model, context, {
      apiKey: resolved.config.apiKey,
      headers: model.headers,
      temperature: 0.3,
      maxTokens: 1200,
      signal: options.signal,
    })
    const latencyMs = Date.now() - startedAt
    try {
      recordAgentOpsModelUsage({
        traceId: agentOps.traceId,
        spanId: agentOps.spanId,
        model: { provider: model.provider, id: model.id },
        usage: response.usage,
        pricingKnown,
        latencyMs,
      })
    } catch {
      // Tracing is best-effort.
    }
    if (agentOps.workflowRunId) {
      recordWorkflowModelUsage(agentOps.workflowRunId, response.usage, pricingKnown, latencyMs)
    }
    if (ownsTrace) {
      try { finishAgentOpsTrace(agentOps.traceId, 'success') } catch {}
    }
    return extractText(response)
  } catch (err) {
    if (ownsTrace) {
      try {
        const typed = err as Error & { code?: string; stopReason?: string }
        finishAgentOpsTrace(agentOps.traceId, 'failed', {
          errorCode: typed.code ?? 'SINGLE_COMPLETION_FAILED',
          stopReason: typed.stopReason ?? 'completion_error',
        })
      } catch {
        // Tracing is best-effort.
      }
    }
    throw err
  }
}

/** 解析 LLM 输出（容错：剥代码块、截取首尾大括号） */
export function parseOptimizeResponse(raw: string, allowedSkills: Set<string>): OptimizePersonaResult {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1]?.trim() || trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const jsonText = start >= 0 && end >= start ? candidate.slice(start, end + 1) : candidate

  const parsed = JSON.parse(jsonText) as { suggestedName?: unknown; persona?: unknown; skills?: unknown }
  const persona = typeof parsed.persona === 'string' ? parsed.persona.trim() : ''
  if (!persona) throw new Error('模型未返回有效人设')

  const suggestedName = typeof parsed.suggestedName === 'string' ? parsed.suggestedName.trim().slice(0, 20) : ''
  const suggestedSkills = Array.isArray(parsed.skills)
    ? [...new Set(parsed.skills
        .map((s) => String(s).trim())
        .filter((s) => allowedSkills.has(s)))].slice(0, 8)
    : []

  return { persona, suggestedName, suggestedSkills }
}

/**
 * 优化一段用户随手写的需求为结构化人设 + 自动匹配技能。
 * @param draft 用户原始描述
 * @param skillCandidates 本机已安装技能（name+description），作为匹配候选
 * @param runner 可注入 LLM runner（测试用）
 */
export async function optimizePersona(
  draft: string,
  skillCandidates: SkillCandidate[],
  runner: PersonaLlmRunner = defaultRunner,
): Promise<OptimizePersonaResult> {
  const input = trimInput(draft)
  if (!input) throw new Error('请先填写你的需求描述')

  const candidates = skillCandidates.slice(0, SKILL_LIST_MAX)
  const skillList = candidates.length > 0
    ? candidates.map((s) => `- ${s.name}: ${s.description.slice(0, 60)}`).join('\n')
    : '（本机暂无可选技能）'

  const userPrompt = [
    '用户的需求描述：',
    input,
    '',
    '可选技能清单（skills 只能从这里选 name）：',
    skillList,
  ].join('\n')

  const raw = await runner(SYSTEM_PROMPT, userPrompt)
  const allowed = new Set(candidates.map((s) => s.name))
  const result = parseOptimizeResponse(raw, allowed)
  getLogger().info({ draftChars: input.length, skills: result.suggestedSkills.length, category: 'agent' }, 'Persona optimized')
  return result
}
