import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/index.ts'
import { sanitizeAgentOpsLabel, stableRedactedJson } from './redaction.ts'
import {
  EMPTY_AGENTOPS_USAGE,
  type AgentOpsCoverage,
  type AgentOpsSpan,
  type AgentOpsTrace,
  type AgentOpsTraceDetail,
  type AgentOpsTraceFilters,
  type AgentOpsTraceStatus,
  type ModelUsageDelta,
  type ToolEffectClass,
} from './types.ts'

type AgentOpsRow = Record<string, unknown>

function nowIso(): string {
  return new Date().toISOString()
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function usageFromRow(row: AgentOpsRow) {
  return {
    modelCalls: finiteNonNegative(row.model_calls),
    inputTokens: finiteNonNegative(row.input_tokens),
    outputTokens: finiteNonNegative(row.output_tokens),
    cacheReadTokens: finiteNonNegative(row.cache_read_tokens),
    cacheWriteTokens: finiteNonNegative(row.cache_write_tokens),
    totalTokens: finiteNonNegative(row.total_tokens),
    costUsd: finiteNonNegative(row.cost_usd),
    unknownCostCalls: finiteNonNegative(row.unknown_cost_calls),
    modelLatencyMs: finiteNonNegative(row.model_latency_ms),
    toolCalls: finiteNonNegative(row.tool_calls),
    executedSteps: finiteNonNegative(row.executed_steps),
    skippedSteps: finiteNonNegative(row.skipped_steps),
    activeDurationMs: finiteNonNegative(row.active_duration_ms),
  }
}

function rowToTrace(row: AgentOpsRow): AgentOpsTrace {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status) as AgentOpsTraceStatus,
    agentId: (row.agent_id as string | null) ?? null,
    chatId: (row.chat_id as string | null) ?? null,
    turnId: (row.turn_id as string | null) ?? null,
    workflowId: (row.workflow_id as string | null) ?? null,
    workflowRunId: (row.workflow_run_id as string | null) ?? null,
    modelProvider: (row.model_provider as string | null) ?? null,
    modelId: (row.model_id as string | null) ?? null,
    usage: usageFromRow(row),
    toolNames: parseStringArray(row.tool_names_json),
    effectClasses: parseStringArray(row.effect_classes_json) as ToolEffectClass[],
    errorCode: (row.error_code as string | null) ?? null,
    stopReason: (row.stop_reason as string | null) ?? null,
    coverage: String(row.coverage ?? 'partial') as AgentOpsCoverage,
    coverageNotes: parseStringArray(row.coverage_notes_json),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  }
}

function rowToSpan(row: AgentOpsRow): AgentOpsSpan {
  return {
    id: String(row.id),
    traceId: String(row.trace_id),
    parentSpanId: (row.parent_span_id as string | null) ?? null,
    kind: String(row.kind),
    name: (row.name as string | null) ?? null,
    status: String(row.status) as AgentOpsTraceStatus,
    agentId: (row.agent_id as string | null) ?? null,
    turnId: (row.turn_id as string | null) ?? null,
    workflowStepId: (row.workflow_step_id as string | null) ?? null,
    workflowStepIndex: row.workflow_step_index == null ? null : Number(row.workflow_step_index),
    workflowItemIndex: row.workflow_item_index == null ? null : Number(row.workflow_item_index),
    modelProvider: (row.model_provider as string | null) ?? null,
    modelId: (row.model_id as string | null) ?? null,
    usage: usageFromRow(row),
    toolNames: parseStringArray(row.tool_names_json),
    effectClasses: parseStringArray(row.effect_classes_json) as ToolEffectClass[],
    errorCode: (row.error_code as string | null) ?? null,
    stopReason: (row.stop_reason as string | null) ?? null,
    coverage: String(row.coverage ?? 'partial') as AgentOpsCoverage,
    coverageNotes: parseStringArray(row.coverage_notes_json),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    finishedAt: (row.finished_at as string | null) ?? null,
  }
}

function normalizeCoverageNotes(notes: string[] | undefined): string[] {
  return [...new Set((notes ?? []).map((note) => sanitizeAgentOpsLabel(note)).filter(Boolean))].sort()
}

function safeCode(value: string | undefined | null): string | null {
  if (!value) return null
  return sanitizeAgentOpsLabel(value).toUpperCase().replace(/[-.:]/g, '_').slice(0, 80)
}

function safeReason(value: string | undefined | null): string | null {
  return value ? sanitizeAgentOpsLabel(value).slice(0, 120) : null
}

function safeOptionalLabel(value: string | undefined | null): string | null {
  return value ? sanitizeAgentOpsLabel(value) : null
}

export function startAgentOpsTrace(input: {
  id?: string
  kind: string
  status?: Extract<AgentOpsTraceStatus, 'queued' | 'running'>
  agentId?: string
  chatId?: string
  turnId?: string
  workflowId?: string
  workflowRunId?: string
  modelProvider?: string
  modelId?: string
  coverage?: AgentOpsCoverage
  coverageNotes?: string[]
  startedAt?: string
}): AgentOpsTrace {
  const id = input.id ?? randomUUID()
  const at = input.startedAt ?? nowIso()
  getDatabase().run(
    `INSERT OR IGNORE INTO agentops_traces (
      id, kind, status, agent_id, chat_id, turn_id, workflow_id, workflow_run_id,
      model_provider, model_id,
      coverage, coverage_notes_json, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sanitizeAgentOpsLabel(input.kind, 'turn'),
      input.status ?? 'running',
      safeOptionalLabel(input.agentId),
      safeOptionalLabel(input.chatId),
      safeOptionalLabel(input.turnId),
      safeOptionalLabel(input.workflowId),
      safeOptionalLabel(input.workflowRunId),
      input.modelProvider ? sanitizeAgentOpsLabel(input.modelProvider) : null,
      input.modelId ? sanitizeAgentOpsLabel(input.modelId) : null,
      input.coverage ?? 'partial',
      JSON.stringify(normalizeCoverageNotes(input.coverageNotes)),
      at,
      at,
    ],
  )
  return getAgentOpsTrace(id)!
}

export function markAgentOpsTraceRunning(traceId: string): void {
  getDatabase().run(
    `UPDATE agentops_traces
     SET status = 'running', updated_at = ?, finished_at = NULL
     WHERE id = ? AND status IN ('queued', 'failed', 'cancelled', 'interrupted')`,
    [nowIso(), traceId],
  )
}

export function startAgentOpsSpan(input: {
  id?: string
  traceId: string
  parentSpanId?: string
  kind: string
  name?: string
  agentId?: string
  turnId?: string
  workflowStepId?: string
  workflowStepIndex?: number
  workflowItemIndex?: number
  coverage?: AgentOpsCoverage
  coverageNotes?: string[]
  startedAt?: string
}): AgentOpsSpan {
  const id = input.id ?? randomUUID()
  const at = input.startedAt ?? nowIso()
  getDatabase().run(
    `INSERT OR IGNORE INTO agentops_spans (
      id, trace_id, parent_span_id, kind, name, status, agent_id, turn_id,
      workflow_step_id, workflow_step_index, workflow_item_index,
      coverage, coverage_notes_json, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.traceId,
      input.parentSpanId ?? null,
      sanitizeAgentOpsLabel(input.kind, 'span'),
      input.name ? sanitizeAgentOpsLabel(input.name) : null,
      safeOptionalLabel(input.agentId),
      safeOptionalLabel(input.turnId),
      safeOptionalLabel(input.workflowStepId),
      input.workflowStepIndex ?? null,
      input.workflowItemIndex ?? null,
      input.coverage ?? 'partial',
      JSON.stringify(normalizeCoverageNotes(input.coverageNotes)),
      at,
      at,
    ],
  )
  return getAgentOpsSpan(id)!
}

function applyUsageDelta(
  table: 'agentops_traces' | 'agentops_spans',
  id: string,
  delta: Partial<typeof EMPTY_AGENTOPS_USAGE>,
  model?: { provider?: string; id?: string },
): void {
  const at = nowIso()
  getDatabase().run(
    `UPDATE ${table} SET
      model_calls = model_calls + ?,
      input_tokens = input_tokens + ?,
      output_tokens = output_tokens + ?,
      cache_read_tokens = cache_read_tokens + ?,
      cache_write_tokens = cache_write_tokens + ?,
      total_tokens = total_tokens + ?,
      cost_usd = cost_usd + ?,
      unknown_cost_calls = unknown_cost_calls + ?,
      model_latency_ms = model_latency_ms + ?,
      tool_calls = tool_calls + ?,
      executed_steps = executed_steps + ?,
      skipped_steps = skipped_steps + ?,
      active_duration_ms = active_duration_ms + ?,
      model_provider = COALESCE(?, model_provider),
      model_id = COALESCE(?, model_id),
      updated_at = ?
     WHERE id = ?`,
    [
      finiteNonNegative(delta.modelCalls),
      finiteNonNegative(delta.inputTokens),
      finiteNonNegative(delta.outputTokens),
      finiteNonNegative(delta.cacheReadTokens),
      finiteNonNegative(delta.cacheWriteTokens),
      finiteNonNegative(delta.totalTokens),
      finiteNonNegative(delta.costUsd),
      finiteNonNegative(delta.unknownCostCalls),
      finiteNonNegative(delta.modelLatencyMs),
      finiteNonNegative(delta.toolCalls),
      finiteNonNegative(delta.executedSteps),
      finiteNonNegative(delta.skippedSteps),
      finiteNonNegative(delta.activeDurationMs),
      model?.provider ? sanitizeAgentOpsLabel(model.provider) : null,
      model?.id ? sanitizeAgentOpsLabel(model.id) : null,
      at,
      id,
    ],
  )
}

export function recordAgentOpsModelUsage(input: {
  traceId: string
  spanId?: string
  model: { provider: string; id: string }
  usage: ModelUsageDelta
  pricingKnown: boolean
  latencyMs?: number
}): void {
  const usageValues = [
    input.usage.input,
    input.usage.output,
    input.usage.cacheRead,
    input.usage.cacheWrite,
    input.usage.totalTokens,
  ]
  const providerUsageKnown = usageValues.every(
    (value) => Number.isFinite(value) && value >= 0,
  )
  const reportedCost = input.usage.cost?.total
  const providerCostKnown = input.pricingKnown
    && Number.isFinite(reportedCost)
    && reportedCost >= 0
  const latencyKnown = input.latencyMs !== undefined
    && Number.isFinite(input.latencyMs)
    && input.latencyMs >= 0
  const delta = {
    modelCalls: 1,
    inputTokens: input.usage.input,
    outputTokens: input.usage.output,
    cacheReadTokens: input.usage.cacheRead,
    cacheWriteTokens: input.usage.cacheWrite,
    totalTokens: input.usage.totalTokens,
    costUsd: reportedCost,
    unknownCostCalls: providerCostKnown ? 0 : 1,
    modelLatencyMs: latencyKnown ? input.latencyMs : 0,
  }
  applyUsageDelta('agentops_traces', input.traceId, delta, input.model)
  if (input.spanId) applyUsageDelta('agentops_spans', input.spanId, delta, input.model)
  if (!providerUsageKnown) {
    markAgentOpsCoverage({
      traceId: input.traceId,
      spanId: input.spanId,
      coverage: 'partial',
      note: 'provider_usage_unavailable',
    })
  }
  if (!providerCostKnown) {
    markAgentOpsCoverage({
      traceId: input.traceId,
      spanId: input.spanId,
      coverage: 'partial',
      note: input.pricingKnown ? 'provider_cost_unavailable' : 'unknown_model_price',
    })
  }
  if (!latencyKnown) {
    markAgentOpsCoverage({
      traceId: input.traceId,
      spanId: input.spanId,
      coverage: 'partial',
      note: 'model_latency_unavailable',
    })
  }
}

export function recordAgentOpsStep(input: {
  traceId: string
  spanId?: string
  skipped?: boolean
}): void {
  const delta = input.skipped ? { skippedSteps: 1 } : { executedSteps: 1 }
  applyUsageDelta('agentops_traces', input.traceId, delta)
  if (input.spanId) applyUsageDelta('agentops_spans', input.spanId, delta)
}

export function recordAgentOpsActiveDuration(traceId: string, durationMs: number): void {
  applyUsageDelta('agentops_traces', traceId, { activeDurationMs: durationMs })
}

function recordToolOnTable(
  table: 'agentops_traces' | 'agentops_spans',
  id: string,
  toolName: string,
  effect: ToolEffectClass,
  executed: boolean,
): void {
  const db = getDatabase()
  const row = db.query(`SELECT tool_names_json, effect_classes_json FROM ${table} WHERE id = ?`).get(id) as {
    tool_names_json?: string
    effect_classes_json?: string
  } | null
  if (!row) return
  const names = new Set(parseStringArray(row.tool_names_json))
  const effects = new Set(parseStringArray(row.effect_classes_json))
  names.add(sanitizeAgentOpsLabel(toolName, 'unknown_tool'))
  effects.add(effect)
  db.run(
    `UPDATE ${table}
     SET tool_names_json = ?, effect_classes_json = ?, tool_calls = tool_calls + ?, updated_at = ?
     WHERE id = ?`,
    [
      JSON.stringify([...names].sort()),
      JSON.stringify([...effects].sort()),
      executed ? 1 : 0,
      nowIso(),
      id,
    ],
  )
}

export function recordAgentOpsTool(input: {
  traceId: string
  spanId?: string
  toolName: string
  effect: ToolEffectClass
  executed?: boolean
}): void {
  const executed = input.executed !== false
  recordToolOnTable('agentops_traces', input.traceId, input.toolName, input.effect, executed)
  if (input.spanId) recordToolOnTable('agentops_spans', input.spanId, input.toolName, input.effect, executed)
}

function markCoverageOnTable(
  table: 'agentops_traces' | 'agentops_spans',
  id: string,
  coverage: AgentOpsCoverage,
  note?: string,
): void {
  const row = getDatabase().query(`SELECT coverage, coverage_notes_json FROM ${table} WHERE id = ?`).get(id) as {
    coverage: AgentOpsCoverage
    coverage_notes_json: string
  } | null
  if (!row) return
  const rank: Record<AgentOpsCoverage, number> = { exact: 2, partial: 1, none: 0 }
  const nextCoverage = rank[coverage] < rank[row.coverage] ? coverage : row.coverage
  const notes = new Set(parseStringArray(row.coverage_notes_json))
  if (note) notes.add(sanitizeAgentOpsLabel(note))
  getDatabase().run(
    `UPDATE ${table} SET coverage = ?, coverage_notes_json = ?, updated_at = ? WHERE id = ?`,
    [nextCoverage, JSON.stringify([...notes].sort()), nowIso(), id],
  )
}

export function markAgentOpsCoverage(input: {
  traceId: string
  spanId?: string
  coverage: AgentOpsCoverage
  note?: string
}): void {
  markCoverageOnTable('agentops_traces', input.traceId, input.coverage, input.note)
  if (input.spanId) markCoverageOnTable('agentops_spans', input.spanId, input.coverage, input.note)
}

export function finishAgentOpsSpan(
  spanId: string,
  status: Exclude<AgentOpsTraceStatus, 'queued' | 'running'>,
  metadata?: { errorCode?: string; stopReason?: string; coverage?: AgentOpsCoverage; coverageNotes?: string[] },
): void {
  const at = nowIso()
  getDatabase().run(
    `UPDATE agentops_spans SET
      status = ?, error_code = ?, stop_reason = ?,
      coverage = COALESCE(?, coverage),
      coverage_notes_json = CASE WHEN ? IS NULL THEN coverage_notes_json ELSE ? END,
      updated_at = ?, finished_at = ?
     WHERE id = ?`,
    [
      status,
      safeCode(metadata?.errorCode),
      safeReason(metadata?.stopReason),
      metadata?.coverage ?? null,
      metadata?.coverageNotes ? 1 : null,
      metadata?.coverageNotes ? JSON.stringify(normalizeCoverageNotes(metadata.coverageNotes)) : null,
      at,
      at,
      spanId,
    ],
  )
}

export function finishAgentOpsTrace(
  traceId: string,
  status: Exclude<AgentOpsTraceStatus, 'queued' | 'running'>,
  metadata?: { errorCode?: string; stopReason?: string; coverage?: AgentOpsCoverage; coverageNotes?: string[] },
): void {
  const at = nowIso()
  getDatabase().run(
    `UPDATE agentops_traces SET
      status = ?, error_code = ?, stop_reason = ?,
      coverage = COALESCE(?, coverage),
      coverage_notes_json = CASE WHEN ? IS NULL THEN coverage_notes_json ELSE ? END,
      updated_at = ?, finished_at = ?
     WHERE id = ?`,
    [
      status,
      safeCode(metadata?.errorCode),
      safeReason(metadata?.stopReason),
      metadata?.coverage ?? null,
      metadata?.coverageNotes ? 1 : null,
      metadata?.coverageNotes ? JSON.stringify(normalizeCoverageNotes(metadata.coverageNotes)) : null,
      at,
      at,
      traceId,
    ],
  )
}

export function getAgentOpsTrace(traceId: string): AgentOpsTrace | null {
  const row = getDatabase().query('SELECT * FROM agentops_traces WHERE id = ?').get(traceId) as AgentOpsRow | null
  return row ? rowToTrace(row) : null
}

export function getAgentOpsSpan(spanId: string): AgentOpsSpan | null {
  const row = getDatabase().query('SELECT * FROM agentops_spans WHERE id = ?').get(spanId) as AgentOpsRow | null
  return row ? rowToSpan(row) : null
}

export function getAgentOpsTraceDetail(traceId: string): AgentOpsTraceDetail | null {
  const trace = getAgentOpsTrace(traceId)
  if (!trace) return null
  const rows = getDatabase()
    .query('SELECT * FROM agentops_spans WHERE trace_id = ? ORDER BY started_at ASC, id ASC')
    .all(traceId) as AgentOpsRow[]
  return { trace, spans: rows.map(rowToSpan) }
}

function buildTraceWhere(filters: AgentOpsTraceFilters): {
  where: string
  params: Array<string | number>
} {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const equals: Array<[keyof AgentOpsTraceFilters, string]> = [
    ['kind', 'kind'],
    ['status', 'status'],
    ['agentId', 'agent_id'],
    ['chatId', 'chat_id'],
    ['turnId', 'turn_id'],
    ['workflowId', 'workflow_id'],
    ['workflowRunId', 'workflow_run_id'],
  ]
  for (const [key, column] of equals) {
    const value = filters[key]
    if (typeof value === 'string' && value) {
      clauses.push(`${column} = ?`)
      params.push(value)
    }
  }
  if (filters.from) {
    clauses.push('started_at >= ?')
    params.push(filters.from)
  }
  if (filters.to) {
    clauses.push('started_at <= ?')
    params.push(filters.to)
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

export function listAgentOpsTraces(filters: AgentOpsTraceFilters = {}): {
  items: AgentOpsTrace[]
  total: number
  offset: number
  limit: number
} {
  const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? 50)), 200)
  const offset = Math.max(0, Math.floor(filters.offset ?? 0))
  const { where, params } = buildTraceWhere(filters)
  const totalRow = getDatabase()
    .query(`SELECT COUNT(*) AS count FROM agentops_traces ${where}`)
    .get(...params) as { count: number }
  const rows = getDatabase()
    .query(`SELECT * FROM agentops_traces ${where} ORDER BY started_at DESC, id ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as AgentOpsRow[]
  return { items: rows.map(rowToTrace), total: Number(totalRow.count), offset, limit }
}

export function exportAgentOpsTraces(
  filters: AgentOpsTraceFilters = {},
  format: 'json' | 'jsonl' = 'json',
): string {
  const page = listAgentOpsTraces(filters)
  const details = page.items
    .map((trace) => getAgentOpsTraceDetail(trace.id)!)
    .sort((left, right) => {
      const leftKey = `${left.trace.startedAt}\0${left.trace.id}`
      const rightKey = `${right.trace.startedAt}\0${right.trace.id}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  if (format === 'jsonl') {
    return details.map((detail) => stableRedactedJson(detail, false)).join('\n') + (details.length > 0 ? '\n' : '')
  }
  return stableRedactedJson({
    schemaVersion: 1,
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
    traces: details,
  })
}

export function reconcileInterruptedAgentOpsTraces(): number {
  const at = nowIso()
  const traceResult = getDatabase().run(
    `UPDATE agentops_traces
     SET status = 'interrupted', error_code = 'PROCESS_RESTART', stop_reason = 'process_restart',
         updated_at = ?, finished_at = ?
     WHERE status IN ('queued', 'running')`,
    [at, at],
  )
  getDatabase().run(
    `UPDATE agentops_spans
     SET status = 'interrupted', error_code = 'PROCESS_RESTART', stop_reason = 'process_restart',
         updated_at = ?, finished_at = ?
     WHERE status IN ('queued', 'running')`,
    [at, at],
  )
  return Number(traceResult.changes ?? 0)
}
