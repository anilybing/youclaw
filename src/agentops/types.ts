export const AGENTOPS_TRACE_STATUSES = [
  'queued',
  'running',
  'success',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type AgentOpsTraceStatus = (typeof AGENTOPS_TRACE_STATUSES)[number]

export const AGENTOPS_COVERAGE_LEVELS = ['exact', 'partial', 'none'] as const
export type AgentOpsCoverage = (typeof AGENTOPS_COVERAGE_LEVELS)[number]

export const TOOL_EFFECT_CLASSES = [
  'read',
  'network',
  'write',
  'execute',
  'message',
  'inventory',
  'unknown',
] as const

export type ToolEffectClass = (typeof TOOL_EFFECT_CLASSES)[number]

export interface AgentOpsUsage {
  modelCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  costUsd: number
  unknownCostCalls: number
  modelLatencyMs: number
  toolCalls: number
  executedSteps: number
  skippedSteps: number
  activeDurationMs: number
}

export const EMPTY_AGENTOPS_USAGE: AgentOpsUsage = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  unknownCostCalls: 0,
  modelLatencyMs: 0,
  toolCalls: 0,
  executedSteps: 0,
  skippedSteps: 0,
  activeDurationMs: 0,
}

export interface AgentOpsTraceContext {
  traceId: string
  spanId?: string
  workflowId?: string
  workflowRunId?: string
  internal?: boolean
}

export interface AgentOpsTrace {
  id: string
  kind: string
  status: AgentOpsTraceStatus
  agentId: string | null
  chatId: string | null
  turnId: string | null
  workflowId: string | null
  workflowRunId: string | null
  modelProvider: string | null
  modelId: string | null
  usage: AgentOpsUsage
  toolNames: string[]
  effectClasses: ToolEffectClass[]
  errorCode: string | null
  stopReason: string | null
  coverage: AgentOpsCoverage
  coverageNotes: string[]
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

export interface AgentOpsSpan {
  id: string
  traceId: string
  parentSpanId: string | null
  kind: string
  name: string | null
  status: AgentOpsTraceStatus
  agentId: string | null
  turnId: string | null
  workflowStepId: string | null
  workflowStepIndex: number | null
  workflowItemIndex: number | null
  modelProvider: string | null
  modelId: string | null
  usage: AgentOpsUsage
  toolNames: string[]
  effectClasses: ToolEffectClass[]
  errorCode: string | null
  stopReason: string | null
  coverage: AgentOpsCoverage
  coverageNotes: string[]
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

export interface AgentOpsTraceDetail {
  trace: AgentOpsTrace
  spans: AgentOpsSpan[]
}

export interface AgentOpsTraceFilters {
  kind?: string
  status?: AgentOpsTraceStatus
  agentId?: string
  chatId?: string
  turnId?: string
  workflowId?: string
  workflowRunId?: string
  from?: string
  to?: string
  offset?: number
  limit?: number
}

export interface ModelUsageDelta {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    total: number
  }
}
