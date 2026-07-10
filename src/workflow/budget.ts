import type { ModelUsageDelta, ToolEffectClass } from '../agentops/types.ts'
import { addRunUsage, getRun, type WorkflowBudgets, type WorkflowRun } from './store.ts'

export const WORKFLOW_BUDGET_EXCEEDED = 'WORKFLOW_BUDGET_EXCEEDED'

export type WorkflowBudgetStopReason =
  | 'max_steps'
  | 'max_total_tokens'
  | 'max_cost_usd'
  | 'max_active_duration_ms'
  | 'max_tool_calls'
  | 'unknown_cost'
  | `denied_effect:${ToolEffectClass}`

export class WorkflowBudgetError extends Error {
  readonly code = WORKFLOW_BUDGET_EXCEEDED

  constructor(public readonly stopReason: WorkflowBudgetStopReason, message?: string) {
    super(message ?? workflowBudgetMessage(stopReason))
    this.name = 'WorkflowBudgetError'
  }
}

function workflowBudgetMessage(reason: WorkflowBudgetStopReason): string {
  if (reason.startsWith('denied_effect:')) {
    return `工作流预算阻止了工具副作用类型「${reason.slice('denied_effect:'.length)}」`
  }
  const labels: Record<Exclude<WorkflowBudgetStopReason, `denied_effect:${ToolEffectClass}`>, string> = {
    max_steps: '工作流已达到最大执行步骤数',
    max_total_tokens: '工作流已达到总 token 预算',
    max_cost_usd: '工作流已达到费用预算',
    max_active_duration_ms: '工作流已达到活跃执行时长预算',
    max_tool_calls: '工作流已达到工具调用预算',
    unknown_cost: '工作流禁止调用价格未知的模型',
  }
  return labels[reason as keyof typeof labels] ?? '工作流预算已停止执行'
}

function requireRun(runId: string): WorkflowRun {
  const run = getRun(runId)
  if (!run) throw new Error(`Workflow run not found: ${runId}`)
  return run
}

function checkActiveDuration(run: WorkflowRun): void {
  const max = run.budgets?.maxActiveDurationMs
  if (max !== undefined && run.usage.activeDurationMs >= max) {
    throw new WorkflowBudgetError('max_active_duration_ms')
  }
}

function checkBeforeModel(run: WorkflowRun, pricingKnown: boolean): void {
  checkActiveDuration(run)
  const budgets = run.budgets
  if (!budgets) return
  if (!pricingKnown && budgets.unknownCostPolicy === 'deny') {
    throw new WorkflowBudgetError('unknown_cost')
  }
  if (budgets.maxTotalTokens !== undefined && run.usage.totalTokens >= budgets.maxTotalTokens) {
    throw new WorkflowBudgetError('max_total_tokens')
  }
  if (budgets.maxCostUsd !== undefined && run.usage.costUsd >= budgets.maxCostUsd) {
    throw new WorkflowBudgetError('max_cost_usd')
  }
}

export function authorizeWorkflowStep(runId: string): void {
  const run = requireRun(runId)
  checkActiveDuration(run)
  if (run.budgets?.maxSteps !== undefined && run.usage.executedSteps >= run.budgets.maxSteps) {
    throw new WorkflowBudgetError('max_steps')
  }
  addRunUsage(runId, { executedSteps: 1 })
}

export function recordWorkflowSkippedStep(runId: string): void {
  checkActiveDuration(requireRun(runId))
  addRunUsage(runId, { skippedSteps: 1 })
}

export function enforceWorkflowActiveDuration(runId: string): void {
  checkActiveDuration(requireRun(runId))
}

export function authorizeWorkflowTool(runId: string, effect: ToolEffectClass): void {
  const run = requireRun(runId)
  checkActiveDuration(run)
  const budgets = run.budgets
  if (budgets?.deniedToolEffects?.includes(effect)) {
    throw new WorkflowBudgetError(`denied_effect:${effect}`)
  }
  if (budgets?.maxToolCalls !== undefined && run.usage.toolCalls >= budgets.maxToolCalls) {
    throw new WorkflowBudgetError('max_tool_calls')
  }
  addRunUsage(runId, { toolCalls: 1 })
}

export function authorizeWorkflowModel(runId: string, pricingKnown: boolean): void {
  checkBeforeModel(requireRun(runId), pricingKnown)
}

export function recordWorkflowModelUsage(
  runId: string,
  usage: ModelUsageDelta,
  pricingKnown: boolean,
  latencyMs = 0,
): void {
  const next = addRunUsage(runId, {
    modelCalls: 1,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
    unknownCostCalls: pricingKnown ? 0 : 1,
    modelLatencyMs: latencyMs,
  })
  const budgets: WorkflowBudgets | null = requireRun(runId).budgets
  if (!budgets) return
  // Provider accounting arrives after a call. These limits can therefore
  // overshoot by that one call, but stop all subsequent execution.
  if (budgets.maxTotalTokens !== undefined && next.totalTokens > budgets.maxTotalTokens) {
    throw new WorkflowBudgetError('max_total_tokens')
  }
  if (budgets.maxCostUsd !== undefined && next.costUsd > budgets.maxCostUsd) {
    throw new WorkflowBudgetError('max_cost_usd')
  }
  checkActiveDuration(requireRun(runId))
}

export function isWorkflowBudgetError(error: unknown): error is WorkflowBudgetError {
  return error instanceof WorkflowBudgetError
    || (error instanceof Error && (error as Error & { code?: string }).code === WORKFLOW_BUDGET_EXCEEDED)
}
