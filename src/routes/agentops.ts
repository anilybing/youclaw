// [XJC-PATCH] Local authenticated AgentOps inspection and redacted export routes.
import { Hono } from 'hono'
import {
  exportAgentOpsTraces,
  getAgentOpsTraceDetail,
  listAgentOpsTraces,
  redactAgentOpsValue,
  type AgentOpsTraceFilters,
  type AgentOpsTraceStatus,
} from '../agentops/index.ts'

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function parseFilters(c: {
  req: { query: (key: string) => string | undefined }
}): AgentOpsTraceFilters {
  const page = boundedInteger(c.req.query('page'), 1, 1, 1_000_000)
  const pageSize = boundedInteger(c.req.query('pageSize'), 50, 1, 200)
  const value = (key: string): string | undefined => {
    const normalized = c.req.query(key)?.trim()
    return normalized || undefined
  }
  return {
    status: value('status') as AgentOpsTraceStatus | undefined,
    kind: value('kind'),
    agentId: value('agentId'),
    chatId: value('chatId'),
    turnId: value('turnId'),
    workflowId: value('workflowId'),
    workflowRunId: value('workflowRunId'),
    from: value('from'),
    to: value('to'),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  }
}

export function createAgentOpsRoutes(): Hono {
  const app = new Hono()

  app.get('/agentops/traces', (c) => {
    const filters = parseFilters(c)
    const result = listAgentOpsTraces(filters)
    return c.json({
      traces: redactAgentOpsValue(result.items),
      total: result.total,
      page: Math.floor(result.offset / result.limit) + 1,
      pageSize: result.limit,
    })
  })

  app.get('/agentops/traces/:traceId', (c) => {
    const detail = getAgentOpsTraceDetail(c.req.param('traceId'))
    if (!detail) return c.json({ error: 'Trace not found' }, 404)
    return c.json(redactAgentOpsValue({ trace: detail.trace, spans: detail.spans }))
  })

  app.get('/agentops/export', (c) => {
    const format = c.req.query('format') === 'jsonl' ? 'jsonl' : 'json'
    const body = exportAgentOpsTraces(parseFilters(c), format)
    c.header('Content-Type', format === 'jsonl'
      ? 'application/x-ndjson; charset=utf-8'
      : 'application/json; charset=utf-8')
    c.header('Content-Disposition', `attachment; filename="agentops-traces.${format}"`)
    return c.body(body)
  })

  return app
}
