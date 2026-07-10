import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { startAgentOpsTrace, finishAgentOpsTrace } from '../src/agentops/index.ts'
import { createAgentOpsRoutes } from '../src/routes/agentops.ts'
import { createLocalApiAuth, LOCAL_API_TOKEN_HEADER } from '../src/middleware/local-auth.ts'

const TOKEN = 'agentops-local-token'.padEnd(64, 'x')

function app() {
  const result = new Hono()
  result.use('/api/*', createLocalApiAuth(TOKEN).middleware)
  result.route('/api', createAgentOpsRoutes())
  return result
}

function auth(): HeadersInit {
  return { [LOCAL_API_TOKEN_HEADER]: TOKEN }
}

afterEach(() => {
  const db = getDatabase()
  db.run("DELETE FROM agentops_spans WHERE trace_id LIKE 'te-route-%'")
  db.run("DELETE FROM agentops_traces WHERE id LIKE 'te-route-%'")
})

describe('local AgentOps routes', () => {
  test('list/detail remain behind local API auth and support deterministic pagination', async () => {
    startAgentOpsTrace({
      id: 'te-route-one',
      kind: 'route_eval',
      status: 'running',
      agentId: 'office-assistant',
      coverage: 'exact',
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    finishAgentOpsTrace('te-route-one', 'success')

    const local = app()
    expect((await local.request('/api/agentops/traces')).status).toBe(401)
    const list = await local.request(
      '/api/agentops/traces?kind=route_eval&page=1&pageSize=1',
      { headers: auth() },
    )
    expect(list.status).toBe(200)
    const body = await list.json() as {
      traces: Array<{ id: string }>
      total: number
      page: number
      pageSize: number
    }
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 1 })
    expect(body.traces.map((trace) => trace.id)).toEqual(['te-route-one'])

    const detail = await local.request('/api/agentops/traces/te-route-one', { headers: auth() })
    expect(detail.status).toBe(200)
    expect((await detail.json() as { trace: { status: string } }).trace.status).toBe('success')
  })

  test('JSON and JSONL exports are stable and content typed', async () => {
    startAgentOpsTrace({
      id: 'te-route-export',
      kind: 'route_eval',
      status: 'running',
      coverage: 'partial',
      coverageNotes: ['deterministic_test'],
    })
    finishAgentOpsTrace('te-route-export', 'success')
    const local = app()

    const jsonl = await local.request(
      '/api/agentops/export?format=jsonl&kind=route_eval&pageSize=10',
      { headers: auth() },
    )
    expect(jsonl.status).toBe(200)
    expect(jsonl.headers.get('content-type')).toContain('application/x-ndjson')
    const first = await jsonl.text()
    const second = await (await local.request(
      '/api/agentops/export?format=jsonl&kind=route_eval&pageSize=10',
      { headers: auth() },
    )).text()
    expect(first).toBe(second)
    expect(JSON.parse(first).trace.id).toBe('te-route-export')
  })
})
