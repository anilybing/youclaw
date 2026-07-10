// [XJC-PATCH] Deterministic trusted-execution release evaluations.
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import type { AgentManager } from '../src/agent/manager.ts'
import type { ProcessParams } from '../src/agent/types.ts'
import {
  AgentQueue,
  isQueueCancellationError,
  QUEUE_CANCELLATION_CODE,
} from '../src/agent/queue.ts'
import {
  exportAgentOpsTraces,
  finishAgentOpsTrace,
  getAgentOpsTrace,
  getAgentOpsTraceDetail,
  reconcileInterruptedAgentOpsTraces,
  recordAgentOpsModelUsage,
  recordAgentOpsTool,
  startAgentOpsTrace,
} from '../src/agentops/index.ts'
import {
  createRun,
  getRun,
  reconcileInterruptedRuns,
  saveWorkflow,
  type WorkflowRun,
} from '../src/workflow/store.ts'
import {
  configureWorkflowRuntime,
  resetWorkflowRuntimeForTest,
  resumeWorkflowRun,
  startWorkflowRun,
  type WorkflowRuntimeDeps,
} from '../src/workflow/runner.ts'
import { recordWorkflowModelUsage } from '../src/workflow/budget.ts'

const EXACT_USAGE = {
  input: 11,
  output: 7,
  cacheRead: 5,
  cacheWrite: 3,
  totalTokens: 26,
  cost: { total: 0.125 },
}

function cleanupTrustedExecution(): void {
  const db = getDatabase()
  db.run(`
    DELETE FROM agentops_spans
    WHERE trace_id IN (
      SELECT id FROM agentops_traces
      WHERE id LIKE 'te-%' OR chat_id LIKE 'te-%' OR chat_id LIKE 'workflow:te-%'
         OR workflow_id LIKE 'te-%' OR kind = 'trusted_eval'
    )
  `)
  db.run(`
    DELETE FROM agentops_traces
    WHERE id LIKE 'te-%' OR chat_id LIKE 'te-%' OR chat_id LIKE 'workflow:te-%'
       OR workflow_id LIKE 'te-%' OR kind = 'trusted_eval'
  `)
  db.run("DELETE FROM workflow_runs WHERE workflow_id LIKE 'te-%'")
  db.run("DELETE FROM workflows WHERE id LIKE 'te-%'")
  db.run("DELETE FROM chats WHERE chat_id LIKE 'workflow:te-%'")
  resetWorkflowRuntimeForTest()
}

afterEach(cleanupTrustedExecution)

type FakeProcess = (params: ProcessParams) => Promise<string>

function fakeManager(processors: Record<string, FakeProcess>): AgentManager {
  const agents = new Map(Object.entries(processors).map(([id, process]) => [id, {
    config: { maxConcurrency: 2 },
    runtime: { process },
    state: {
      sessionId: null,
      isProcessing: false,
      lastProcessedAt: null,
      totalProcessed: 0,
      lastError: null,
      queueDepth: 0,
    },
  }]))
  return {
    getAgent: (id: string) => agents.get(id),
  } as unknown as AgentManager
}

function complete(params: ProcessParams, result: string): string {
  if (params.executionState) params.executionState.status = 'success'
  return result
}

type EvalEvent =
  | { type: 'complete'; fullText: string; turnId: string; cancelled?: boolean }
  | { type: 'error'; error: string; turnId: string; errorCode?: string; stopReason?: string }

function installWorkflowRuntime(options?: {
  dispatch?: (
    params: Parameters<WorkflowRuntimeDeps['dispatchMessage']>[0],
    emit: (event: EvalEvent) => void,
  ) => void
  runLlm?: WorkflowRuntimeDeps['runLlm']
}): Array<NonNullable<Parameters<WorkflowRuntimeDeps['dispatchMessage']>[0]['agentOps']>> {
  const handlers = new Map<string, (event: EvalEvent) => void>()
  const contexts: Array<NonNullable<Parameters<WorkflowRuntimeDeps['dispatchMessage']>[0]['agentOps']>> = []
  configureWorkflowRuntime({
    hasEmployee: () => true,
    dispatchMessage: (params) => {
      if (params.agentOps) contexts.push(params.agentOps)
      const emit = (event: EvalEvent) => handlers.get(params.chatId)?.(event)
      if (options?.dispatch) options.dispatch(params, emit)
      else emit({ type: 'complete', fullText: 'agent-output', turnId: params.messageId })
    },
    subscribeChatEvents: (chatId, handler) => {
      handlers.set(chatId, handler)
      return () => handlers.delete(chatId)
    },
    runLlm: options?.runLlm,
  })
  return contexts
}

function workflow(id: string, steps: Parameters<typeof saveWorkflow>[0]['steps'], budgets?: Parameters<typeof saveWorkflow>[0]['budgets']) {
  return saveWorkflow({
    id,
    name: id,
    agentId: 'office-assistant',
    steps,
    budgets,
  })
}

async function finished(run: { done: Promise<WorkflowRun> }): Promise<WorkflowRun> {
  return run.done
}

describe('trusted-execution release evaluations', () => {
  test('1. normal queue turn records a complete exact trace lifecycle', async () => {
    const queue = new AgentQueue(fakeManager({
      'agent-a': async (params) => complete(params, 'ok'),
    }))
    expect(await queue.enqueue('agent-a', 'te-normal-chat', 'raw prompt is never stored', {
      turnId: 'te-normal-turn',
    })).toBe('ok')

    const row = getDatabase().query(
      "SELECT id FROM agentops_traces WHERE turn_id = 'te-normal-turn'",
    ).get() as { id: string }
    const trace = getAgentOpsTrace(row.id)!
    expect(trace.status).toBe('success')
    expect(trace.agentId).toBe('agent-a')
    expect(trace.chatId).toBe('te-normal-chat')
    expect(trace.turnId).toBe('te-normal-turn')
    expect(trace.coverage).toBe('exact')
    expect(JSON.stringify(
      getDatabase().query("SELECT * FROM agentops_traces WHERE turn_id = 'te-normal-turn'").get(),
    )).not.toContain('raw prompt is never stored')
  })

  test('2. model/cache/token/cost/tool usage is aggregated exactly', () => {
    startAgentOpsTrace({
      id: 'te-exact-usage',
      kind: 'trusted_eval',
      status: 'running',
      coverage: 'exact',
    })
    recordAgentOpsModelUsage({
      traceId: 'te-exact-usage',
      model: { provider: 'test-provider', id: 'test-model' },
      usage: EXACT_USAGE,
      pricingKnown: true,
      latencyMs: 42,
    })
    recordAgentOpsTool({
      traceId: 'te-exact-usage',
      toolName: 'mcp__memory__recall',
      effect: 'read',
    })
    finishAgentOpsTrace('te-exact-usage', 'success')

    const trace = getAgentOpsTrace('te-exact-usage')!
    expect(trace.usage).toEqual({
      modelCalls: 1,
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      totalTokens: 26,
      costUsd: 0.125,
      unknownCostCalls: 0,
      modelLatencyMs: 42,
      toolCalls: 1,
      executedSteps: 0,
      skippedSteps: 0,
      activeDurationMs: 0,
    })
    expect(trace.toolNames).toEqual(['mcp__memory__recall'])
    expect(trace.effectClasses).toEqual(['read'])
  })

  test('3. exact queued cancellation rejects only the selected sibling', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const queue = new AgentQueue(fakeManager({
      'agent-a': async (params) => {
        await firstGate
        return complete(params, 'first')
      },
    }))

    const first = queue.enqueue('agent-a', 'te-queued-chat', 'one', { turnId: 'te-queued-one' })
    const second = queue.enqueue('agent-a', 'te-queued-chat', 'two', { turnId: 'te-queued-two' })
      .catch((error) => error)
    expect(queue.cancel('te-queued-chat', 'te-queued-two')).toEqual({ queued: 1, running: 0 })
    const cancelled = await second
    expect(isQueueCancellationError(cancelled)).toBe(true)
    expect(cancelled.code).toBe(QUEUE_CANCELLATION_CODE)
    expect(cancelled.phase).toBe('queued')
    const trace = getDatabase().query(
      "SELECT status, stop_reason FROM agentops_traces WHERE turn_id = 'te-queued-two'",
    ).get() as { status: string; stop_reason: string }
    expect(trace).toEqual({ status: 'cancelled', stop_reason: 'queued' })

    releaseFirst()
    expect(await first).toBe('first')
  })

  test('4. exact running cancellation does not abort a running sibling turn', async () => {
    let releaseSibling!: () => void
    const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve })
    const queue = new AgentQueue(fakeManager({
      'agent-a': (params) => new Promise<string>((resolve) => {
        params.abortController!.signal.addEventListener('abort', () => {
          if (params.executionState) params.executionState.status = 'cancelled'
          resolve('')
        }, { once: true })
      }),
      'agent-b': async (params) => {
        await siblingGate
        return complete(params, 'sibling-ok')
      },
    }))

    const cancelledTurn = queue.enqueue('agent-a', 'te-running-chat', 'one', { turnId: 'te-running-one' })
      .catch((error) => error)
    const siblingTurn = queue.enqueue('agent-b', 'te-running-chat', 'two', { turnId: 'te-running-two' })
    expect(queue.cancel('te-running-chat', 'te-running-one')).toEqual({ queued: 0, running: 1 })
    const cancellation = await cancelledTurn
    expect(isQueueCancellationError(cancellation)).toBe(true)

    releaseSibling()
    expect(await siblingTurn).toBe('sibling-ok')

    // Cancellation can win while runtime setup is awaiting, before it has
    // registered any session abort listener. The queue-owned signal must still
    // prevent the provider operation from starting.
    let providerStarted = false
    const registrationRaceQueue = new AgentQueue(fakeManager({
      'agent-c': async (params) => {
        await Promise.resolve()
        if (params.abortController!.signal.aborted) {
          if (params.executionState) params.executionState.status = 'cancelled'
          return ''
        }
        providerStarted = true
        return complete(params, 'should-not-run')
      },
    }))
    const raced = registrationRaceQueue
      .enqueue('agent-c', 'te-registration-race', 'cancel during setup', {
        turnId: 'te-registration-race-turn',
      })
      .catch((error) => error)
    expect(registrationRaceQueue.cancel(
      'te-registration-race',
      'te-registration-race-turn',
    )).toEqual({ queued: 0, running: 1 })
    expect(isQueueCancellationError(await raced)).toBe(true)
    expect(providerStarted).toBe(false)
  })

  test('5. mixed agent/llm/tool workflow uses one trace with typed spans', async () => {
    const contexts = installWorkflowRuntime({
      runLlm: async (_agentId, _prompt, context) => {
        recordAgentOpsModelUsage({
          traceId: context!.traceId,
          spanId: context!.spanId,
          model: { provider: 'test', id: 'priced' },
          usage: EXACT_USAGE,
          pricingKnown: true,
          latencyMs: 4,
        })
        recordWorkflowModelUsage(context!.workflowRunId, EXACT_USAGE, true, 4)
        return 'llm-output'
      },
    })
    workflow('te-mixed', [
      { id: 'agent', title: 'agent', kind: 'agent', prompt: 'agent' },
      { id: 'llm', title: 'llm', kind: 'llm', prompt: 'llm' },
      { id: 'tool', title: 'tool', kind: 'tool', prompt: '', tool: 'fulfillment_list_stock' },
    ])

    const run = await finished(startWorkflowRun('te-mixed', {}))
    const detail = getAgentOpsTraceDetail(run.traceId!)!
    expect(run.status).toBe('success')
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.traceId).toBe(run.traceId)
    expect(contexts[0]!.internal).toBe(true)
    expect(detail.spans.map((span) => span.kind).sort()).toEqual([
      'workflow_agent',
      'workflow_llm',
      'workflow_tool',
    ])
    expect(detail.trace.usage.executedSteps).toBe(3)
    expect(detail.trace.usage.modelCalls).toBe(1)
    expect(detail.trace.usage.toolCalls).toBe(1)
  })

  test('6. when skips cost zero while each forEach item counts once', async () => {
    let calls = 0
    installWorkflowRuntime({
      dispatch: (params, emit) => {
        calls += 1
        emit({
          type: 'complete',
          fullText: calls === 1 ? '["a","b"]' : `item-${calls - 1}`,
          turnId: params.messageId,
        })
      },
    })
    saveWorkflow({
      id: 'te-foreach',
      name: 'te-foreach',
      agentId: 'office-assistant',
      inputs: [{ key: 'gate', label: 'gate' }],
      steps: [
        { id: 'list', title: 'list', prompt: 'list' },
        {
          id: 'skip',
          title: 'skip',
          prompt: 'skip',
          when: { var: 'inputs.gate', op: 'not_empty' },
        },
        {
          id: 'each',
          title: 'each',
          prompt: '{{item}}',
          forEach: { var: 'steps.list.output', maxItems: 5 },
        },
      ],
    })

    const run = await finished(startWorkflowRun('te-foreach', { gate: '' }))
    expect(run.status).toBe('success')
    expect(run.usage.executedSteps).toBe(3)
    expect(run.usage.skippedSteps).toBe(1)
    expect(run.usage.modelCalls).toBe(0)
    expect(run.usage.toolCalls).toBe(0)
    expect(getAgentOpsTrace(run.traceId!)!.usage.executedSteps).toBe(3)
  })

  test('7. resume preserves trace identity and cumulative attempted usage', async () => {
    let calls = 0
    installWorkflowRuntime({
      dispatch: (params, emit) => {
        calls += 1
        if (calls === 2) {
          emit({ type: 'error', error: 'deterministic failure', turnId: params.messageId })
        } else {
          emit({ type: 'complete', fullText: `out-${calls}`, turnId: params.messageId })
        }
      },
    })
    workflow('te-resume', [
      { id: 'one', title: 'one', prompt: 'one' },
      { id: 'two', title: 'two', prompt: 'two' },
    ], { maxSteps: 3 })

    const failed = await finished(startWorkflowRun('te-resume', {}))
    expect(failed.status).toBe('failed')
    expect(failed.usage.executedSteps).toBe(2)
    expect(failed.budgets).toEqual({ maxSteps: 3 })
    const traceId = failed.traceId

    const resumed = await finished(resumeWorkflowRun(failed.id))
    expect(resumed.status).toBe('success')
    expect(resumed.traceId).toBe(traceId)
    expect(resumed.budgets).toEqual({ maxSteps: 3 })
    expect(resumed.usage.executedSteps).toBe(3)
    expect(getAgentOpsTrace(traceId!)!.usage.executedSteps).toBe(3)
  })

  test('8. step and provider usage budgets stop deterministically', async () => {
    installWorkflowRuntime()
    workflow('te-budget-steps', [
      { id: 'one', title: 'one', kind: 'tool', prompt: '', tool: 'fulfillment_list_stock' },
      { id: 'two', title: 'two', kind: 'tool', prompt: '', tool: 'fulfillment_list_stock' },
    ], { maxSteps: 1 })
    const stepStopped = await finished(startWorkflowRun('te-budget-steps', {}))
    expect(stepStopped.status).toBe('failed')
    expect(stepStopped.errorCode).toBe('WORKFLOW_BUDGET_EXCEEDED')
    expect(stepStopped.stopReason).toBe('max_steps')
    expect(stepStopped.usage.executedSteps).toBe(1)

    installWorkflowRuntime({
      runLlm: async (_agentId, _prompt, context) => {
        recordAgentOpsModelUsage({
          traceId: context!.traceId,
          spanId: context!.spanId,
          model: { provider: 'test', id: 'priced' },
          usage: EXACT_USAGE,
          pricingKnown: true,
          latencyMs: 1,
        })
        recordWorkflowModelUsage(context!.workflowRunId, EXACT_USAGE, true, 1)
        return 'unreachable'
      },
    })
    workflow('te-budget-token', [
      { id: 'llm', title: 'llm', kind: 'llm', prompt: 'llm' },
    ], { maxTotalTokens: 10 })
    const tokenStopped = await finished(startWorkflowRun('te-budget-token', {}))
    expect(tokenStopped.status).toBe('failed')
    expect(tokenStopped.stopReason).toBe('max_total_tokens')
    expect(tokenStopped.usage.totalTokens).toBe(26)
  })

  test('9. denied tool effects are recorded but blocked before execution', async () => {
    installWorkflowRuntime()
    workflow('te-denied-effect', [
      {
        id: 'network',
        title: 'network',
        kind: 'tool',
        prompt: '',
        tool: 'http_get',
        args: { url: 'https://example.invalid/never-called' },
      },
    ], { deniedToolEffects: ['network'] })

    const run = await finished(startWorkflowRun('te-denied-effect', {}))
    const trace = getAgentOpsTrace(run.traceId!)!
    expect(run.status).toBe('failed')
    expect(run.stopReason).toBe('denied_effect:network')
    expect(run.usage.toolCalls).toBe(0)
    expect(trace.usage.toolCalls).toBe(0)
    expect(trace.effectClasses).toContain('network')
    expect(trace.toolNames).toContain('http_get')
  })

  test('10. crash reconciliation and exports are stable and redact paths/URLs/secrets', () => {
    workflow('te-crash-workflow', [
      { id: 'tool', title: 'tool', kind: 'tool', prompt: '', tool: 'fulfillment_list_stock' },
    ])
    const orphanedRun = createRun(
      'te-crash-workflow',
      {},
      'workflow:te-crash-workflow:orphan',
      { traceId: 'te-crash' },
    )
    startAgentOpsTrace({
      id: 'te-crash',
      kind: 'trusted_eval',
      status: 'running',
      chatId: 'te-crash-chat',
      workflowId: 'te-crash-workflow',
      workflowRunId: orphanedRun.id,
      coverage: 'exact',
    })
    const db = getDatabase()
    db.run(
      `UPDATE agentops_traces
       SET chat_id = ?, tool_names_json = ?, model_id = ?
       WHERE id = 'te-crash'`,
      [
        'https://secret.example/private?token=raw',
        JSON.stringify(['C:\\private\\secret.txt']),
        'sk-super-secret-value',
      ],
    )

    startAgentOpsTrace({
      id: 'te-safe-storage',
      kind: 'trusted_eval',
      status: 'running',
      coverage: 'exact',
    })
    recordAgentOpsModelUsage({
      traceId: 'te-safe-storage',
      model: {
        provider: 'https://provider.example/private',
        id: 'sk-super-secret-model-id',
      },
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { total: 0 },
      },
      pricingKnown: true,
    })
    finishAgentOpsTrace('te-safe-storage', 'success')
    const storedModel = db.query(
      "SELECT model_provider, model_id FROM agentops_traces WHERE id = 'te-safe-storage'",
    ).get() as { model_provider: string; model_id: string }
    expect(JSON.stringify(storedModel)).not.toContain('provider.example')
    expect(JSON.stringify(storedModel)).not.toContain('sk-super-secret-model-id')

    expect(reconcileInterruptedAgentOpsTraces()).toBeGreaterThanOrEqual(1)
    expect(reconcileInterruptedRuns()).toBeGreaterThanOrEqual(1)
    expect(getAgentOpsTrace('te-crash')?.status).toBe('interrupted')
    expect(getRun(orphanedRun.id)).toMatchObject({
      status: 'failed',
      errorCode: 'PROCESS_RESTART',
      stopReason: 'process_restart',
    })
    const runColumns = db.query("PRAGMA table_info('workflow_runs')").all() as Array<{ name: string }>
    expect(runColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'budgets_json',
      'usage_json',
      'trace_id',
      'error_code',
      'stop_reason',
      'active_duration_ms',
      'active_started_at',
    ]))
    const first = exportAgentOpsTraces({ kind: 'trusted_eval', limit: 50 }, 'jsonl')
    const second = exportAgentOpsTraces({ kind: 'trusted_eval', limit: 50 }, 'jsonl')
    expect(first).toBe(second)
    expect(first).not.toContain('secret.example')
    expect(first).not.toContain('private\\secret.txt')
    expect(first).not.toContain('sk-super-secret-value')
    expect(first).toContain('[REDACTED_URL]')
    expect(first).toContain('[REDACTED_PATH]')
    expect(first).toContain('[REDACTED_SECRET]')
  })
})
