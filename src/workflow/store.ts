// [XJC] 工作流引擎·存储层（通用/垂直双路线的编排原语）
//
// 工作流 = 命名的多步流水线：每步一段 prompt 模板（支持 {{input}} 占位），
// 执行时逐步跑 agent 回合、上一步产出自动串给下一步（见 runner.ts）。
// 三种来源：builtin（随包预置的垂直流水线）/ user（UI/API 建）/ agent（对话中沉淀——
// agent 察觉"收集数据→分析→产出内容"这类固定需求时建议保存，用户一句话复跑）。

import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'
import { hasWorkflowNodeTool } from './nodes.ts'
import {
  EMPTY_AGENTOPS_USAGE,
  TOOL_EFFECT_CLASSES,
  type AgentOpsUsage,
  type ToolEffectClass,
} from '../agentops/types.ts'
import { ANIME_DRAMA_WORKFLOW_ID, buildAnimeDramaWorkflowDefinition } from './anime-drama'

export const WORKFLOW_INVALID = 'WORKFLOW_INVALID'
export const WORKFLOW_NOT_FOUND = 'WORKFLOW_NOT_FOUND'
export const WORKFLOW_BUILTIN_PROTECTED = 'WORKFLOW_BUILTIN_PROTECTED'
export const TODAY_BUSINESS_BRIEF_WORKFLOW_ID = 'xjc-today-business-brief-v1'
export { ANIME_DRAMA_WORKFLOW_ID }

const PROTECTED_BUILTIN_WORKFLOW_IDS = new Set([TODAY_BUSINESS_BRIEF_WORKFLOW_ID])

export class WorkflowError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

/** 条件跳过（对标扣子"选择器"的轻量版）：when 不满足则跳过该步 */
export interface WorkflowStepWhen {
  /** 变量引用，如 "steps.check.output" 或 "inputs.topic" */
  var: string
  op: 'contains' | 'not_contains' | 'is_empty' | 'not_empty'
  value?: string
}

/**
 * 步骤四种节点类型（对标扣子异构节点，成本/确定性分层）：
 * - agent（默认）：完整员工回合（带全部工具，自主性最高、最贵）
 * - llm：单次模型直调（无工具循环，便宜快速确定，适合改写/大纲/总结类）
 * - tool：确定性内置工具（零模型消耗，见 nodes.ts 白名单）
 * - approval：人工审批闸口——跑到此步暂停（awaiting_approval），等用户在 UI 批准后续跑、拒绝则终止
 */
/** 循环执行（对标扣子"循环/批处理节点"的列表遍历模式） */
export interface WorkflowStepForEach {
  /** 列表来源变量引用（如 "steps.topic_pick.output"）：JSON 字符串数组，或按行切分 */
  var: string
  /** 遍历条数上限（默认 5，硬上限 20——每项都是一次执行，防止成本爆炸） */
  maxItems?: number
}

export interface WorkflowStep {
  /** 步骤引用 id（缺省自动分配 step1..stepN），供 {{steps.<id>.output}} 引用 */
  id?: string
  title: string
  /** agent/llm 节点：提示词模板；tool 节点可留空 */
  prompt: string
  kind?: 'agent' | 'llm' | 'tool' | 'approval'
  /** kind=tool 时必填：nodes.ts 注册表内的工具名 */
  tool?: string
  /** kind=tool 时的参数模板（值支持 {{变量}} 引用） */
  args?: Record<string, string>
  when?: WorkflowStepWhen
  /** 配置后本步对列表逐项执行：模板中用 {{item}}/{{item_index}}；产出为各项结果拼接 */
  forEach?: WorkflowStepForEach
}

export interface WorkflowInput {
  key: string
  label: string
}

export interface Workflow {
  id: string
  name: string
  description: string
  agentId: string
  steps: WorkflowStep[]
  inputs: WorkflowInput[]
  budgets: WorkflowBudgets | null
  source: 'builtin' | 'user' | 'agent'
  runCount: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowRun {
  id: string
  workflowId: string
  status: 'running' | 'success' | 'failed' | 'awaiting_approval'
  currentStep: number
  inputs: Record<string, string>
  outputs: string[]
  budgets: WorkflowBudgets | null
  usage: AgentOpsUsage
  traceId: string | null
  chatId: string
  error: string | null
  errorCode: string | null
  stopReason: string | null
  startedAt: string
  finishedAt: string | null
}

export interface WorkflowBudgets {
  /** Executed node invocations; each forEach item counts once, skipped when-nodes count zero. */
  maxSteps?: number
  maxTotalTokens?: number
  maxCostUsd?: number
  maxActiveDurationMs?: number
  maxToolCalls?: number
  deniedToolEffects?: ToolEffectClass[]
  /** deny rejects models with no known price before the provider call. */
  unknownCostPolicy?: 'allow' | 'deny'
}

/** forEach 步骤的内部逐项检查点；不混入 outputs，保持现有 API 输出格式。 */
export interface WorkflowForEachCheckpoint {
  stepIndex: number
  stepId: string
  items: string[]
  outputs: string[]
}

export const FOREACH_HARD_CAP = 20
export const FOREACH_DEFAULT_CAP = 5

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const INPUT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
const MAX_STEPS = 12
const MAX_INPUTS = 8
const MAX_PROMPT = 4000
const MAX_NAME = 100
const MAX_DESC = 500

function nowIso(): string {
  return new Date().toISOString()
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseUsage(raw: unknown): AgentOpsUsage {
  const parsed = parseJsonObject(raw)
  return Object.fromEntries(
    Object.entries(EMPTY_AGENTOPS_USAGE).map(([key, fallback]) => {
      const value = Number(parsed[key])
      return [key, Number.isFinite(value) && value >= 0 ? value : fallback]
    }),
  ) as unknown as AgentOpsUsage
}

function parseBudgets(raw: unknown): WorkflowBudgets | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  return validateWorkflowBudgets(parseJsonObject(raw))
}

function nonNegativeInteger(value: unknown, key: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new WorkflowError(WORKFLOW_INVALID, `${key} 需为 0-${max} 的整数`)
  }
  return number
}

function nonNegativeNumber(value: unknown, key: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > max) {
    throw new WorkflowError(WORKFLOW_INVALID, `${key} 需大于等于 0 且不超过 ${max}`)
  }
  return number
}

export function validateWorkflowBudgets(input: unknown): WorkflowBudgets | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowError(WORKFLOW_INVALID, 'budgets 必须是对象')
  }
  const raw = input as Record<string, unknown>
  const unknownCostPolicy = raw.unknownCostPolicy === undefined
    ? undefined
    : raw.unknownCostPolicy === 'allow' || raw.unknownCostPolicy === 'deny'
      ? raw.unknownCostPolicy
      : (() => { throw new WorkflowError(WORKFLOW_INVALID, 'unknownCostPolicy 只能是 allow 或 deny') })()
  const denied = raw.deniedToolEffects
  let deniedToolEffects: ToolEffectClass[] | undefined
  if (denied !== undefined) {
    if (!Array.isArray(denied)) throw new WorkflowError(WORKFLOW_INVALID, 'deniedToolEffects 必须是数组')
    const allowed = new Set<string>(TOOL_EFFECT_CLASSES)
    deniedToolEffects = [...new Set(denied.map(String))]
      .map((effect) => {
        if (!allowed.has(effect)) throw new WorkflowError(WORKFLOW_INVALID, `未知工具副作用类型：${effect}`)
        return effect as ToolEffectClass
      })
      .sort()
  }
  const budgets: WorkflowBudgets = {
    maxSteps: nonNegativeInteger(raw.maxSteps, 'maxSteps', 10_000),
    maxTotalTokens: nonNegativeInteger(raw.maxTotalTokens, 'maxTotalTokens', 1_000_000_000),
    maxCostUsd: nonNegativeNumber(raw.maxCostUsd, 'maxCostUsd', 1_000_000),
    maxActiveDurationMs: nonNegativeInteger(raw.maxActiveDurationMs, 'maxActiveDurationMs', 7 * 24 * 60 * 60 * 1000),
    maxToolCalls: nonNegativeInteger(raw.maxToolCalls, 'maxToolCalls', 100_000),
    deniedToolEffects,
    unknownCostPolicy,
  }
  // [XJC-PATCH] 预算上限为 0 会让工作流首步立即触发上限而永远跑不起来(maxSteps:0 →
  // executedSteps(0) >= 0 立即抛)。任何已声明的数值上限必须 > 0(留空=不设该上限)。
  for (const key of ['maxSteps', 'maxTotalTokens', 'maxCostUsd', 'maxActiveDurationMs', 'maxToolCalls'] as const) {
    const v = budgets[key]
    if (typeof v === 'number' && v <= 0) {
      throw new WorkflowError(WORKFLOW_INVALID, `预算 ${key} 必须大于 0（留空表示不设该上限）`)
    }
  }
  const compact = Object.fromEntries(Object.entries(budgets).filter(([, value]) => value !== undefined))
  return Object.keys(compact).length > 0 ? compact as WorkflowBudgets : null
}

function parseForEachCheckpoint(raw: unknown): WorkflowForEachCheckpoint | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new WorkflowError(WORKFLOW_INVALID, '运行的 forEach 检查点已损坏，无法安全续跑')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new WorkflowError(WORKFLOW_INVALID, '运行的 forEach 检查点已损坏，无法安全续跑')
  }
  const value = parsed as Partial<WorkflowForEachCheckpoint>
  if (
    !Number.isInteger(value.stepIndex)
    || Number(value.stepIndex) < 0
    || typeof value.stepId !== 'string'
    || !value.stepId
    || !Array.isArray(value.items)
    || !value.items.every((item) => typeof item === 'string')
    || value.items.length > FOREACH_HARD_CAP
    || !Array.isArray(value.outputs)
    || !value.outputs.every((output) => typeof output === 'string')
    || value.outputs.length > value.items.length
  ) {
    throw new WorkflowError(WORKFLOW_INVALID, '运行的 forEach 检查点已损坏，无法安全续跑')
  }
  return {
    stepIndex: Number(value.stepIndex),
    stepId: value.stepId,
    items: value.items,
    outputs: value.outputs,
  }
}

function rowToWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    agentId: String(row.agent_id),
    steps: JSON.parse(String(row.steps_json)) as WorkflowStep[],
    inputs: JSON.parse(String(row.inputs_json ?? '[]')) as WorkflowInput[],
    budgets: parseBudgets(row.budgets_json),
    source: String(row.source) as Workflow['source'],
    runCount: Number(row.run_count ?? 0),
    lastRunAt: (row.last_run_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export function validateWorkflowDraft(input: {
  id?: string
  name: string
  description?: string
  agentId: string
  steps: WorkflowStep[]
  inputs?: WorkflowInput[]
  budgets?: WorkflowBudgets | null
}): { id: string; name: string; description: string; agentId: string; steps: WorkflowStep[]; inputs: WorkflowInput[]; budgets: WorkflowBudgets | null } {
  const id = (input.id?.trim() || `wf-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`).toLowerCase()
  if (!ID_RE.test(id)) throw new WorkflowError(WORKFLOW_INVALID, 'id 需为小写字母/数字/连字符（2-64 位）')
  const name = input.name.trim().slice(0, MAX_NAME)
  if (!name) throw new WorkflowError(WORKFLOW_INVALID, '需要工作流名称')
  const agentId = input.agentId.trim()
  if (!agentId) throw new WorkflowError(WORKFLOW_INVALID, '需要执行员工 agentId')

  const KINDS = new Set(['agent', 'llm', 'tool', 'approval'])
  const WHEN_OPS = new Set(['contains', 'not_contains', 'is_empty', 'not_empty'])
  const stepIds = new Set<string>()
  const steps: WorkflowStep[] = (input.steps ?? []).map((s, i) => {
    const kind = (s.kind ?? 'agent') as WorkflowStep['kind']
    const step: WorkflowStep = {
      id: (String(s.id ?? '').trim() || `step${i + 1}`).toLowerCase(),
      title: String(s.title ?? '').trim().slice(0, MAX_NAME),
      prompt: String(s.prompt ?? '').trim(),
      kind,
    }
    if (s.tool !== undefined) step.tool = String(s.tool).trim()
    if (s.args && typeof s.args === 'object') {
      step.args = Object.fromEntries(Object.entries(s.args).map(([k, v]) => [String(k), String(v).slice(0, MAX_PROMPT)]))
    }
    if (s.when && typeof s.when === 'object') {
      step.when = { var: String(s.when.var ?? '').trim(), op: s.when.op, value: s.when.value === undefined ? undefined : String(s.when.value) }
    }
    if (s.forEach && typeof s.forEach === 'object') {
      step.forEach = { var: String(s.forEach.var ?? '').trim(), maxItems: s.forEach.maxItems === undefined ? undefined : Number(s.forEach.maxItems) }
    }
    return step
  })
  if (steps.length === 0 || steps.length > MAX_STEPS) throw new WorkflowError(WORKFLOW_INVALID, `步骤数需在 1-${MAX_STEPS} 之间`)
  for (const [i, s] of steps.entries()) {
    if (!s.title) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步缺标题`)
    if (!INPUT_KEY_RE.test(s.id!)) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 id「${s.id}」不合法（小写字母开头，字母/数字/下划线）`)
    if (stepIds.has(s.id!)) throw new WorkflowError(WORKFLOW_INVALID, `步骤 id「${s.id}」重复`)
    stepIds.add(s.id!)
    if (!KINDS.has(s.kind!)) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 kind「${s.kind}」不合法（agent/llm/tool/approval）`)
    if (s.kind === 'tool') {
      if (!s.tool) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步是 tool 节点但缺 tool 名`)
      // [XJC-PATCH] 保存期即校验 tool 名是否已注册,避免「保存成功、运行到该步才报未注册工具」。
      if (!hasWorkflowNodeTool(s.tool)) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 tool「${s.tool}」未注册`)
    } else {
      if (!s.prompt) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步缺 prompt`)
    }
    if (s.prompt.length > MAX_PROMPT) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 prompt 超长（>${MAX_PROMPT}）`)
    if (s.when) {
      if (!s.when.var) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 when 缺 var`)
      if (!WHEN_OPS.has(s.when.op)) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 when.op「${s.when.op}」不合法`)
      if ((s.when.op === 'contains' || s.when.op === 'not_contains') && !s.when.value) {
        throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 when.op=${s.when.op} 需要 value`)
      }
    }
    if (s.forEach) {
      if (!s.forEach.var) throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 forEach 缺 var（列表来源变量引用）`)
      if (s.forEach.maxItems !== undefined && (!Number.isFinite(s.forEach.maxItems) || s.forEach.maxItems < 1 || s.forEach.maxItems > FOREACH_HARD_CAP)) {
        throw new WorkflowError(WORKFLOW_INVALID, `第 ${i + 1} 步 forEach.maxItems 需在 1-${FOREACH_HARD_CAP} 之间`)
      }
    }
  }

  const inputs = (input.inputs ?? []).map((f) => ({
    key: String(f.key ?? '').trim(),
    label: String(f.label ?? '').trim().slice(0, MAX_NAME) || String(f.key ?? '').trim(),
  }))
  if (inputs.length > MAX_INPUTS) throw new WorkflowError(WORKFLOW_INVALID, `输入参数最多 ${MAX_INPUTS} 个`)
  for (const f of inputs) {
    if (!INPUT_KEY_RE.test(f.key)) throw new WorkflowError(WORKFLOW_INVALID, `输入 key「${f.key}」不合法（小写字母开头，字母/数字/下划线）`)
  }

  return {
    id,
    name,
    description: (input.description ?? '').trim().slice(0, MAX_DESC),
    agentId,
    steps,
    inputs,
    budgets: validateWorkflowBudgets(input.budgets),
  }
}

export function saveWorkflow(input: {
  id?: string
  name: string
  description?: string
  agentId: string
  steps: WorkflowStep[]
  inputs?: WorkflowInput[]
  budgets?: WorkflowBudgets | null
  source?: Workflow['source']
}): Workflow {
  const requestedId = input.id?.trim().toLowerCase()
  const source = input.source ?? 'user'
  if (requestedId && PROTECTED_BUILTIN_WORKFLOW_IDS.has(requestedId) && source !== 'builtin') {
    throw new WorkflowError(WORKFLOW_BUILTIN_PROTECTED, '系统经营工作流不可覆盖；请复制为新的工作流后再修改')
  }
  const existing = requestedId ? getWorkflow(requestedId) : null
  const clean = validateWorkflowDraft({
    ...input,
    budgets: input.budgets === undefined ? existing?.budgets : input.budgets,
  })
  const at = nowIso()
  getDatabase().run(
    `INSERT INTO workflows (id, name, description, agent_id, steps_json, inputs_json, budgets_json, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, agent_id = excluded.agent_id,
       steps_json = excluded.steps_json, inputs_json = excluded.inputs_json,
       budgets_json = excluded.budgets_json, updated_at = excluded.updated_at`,
    [
      clean.id,
      clean.name,
      clean.description,
      clean.agentId,
      JSON.stringify(clean.steps),
      JSON.stringify(clean.inputs),
      clean.budgets ? JSON.stringify(clean.budgets) : null,
      source,
      at,
      at,
    ],
  )
  getLogger().info({ workflowId: clean.id, steps: clean.steps.length, source, category: 'workflow' }, 'Workflow saved')
  return getWorkflow(clean.id)!
}

export function getWorkflow(id: string): Workflow | null {
  const row = getDatabase().query('SELECT * FROM workflows WHERE id = ?').get(id.trim().toLowerCase()) as Record<string, unknown> | null
  return row ? rowToWorkflow(row) : null
}

export function listWorkflows(): Workflow[] {
  const rows = getDatabase().query('SELECT * FROM workflows ORDER BY updated_at DESC LIMIT 200').all() as Array<Record<string, unknown>>
  return rows.map(rowToWorkflow)
}

export function deleteWorkflow(id: string): boolean {
  const normalizedId = id.trim().toLowerCase()
  if (PROTECTED_BUILTIN_WORKFLOW_IDS.has(normalizedId)) {
    throw new WorkflowError(WORKFLOW_BUILTIN_PROTECTED, '系统经营工作流不可删除')
  }
  const result = getDatabase().run('DELETE FROM workflows WHERE id = ?', [normalizedId])
  return Number(result?.changes ?? 0) > 0
}

// ── 运行记录 ─────────────────────────────────────────────────────────
export function createRun(
  workflowId: string,
  inputs: Record<string, string>,
  chatId: string,
  options?: { budgets?: WorkflowBudgets | null; traceId?: string },
): WorkflowRun {
  const id = randomUUID()
  const at = nowIso()
  const workflow = getWorkflow(workflowId)
  const budgets = validateWorkflowBudgets(options?.budgets === undefined ? workflow?.budgets : options.budgets)
  const usage = { ...EMPTY_AGENTOPS_USAGE }
  getDatabase().run(
    `INSERT INTO workflow_runs (
      id, workflow_id, status, current_step, inputs_json, outputs_json,
      budgets_json, usage_json, trace_id, chat_id, active_started_at, started_at
    ) VALUES (?, ?, 'running', 0, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workflowId,
      JSON.stringify(inputs),
      budgets ? JSON.stringify(budgets) : null,
      JSON.stringify(usage),
      options?.traceId ?? null,
      chatId,
      at,
      at,
    ],
  )
  getDatabase().run('UPDATE workflows SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', [at, workflowId])
  return getRun(id)!
}

export function getRun(runId: string): WorkflowRun | null {
  const row = getDatabase().query('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as Record<string, unknown> | null
  if (!row) return null
  const usage = parseUsage(row.usage_json)
  const persistedActive = Number(row.active_duration_ms ?? 0)
  const runningActive = row.status === 'running' && typeof row.active_started_at === 'string'
    ? Math.max(0, Date.now() - Date.parse(row.active_started_at))
    : 0
  usage.activeDurationMs = Math.max(usage.activeDurationMs, persistedActive + runningActive)
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    status: String(row.status) as WorkflowRun['status'],
    currentStep: Number(row.current_step ?? 0),
    inputs: JSON.parse(String(row.inputs_json ?? '{}')) as Record<string, string>,
    outputs: JSON.parse(String(row.outputs_json ?? '[]')) as string[],
    budgets: parseBudgets(row.budgets_json),
    usage,
    traceId: (row.trace_id as string | null) ?? null,
    chatId: String(row.chat_id),
    error: (row.error as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    stopReason: (row.stop_reason as string | null) ?? null,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  }
}

/** 读取内部逐项检查点；旧版本 run 的列值为 NULL，按无检查点兼容。 */
export function getRunForEachCheckpoint(runId: string): WorkflowForEachCheckpoint | null {
  const row = getDatabase()
    .query('SELECT foreach_checkpoint_json FROM workflow_runs WHERE id = ?')
    .get(runId) as { foreach_checkpoint_json: string | null } | null
  return row ? parseForEachCheckpoint(row.foreach_checkpoint_json) : null
}

export function listRuns(workflowId: string, limit = 20): WorkflowRun[] {
  const rows = getDatabase()
    .query('SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(workflowId, Math.min(Math.max(1, limit), 100)) as Array<{ id: string }>
  return rows.map((r) => getRun(r.id)!).filter(Boolean)
}

export function hasRunningRun(workflowId: string): boolean {
  const row = getDatabase()
    .query("SELECT 1 FROM workflow_runs WHERE workflow_id = ? AND status IN ('running', 'awaiting_approval') LIMIT 1")
    .get(workflowId) as { 1: number } | null
  return Boolean(row)
}

export function addRunUsage(runId: string, delta: Partial<AgentOpsUsage>): AgentOpsUsage {
  const row = getDatabase().query('SELECT usage_json FROM workflow_runs WHERE id = ?').get(runId) as {
    usage_json: string
  } | null
  if (!row) throw new WorkflowError(WORKFLOW_NOT_FOUND, `运行「${runId}」不存在`)
  const usage = parseUsage(row.usage_json)
  for (const key of Object.keys(EMPTY_AGENTOPS_USAGE) as Array<keyof AgentOpsUsage>) {
    const value = Number(delta[key] ?? 0)
    if (Number.isFinite(value) && value > 0) usage[key] += value
  }
  getDatabase().run('UPDATE workflow_runs SET usage_json = ? WHERE id = ?', [JSON.stringify(usage), runId])
  return usage
}

export function setRunTraceId(runId: string, traceId: string): void {
  getDatabase().run('UPDATE workflow_runs SET trace_id = ? WHERE id = ?', [traceId, runId])
}

/**
 * Persist elapsed active time without counting the idle gap between a failed
 * run and an explicit resume.
 */
export function checkpointRunActivity(runId: string, atMs = Date.now()): number {
  const row = getDatabase().query(
    'SELECT status, active_duration_ms, active_started_at, usage_json FROM workflow_runs WHERE id = ?',
  ).get(runId) as {
    status: string
    active_duration_ms: number
    active_started_at: string | null
    usage_json: string
  } | null
  if (!row) return 0
  let active = Number(row.active_duration_ms ?? 0)
  if (row.status === 'running' && row.active_started_at) {
    active += Math.max(0, atMs - Date.parse(row.active_started_at))
  }
  const usage = parseUsage(row.usage_json)
  usage.activeDurationMs = Math.max(usage.activeDurationMs, active)
  getDatabase().run(
    `UPDATE workflow_runs
     SET active_duration_ms = ?, active_started_at = CASE WHEN status = 'running' THEN ? ELSE NULL END,
         usage_json = ?
     WHERE id = ?`,
    [active, new Date(atMs).toISOString(), JSON.stringify(usage), runId],
  )
  return active
}

/**
 * No workflow execution survives a sidecar process restart. Convert orphaned
 * rows to failed so the UI can offer an explicit resume instead of showing a
 * permanent "running" state or allowing a hidden duplicate execution.
 */
export function reconcileInterruptedRuns(
  reason = 'Sidecar restarted while this workflow was running. Resume from the last completed step.',
): number {
  const rows = getDatabase().query("SELECT id FROM workflow_runs WHERE status = 'running'").all() as Array<{ id: string }>
  for (const row of rows) checkpointRunActivity(row.id)
  const result = getDatabase().run(
    `UPDATE workflow_runs
     SET status = 'failed', error = ?, error_code = 'PROCESS_RESTART',
         stop_reason = 'process_restart', active_started_at = NULL, finished_at = ?
     WHERE status = 'running'`,
    [reason, nowIso()],
  )
  return Number(result?.changes ?? 0)
}

export function updateRunProgress(
  runId: string,
  currentStep: number,
  outputs: string[],
  forEachCheckpoint?: WorkflowForEachCheckpoint | null,
): void {
  checkpointRunActivity(runId)
  if (forEachCheckpoint === undefined) {
    getDatabase().run(
      'UPDATE workflow_runs SET current_step = ?, outputs_json = ? WHERE id = ?',
      [currentStep, JSON.stringify(outputs), runId],
    )
    return
  }
  getDatabase().run(
    'UPDATE workflow_runs SET current_step = ?, outputs_json = ?, foreach_checkpoint_json = ? WHERE id = ?',
    [currentStep, JSON.stringify(outputs), forEachCheckpoint ? JSON.stringify(forEachCheckpoint) : null, runId],
  )
}

export function finishRun(
  runId: string,
  status: 'success' | 'failed',
  error?: string,
  metadata?: { errorCode?: string; stopReason?: string },
): void {
  checkpointRunActivity(runId)
  getDatabase().run(
    `UPDATE workflow_runs
     SET status = ?, error = ?, error_code = ?, stop_reason = ?,
         active_started_at = NULL, finished_at = ?
     WHERE id = ? AND status = 'running'`,
    [status, error ?? null, metadata?.errorCode ?? null, metadata?.stopReason ?? null, nowIso(), runId],
  )
}

/** 断点续跑：failed → running（清错误与终态时间；进度与产出保留） */
export function reopenRun(runId: string): void {
  const at = nowIso()
  getDatabase().run(
    `UPDATE workflow_runs
     SET status = 'running', error = NULL, error_code = NULL, stop_reason = NULL,
         active_started_at = ?, finished_at = NULL
     WHERE id = ? AND status = 'failed'`,
    [at, runId],
  )
}

/** [XJC] 人工审批闸口：running → awaiting_approval（记录当前 approval 步，停止计时；进度/产出保留） */
export function pauseRunForApproval(runId: string, stepIndex: number): void {
  checkpointRunActivity(runId)
  getDatabase().run(
    `UPDATE workflow_runs
     SET status = 'awaiting_approval', current_step = ?, active_started_at = NULL
     WHERE id = ? AND status = 'running'`,
    [stepIndex, runId],
  )
}

/** [XJC] 人工批准：awaiting_approval → running（重置计时起点；进度/产出保留，由调用方推进到下一步） */
export function reopenApprovedRun(runId: string): void {
  getDatabase().run(
    `UPDATE workflow_runs
     SET status = 'running', error = NULL, error_code = NULL, stop_reason = NULL,
         active_started_at = ?, finished_at = NULL
     WHERE id = ? AND status = 'awaiting_approval'`,
    [nowIso(), runId],
  )
}

/** [XJC] 人工拒绝：awaiting_approval → failed（记录拒绝原因，终止本次运行） */
export function rejectRun(runId: string, reason: string): void {
  checkpointRunActivity(runId)
  getDatabase().run(
    `UPDATE workflow_runs
     SET status = 'failed', error = ?, error_code = 'WORKFLOW_REJECTED',
         stop_reason = 'rejected', active_started_at = NULL, finished_at = ?
     WHERE id = ? AND status = 'awaiting_approval'`,
    [reason, nowIso(), runId],
  )
}

// ── 内置流水线种子（按版本增量种入；用户删除/修改过的旧流程不复活、不覆盖）────
const SEED_FLAG_V1 = 'workflow_builtin_seeded_v1'
const SEED_FLAG_V2 = 'workflow_builtin_seeded_v2'
const SEED_FLAG_V3 = 'workflow_builtin_seeded_v3'
const SEED_FLAG_V4 = 'workflow_builtin_seeded_v4'
const V2_WORKFLOW_IDS = new Set(['competitor-page-analysis'])
const V3_WORKFLOW_IDS = new Set([TODAY_BUSINESS_BRIEF_WORKFLOW_ID])
const V4_WORKFLOW_IDS = new Set([ANIME_DRAMA_WORKFLOW_ID])

export const BUILTIN_WORKFLOWS: Array<Parameters<typeof saveWorkflow>[0]> = [
  {
    id: 'xianyu-new-listing',
    name: '闲鱼上新流水线',
    description: '给一个商品，产出行情调研→标题文案→定价建议→上架清单',
    agentId: 'xianyu-cs',
    inputs: [{ key: 'product', label: '商品（名称+成色/规格）' }, { key: 'cost', label: '成本价（可选）' }],
    steps: [
      { id: 'research', title: '行情调研', prompt: '联网搜索「{{product}}」在闲鱼/二手平台的近期成交与在售价格区间，列出 3-5 个可比案例并给出来源链接；信息不足的部分给出你的估计并标注【需核实】。' },
      { id: 'copywrite', title: '标题与文案', kind: 'llm', prompt: '基于行情调研：\n{{steps.research.output}}\n为「{{product}}」写 2 版闲鱼风标题（含搜索关键词）+ 一段卖点文案（口语化、真实感、不夸大），并给 3 个擦亮时段建议。' },
      { id: 'pricing', title: '定价建议', kind: 'llm', prompt: '行情调研：\n{{steps.research.output}}\n结合成本价「{{cost}}」给出挂牌价/可小刀底价/包邮策略建议，说明理由；若未提供成本价，按行情中位数策略给出建议。' },
      { id: 'listing', title: '上架清单', kind: 'llm', prompt: '标题文案：\n{{steps.copywrite.output}}\n定价建议：\n{{steps.pricing.output}}\n汇总为一份可直接照抄的上架清单：最终标题、文案、价格、常见买家问题的应答话术（含砍价）、发货话术。' },
    ],
    source: 'builtin',
  },
  {
    id: 'competitor-watch',
    name: '竞品监控简报',
    description: '定一个监控主题，产出最新动态收集→关键变化提取→行动简报',
    agentId: 'research-assistant',
    inputs: [{ key: 'topic', label: '监控主题（竞品/行业/关键词）' }],
    steps: [
      { id: 'collect', title: '动态收集', prompt: '用 web-search 联网搜索「{{topic}}」的最新动态（优先近 7 天），收集 5-8 条要闻/发布/价格变化，每条附来源链接与日期；来源不可靠的标注【需核实】。' },
      { id: 'extract', title: '关键变化提取', kind: 'llm', prompt: '从以下材料提取对我方有影响的关键变化与数据点（功能/价格/渠道/舆情），按影响程度排序，保留来源引用：\n{{steps.collect.output}}' },
      { id: 'brief', title: '行动简报', kind: 'llm', prompt: '基于关键变化：\n{{steps.extract.output}}\n输出一份简报：TL;DR（3 句内）→ 关键变化要点（带来源）→ 对我方的 2-3 条行动建议；推测性判断标注【推测】。' },
    ],
    source: 'builtin',
  },
  {
    id: 'content-pipeline',
    name: '内容日更流水线',
    description: '给一个主题，产出联网选题→大纲→成文→配图与发布清单',
    agentId: 'content-creator',
    inputs: [{ key: 'topic', label: '主题/领域' }, { key: 'platform', label: '平台（小红书/公众号/抖音口播，可选）' }],
    steps: [
      { id: 'topic_pick', title: '联网选题', prompt: '围绕「{{topic}}」联网搜索近期热点与讨论角度，给出 3 个候选选题（各附热度依据与来源），并推荐其一说明理由。' },
      { id: 'outline', title: '大纲', kind: 'llm', prompt: '选题结论：\n{{steps.topic_pick.output}}\n为推荐选题拟平台「{{platform}}」风格的内容大纲：钩子开头 → 3-5 个要点 → 行动号召；每个要点一句话说清讲什么。' },
      { id: 'draft', title: '成文', kind: 'llm', prompt: '按大纲成文：\n{{steps.outline.output}}\n风格匹配平台「{{platform}}」（未指定则默认小红书）：口语化、有真实细节、无 AI 腔；文末给 5-8 个话题标签。' },
      { id: 'publish_kit', title: '配图与发布清单', kind: 'llm', prompt: '正文：\n{{steps.draft.output}}\n为这篇内容写 2-3 条配图生成提示词（可直接喂生图工具），并汇总发布清单：标题、正文、标签、建议发布时间。' },
    ],
    source: 'builtin',
  },
  {
    id: 'data-report',
    name: '数据收集分析报告',
    description: '定一个数据目标，产出口径确认→联网收集→分析→结论报告',
    agentId: 'office-assistant',
    inputs: [{ key: 'goal', label: '数据目标（要弄清什么问题）' }],
    steps: [
      { id: 'collect', title: '口径与收集', prompt: '目标：「{{goal}}」。先明确统计口径与需要的数据维度，然后用 web-search 联网收集相关数据（引用来源与日期）；缺失的数据说明获取途径并标注【需核实】，不要编造数字。' },
      { id: 'analyze', title: '分析', kind: 'llm', prompt: '对以下数据做结构化分析：关键指标表格（Markdown）、趋势/对比要点、异常点与可能原因；区分事实与推断。\n数据：\n{{steps.collect.output}}' },
      { id: 'report', title: '结论报告', kind: 'llm', prompt: '目标：「{{goal}}」。基于分析：\n{{steps.analyze.output}}\n输出报告：结论先行（3 句内回答目标问题）→ 依据要点（引用数据来源）→ 2-3 条行动建议 → 附录（数据表格）。' },
    ],
    source: 'builtin',
  },
  {
    id: 'competitor-page-analysis',
    name: '竞品网页批量分析',
    description: '逐站安全抓取多个竞品页面，提取价格/卖点/活动信号并生成行动简报',
    agentId: 'ecommerce-assistant',
    inputs: [
      { key: 'urls', label: '竞品网页（一行一个，最多 5 个）' },
      { key: 'focus', label: '重点关注（价格/卖点/活动/评价等）' },
    ],
    budgets: {
      maxSteps: 8,
      maxTotalTokens: 20_000,
      maxCostUsd: 0.5,
      maxActiveDurationMs: 180_000,
      maxToolCalls: 5,
      unknownCostPolicy: 'allow',
    },
    steps: [
      {
        id: 'fetch_pages',
        title: '逐站安全抓取',
        kind: 'tool',
        tool: 'http_get',
        prompt: '',
        args: { url: '{{item}}', maxChars: '20000' },
        forEach: { var: 'inputs.urls', maxItems: 5 },
      },
      {
        id: 'extract_signals',
        title: '提取竞品信号',
        kind: 'llm',
        prompt: '重点关注：{{inputs.focus}}\n\n以下是逐站抓取结果：\n{{steps.fetch_pages.output}}\n\n按网页分别提取可验证信息：商品/品牌、价格与促销、核心卖点、规格、活动或上新信号。保留来源 URL；页面未提供的信息标注“未发现”，不要臆造。',
      },
      {
        id: 'action_brief',
        title: '生成行动简报',
        kind: 'llm',
        prompt: '基于竞品信号：\n{{steps.extract_signals.output}}\n\n输出一份可执行简报：① 三句结论；② 竞品对比表；③ 值得借鉴与应避免的做法；④ 按优先级排序的 3 条行动建议；⑤ 来源清单。事实与推断必须分开标注。',
      },
    ],
    source: 'builtin',
  },
  {
    id: TODAY_BUSINESS_BRIEF_WORKFLOW_ID,
    name: '今日经营行动简报',
    description: '读取本地经营画像和自动化实况，由模型只排序候选行动，再确定性生成不编造数据的今日简报',
    agentId: 'office-assistant',
    inputs: [],
    budgets: {
      maxSteps: 3,
      maxTotalTokens: 3_000,
      maxCostUsd: 0.1,
      maxActiveDurationMs: 60_000,
      maxToolCalls: 2,
      unknownCostPolicy: 'allow',
    },
    steps: [
      {
        id: 'snapshot',
        title: '读取经营实况',
        kind: 'tool',
        tool: 'today_business_snapshot',
        prompt: '',
        args: {},
      },
      {
        id: 'rank_actions',
        title: '排序今日行动',
        kind: 'llm',
        prompt: [
          '你是经营行动排序器。下面的 JSON 是本机代码生成的事实快照。',
          '只从 candidateActions 中选择最值得今天优先完成的 3 个 id，按优先级排序。',
          '不得新增行动、数字或事实，不得改写行动内容。',
          '只输出严格 JSON 字符串数组，例如 ["complete_profile","advance_goal_1","create_first_automation"]，不要解释、不要 Markdown。',
          '',
          '{{steps.snapshot.output}}',
        ].join('\n'),
      },
      {
        id: 'render_brief',
        title: '校验并生成简报',
        kind: 'tool',
        tool: 'render_today_business_brief',
        prompt: '',
        args: {
          snapshot: '{{steps.snapshot.output}}',
          ranking: '{{steps.rank_actions.output}}',
        },
      },
    ],
    source: 'builtin',
  },
  buildAnimeDramaWorkflowDefinition(),
]

/** 分版本增量种入内置流水线；升级只增加新版本流程，不恢复旧版本中被用户删除的流程。 */
export function seedBuiltinWorkflows(): number {
  const db = getDatabase()
  let seeded = 0
  const phases = [
    {
      key: SEED_FLAG_V1,
      workflows: BUILTIN_WORKFLOWS.filter(
        (wf) => !V2_WORKFLOW_IDS.has(wf.id!) && !V3_WORKFLOW_IDS.has(wf.id!) && !V4_WORKFLOW_IDS.has(wf.id!),
      ),
    },
    { key: SEED_FLAG_V2, workflows: BUILTIN_WORKFLOWS.filter((wf) => V2_WORKFLOW_IDS.has(wf.id!)) },
    { key: SEED_FLAG_V3, workflows: BUILTIN_WORKFLOWS.filter((wf) => V3_WORKFLOW_IDS.has(wf.id!)) },
    { key: SEED_FLAG_V4, workflows: BUILTIN_WORKFLOWS.filter((wf) => V4_WORKFLOW_IDS.has(wf.id!)) },
  ]
  for (const phase of phases) {
    const flag = db.query("SELECT value FROM kv_state WHERE key = ?").get(phase.key) as { value: string } | null
    if (flag?.value === '1') continue
    for (const wf of phase.workflows) {
      const exists = db.query('SELECT id FROM workflows WHERE id = ?').get(wf.id!.toLowerCase())
      if (exists) continue
      saveWorkflow(wf)
      seeded++
    }
    db.run('INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)', [phase.key, '1'])
  }
  if (seeded > 0) getLogger().info({ seeded, category: 'workflow' }, 'Builtin workflows seeded')
  return seeded
}
