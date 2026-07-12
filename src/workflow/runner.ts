// [XJC] 工作流引擎·执行层
//
// 逐步执行：每步 = 一次完整 agent 回合（router.handleInbound 投递 + EventBus complete/error
// promise 桥，与 MCP ask_employee 同款链路），上一步产出截断后注入下一步上下文。
// 全程跑在专用 `workflow:` 会话里（无渠道认领不外发；客户端聊天列表可见可审计）。
// 守卫：同一工作流同时只跑一个实例；每步超时；失败即停并落 run 记录。

import { randomUUID } from 'node:crypto'
import { upsertChat } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'
import { abortRegistry } from '../agent/abort-registry.ts'
import { getWorkflowNodeTool } from './nodes.ts'
import {
  classifyToolEffect,
  finishAgentOpsSpan,
  finishAgentOpsTrace,
  getAgentOpsTrace,
  markAgentOpsTraceRunning,
  recordAgentOpsActiveDuration,
  recordAgentOpsStep,
  recordAgentOpsTool,
  startAgentOpsSpan,
  startAgentOpsTrace,
} from '../agentops/index.ts'
import {
  authorizeWorkflowStep,
  authorizeWorkflowTool,
  enforceWorkflowActiveDuration,
  isWorkflowBudgetError,
  recordWorkflowSkippedStep,
  WORKFLOW_BUDGET_EXCEEDED,
} from './budget.ts'
import {
  createRun,
  finishRun,
  getRun,
  getRunForEachCheckpoint,
  getWorkflow,
  hasRunningRun,
  pauseRunForApproval,
  reopenApprovedRun,
  reopenRun,
  rejectRun,
  setRunTraceId,
  updateRunProgress,
  WorkflowError,
  WORKFLOW_INVALID,
  WORKFLOW_NOT_FOUND,
  FOREACH_DEFAULT_CAP,
  FOREACH_HARD_CAP,
  type Workflow,
  type WorkflowBudgets,
  type WorkflowForEachCheckpoint,
  type WorkflowRun,
  type WorkflowStep,
} from './store.ts'

/** 条件跳过占位（写进 outputs 保持步序对齐；重建变量表时排除） */
export const SKIP_MARKER = '（条件不满足，已跳过）'

export interface WorkflowRuntimeDeps {
  hasEmployee: (agentId: string) => boolean
  dispatchMessage: (params: {
    agentId: string
    chatId: string
    messageId: string
    content: string
    agentOps?: {
      traceId: string
      spanId: string
      workflowId: string
      workflowRunId: string
      internal: true
    }
  }) => void
  subscribeChatEvents: (
    chatId: string,
    handler: (event:
      | { type: 'complete'; fullText: string; turnId: string; cancelled?: boolean }
      | { type: 'error'; error: string; turnId: string; errorCode?: string; stopReason?: string }
    ) => void,
  ) => () => void
  /** llm 节点：按工作流员工解析模型后单次直调（无工具循环） */
  runLlm?: (
    agentId: string,
    prompt: string,
    context?: {
      traceId: string
      spanId: string
      workflowId: string
      workflowRunId: string
      signal?: AbortSignal
    },
  ) => Promise<string>
  /** Queue-level exact cancellation; legacy embedders may omit it. */
  cancelTurn?: (chatId: string, turnId: string) => { queued: number; running: number } | void
  /** Test/embedding override; production defaults to 300 seconds. */
  stepTimeoutMs?: number
}

const STEP_TIMEOUT_MS = 300_000
const PREV_OUTPUT_MAX = 8000
const runningWorkflows = new Set<string>()

function createStepTimeoutError(timeoutMs: number): Error & { code: string; stopReason: string } {
  const error = new Error(`步骤超时（${timeoutMs / 1000}s）`) as Error & {
    code: string
    stopReason: string
  }
  error.code = 'WORKFLOW_STEP_TIMEOUT'
  error.stopReason = 'step_timeout'
  return error
}

async function runWithStepTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(createStepTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

let deps: WorkflowRuntimeDeps | null = null

export function configureWorkflowRuntime(d: WorkflowRuntimeDeps): void {
  deps = d
}

/** 测试用：重置依赖与在途标记 */
export function resetWorkflowRuntimeForTest(d?: WorkflowRuntimeDeps): void {
  deps = d ?? null
  runningWorkflows.clear()
}

export function isWorkflowRunning(workflowId: string): boolean {
  return runningWorkflows.has(workflowId.trim().toLowerCase())
}

/**
 * 变量渲染（对标扣子 {{变量}} 引用）：
 * - {{inputs.key}} / {{key}}（简写，向后兼容）→ 运行输入
 * - {{steps.<stepId>.output}} / {{steps.<stepId>}} → 任意已完成步骤的产出（不限于上一步）
 * 未知/缺失 → "（未提供 x）"，显式可见绝不静默空串。
 */
export function renderTemplate(template: string, vars: { inputs: Record<string, string>; steps: Record<string, string> }): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/gi, (_m, ref: string) => {
    const key = ref.toLowerCase()
    if (key.startsWith('steps.')) {
      const stepId = key.slice('steps.'.length).replace(/\.output$/, '')
      const v = vars.steps[stepId]
      return v !== undefined && v !== '' ? v : `（未提供 steps.${stepId}）`
    }
    const inputKey = key.startsWith('inputs.') ? key.slice('inputs.'.length) : key
    const v = vars.inputs[inputKey]
    return v !== undefined && v !== '' ? v : `（未提供 ${inputKey}）`
  })
}

function resolveVarRef(ref: string, vars: { inputs: Record<string, string>; steps: Record<string, string> }): string {
  const key = ref.trim().toLowerCase()
  if (key.startsWith('steps.')) return vars.steps[key.slice('steps.'.length).replace(/\.output$/, '')] ?? ''
  if (key.startsWith('inputs.')) return vars.inputs[key.slice('inputs.'.length)] ?? ''
  return vars.inputs[key] ?? vars.steps[key] ?? ''
}

/** when 条件求值（确定性字符串判断，不烧模型） */
export function evaluateWhen(
  when: NonNullable<import('./store.ts').WorkflowStep['when']>,
  vars: { inputs: Record<string, string>; steps: Record<string, string> },
): boolean {
  const value = resolveVarRef(when.var, vars)
  switch (when.op) {
    case 'contains': return value.includes(when.value ?? '')
    case 'not_contains': return !value.includes(when.value ?? '')
    case 'is_empty': return value.trim() === ''
    case 'not_empty': return value.trim() !== ''
    default: return true
  }
}

function runStep(
  chatId: string,
  agentId: string,
  content: string,
  context: { traceId: string; spanId: string; workflowId: string; workflowRunId: string },
): Promise<string> {
  const d = deps
  if (!d) throw new WorkflowError(WORKFLOW_INVALID, '工作流运行时未装配')
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const turnId = randomUUID()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = () => {}
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      try { unsubscribe() } catch { /* best-effort event cleanup */ }
    }
    const registeredUnsubscribe = d.subscribeChatEvents(chatId, (event) => {
      if (event.turnId !== turnId) return
      if (settled) return
      settled = true
      cleanup()
      if (event.type === 'complete' && !event.cancelled) {
        resolvePromise(event.fullText)
      } else {
        const error = new Error(event.type === 'error' ? event.error : 'Workflow agent turn cancelled') as Error & {
          code?: string
          stopReason?: string
        }
        error.code = event.type === 'error' ? event.errorCode : 'TURN_CANCELLED'
        error.stopReason = event.type === 'error' ? event.stopReason : 'cancelled'
        rejectPromise(error)
      }
    })
    unsubscribe = registeredUnsubscribe
    if (settled) {
      cleanup()
      return
    }
    const timeoutMs = d.stepTimeoutMs ?? STEP_TIMEOUT_MS
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      try { d.cancelTurn?.(chatId, turnId) } catch { /* legacy embedder fallback below */ }
      try { abortRegistry.abort(chatId, turnId) } catch { /* cancellation is best-effort */ }
      const error = new Error(`步骤超时（${timeoutMs / 1000}s）`) as Error & {
        code?: string
        stopReason?: string
      }
      error.code = 'WORKFLOW_STEP_TIMEOUT'
      error.stopReason = 'step_timeout'
      rejectPromise(error)
    }, timeoutMs)
    try {
      d.dispatchMessage({
        agentId,
        chatId,
        messageId: turnId,
        content,
        agentOps: { ...context, internal: true },
      })
    } catch (err) {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(err)
    }
  })
}

/** 解析 forEach 列表：优先 JSON 字符串数组，其次按行切分；条数硬上限 */
export function parseForEachList(raw: string, maxItems: number): string[] {
  const cap = Math.min(Math.max(1, maxItems), FOREACH_HARD_CAP)
  const text = raw.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return parsed.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).filter((v) => v.trim() !== '').slice(0, cap)
    }
  } catch {
    // 不是 JSON → 按行切分
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').slice(0, cap)
}

interface RenderVars {
  inputs: Record<string, string>
  steps: Record<string, string>
}

/** 执行一步的单次动作（forEach 的每一项也走这里）；vars.inputs 可能带 item/item_index 注入 */
async function executeStepOnce(
  d: WorkflowRuntimeDeps,
  wf: Workflow,
  runId: string,
  traceId: string,
  step: WorkflowStep,
  index: number,
  vars: RenderVars,
  chatId: string,
  lastRealOutput: string,
  itemIndex?: number,
): Promise<string> {
  const kind = step.kind ?? 'agent'
  const span = startAgentOpsSpan({
    traceId,
    kind: `workflow_${kind}`,
    name: step.id ?? `step${index + 1}`,
    agentId: wf.agentId,
    workflowStepId: step.id ?? `step${index + 1}`,
    workflowStepIndex: index,
    workflowItemIndex: itemIndex,
    coverage: 'exact',
  })
  try {
    authorizeWorkflowStep(runId)
    recordAgentOpsStep({ traceId, spanId: span.id })

    if (kind === 'tool') {
      const tool = getWorkflowNodeTool(step.tool ?? '')
      if (!tool) throw new Error(`第 ${index + 1} 步引用了未注册的工具「${step.tool}」`)
      const effect = tool.effect ?? classifyToolEffect(tool.name)
      try {
        authorizeWorkflowTool(runId, effect)
      } catch (err) {
        if (isWorkflowBudgetError(err)) {
          recordAgentOpsTool({
            traceId,
            spanId: span.id,
            toolName: tool.name,
            effect,
            executed: false,
          })
        }
        throw err
      }
      recordAgentOpsTool({ traceId, spanId: span.id, toolName: tool.name, effect })
      const args = Object.fromEntries(
        Object.entries(step.args ?? {}).map(([k, v]) => [k, renderTemplate(v, vars)]),
      )
      const output = await runWithStepTimeout(
        d.stepTimeoutMs ?? STEP_TIMEOUT_MS,
        (signal) => tool.execute(args, {
          agentId: wf.agentId,
          workflowId: wf.id,
          workflowRunId: runId,
          traceId,
          stepId: step.id ?? `step${index + 1}`,
          stepIndex: index,
          itemIndex,
          signal,
        }),
      )
      enforceWorkflowActiveDuration(runId)
      finishAgentOpsSpan(span.id, 'success')
      return output
    }

    // agent/llm 节点：模板未显式引用 steps.* 时自动注入上一步产出（向后兼容线性写法）
    const rendered = renderTemplate(step.prompt, vars)
    const referencesSteps = /\{\{\s*steps\./i.test(step.prompt)
    const prevBlock = !referencesSteps && lastRealOutput
      ? `上一步产出（据此继续，不要重做上一步）：\n${lastRealOutput.slice(0, PREV_OUTPUT_MAX)}`
      : ''
    if (kind === 'llm') {
      const runLlm = d.runLlm
      if (!runLlm) throw new Error('llm 节点不可用：工作流运行时未装配模型直调')
      const output = await runWithStepTimeout(
        d.stepTimeoutMs ?? STEP_TIMEOUT_MS,
        (signal) => runLlm(
          wf.agentId,
          [prevBlock, rendered].filter(Boolean).join('\n\n'),
          { traceId, spanId: span.id, workflowId: wf.id, workflowRunId: runId, signal },
        ),
      )
      enforceWorkflowActiveDuration(runId)
      finishAgentOpsSpan(span.id, 'success')
      return output
    }
    const workflowPrompt = [
      `<workflow_step>`,
      `工作流：${wf.name}（第 ${index + 1}/${wf.steps.length} 步：${step.title}）`,
      prevBlock,
      `本步只完成当前任务并输出成果本体，不要输出与后续步骤相关的内容。`,
      `</workflow_step>`,
    ].filter(Boolean).join('\n')
    const output = await runStep(
      chatId,
      wf.agentId,
      `${workflowPrompt}\n\n${rendered}`,
      { traceId, spanId: span.id, workflowId: wf.id, workflowRunId: runId },
    )
    enforceWorkflowActiveDuration(runId)
    finishAgentOpsSpan(span.id, 'success')
    return output
  } catch (err) {
    const typed = err as Error & { code?: string; stopReason?: string }
    finishAgentOpsSpan(span.id, typed.code === 'TURN_CANCELLED' ? 'cancelled' : 'failed', {
      errorCode: typed.code ?? 'WORKFLOW_STEP_FAILED',
      stopReason: typed.stopReason ?? (isWorkflowBudgetError(err) ? err.stopReason : 'step_error'),
    })
    throw err
  }
}

function restoreForEachOutputs(
  checkpoint: WorkflowForEachCheckpoint | null,
  step: WorkflowStep,
  stepIndex: number,
  items: string[],
): string[] {
  if (!checkpoint) return []
  const stepId = step.id ?? `step${stepIndex + 1}`
  const sameItems = checkpoint.items.length === items.length
    && checkpoint.items.every((item, index) => item === items[index])
  if (checkpoint.stepIndex !== stepIndex || checkpoint.stepId !== stepId || !sameItems) {
    throw new WorkflowError(WORKFLOW_INVALID, 'forEach 检查点与当前步骤不匹配，无法安全续跑')
  }
  return [...checkpoint.outputs]
}

function formatForEachOutput(items: string[], itemOutputs: string[]): string {
  return itemOutputs
    .map((part, itemIndex) => `【第 ${itemIndex + 1}/${items.length} 项】${items[itemIndex]!.slice(0, 80)}\n${part}`)
    .join('\n\n')
}

function syncWorkflowTraceActiveDuration(traceId: string, cumulativeMs: number): void {
  const trace = getAgentOpsTrace(traceId)
  if (!trace) return
  const delta = Math.max(0, cumulativeMs - trace.usage.activeDurationMs)
  if (delta > 0) recordAgentOpsActiveDuration(traceId, delta)
}

/** 从 startIndex 起执行到结束（start 与 resume 共用），并落 run 终态 */
async function executeRunLoop(
  d: WorkflowRuntimeDeps,
  wf: Workflow,
  runId: string,
  traceId: string,
  chatId: string,
  vars: RenderVars,
  outputs: string[],
  startIndex: number,
  startCheckpoint: WorkflowForEachCheckpoint | null,
): Promise<WorkflowRun> {
  let lastRealOutput = [...outputs].reverse().find((o) => o !== SKIP_MARKER) ?? ''
  let activeCheckpoint = startCheckpoint
  try {
    for (let index = startIndex; index < wf.steps.length; index++) {
      const step = wf.steps[index]!
      if (activeCheckpoint && activeCheckpoint.stepIndex !== index) {
        throw new WorkflowError(WORKFLOW_INVALID, 'forEach 检查点与当前进度不匹配，无法安全续跑')
      }
      updateRunProgress(runId, index, outputs, activeCheckpoint)

      // when 条件不满足 → 跳过（占位保持 outputs 与步骤对齐，变量表不记）
      if (step.when && !evaluateWhen(step.when, vars)) {
        recordWorkflowSkippedStep(runId)
        const skippedSpan = startAgentOpsSpan({
          traceId,
          kind: 'workflow_skipped',
          name: step.id ?? `step${index + 1}`,
          agentId: wf.agentId,
          workflowStepId: step.id ?? `step${index + 1}`,
          workflowStepIndex: index,
          coverage: 'exact',
        })
        recordAgentOpsStep({ traceId, spanId: skippedSpan.id, skipped: true })
        finishAgentOpsSpan(skippedSpan.id, 'success', { stopReason: 'when_false' })
        outputs.push(SKIP_MARKER)
        activeCheckpoint = null
        updateRunProgress(runId, index + 1, outputs, null)
        continue
      }

      // [XJC] 人工审批闸口：跑到 approval 步就暂停等用户批准（不 push output，outputs 与 index 对齐）。
      // finally 会释放运行锁；批准走 approveWorkflowRun 从下一步续跑，拒绝走 rejectWorkflowRun 置 failed。
      if (step.kind === 'approval') {
        if (activeCheckpoint) throw new WorkflowError(WORKFLOW_INVALID, 'approval 步不支持 forEach 检查点')
        pauseRunForApproval(runId, index)
        syncWorkflowTraceActiveDuration(traceId, getRun(runId)!.usage.activeDurationMs)
        getLogger().info({ workflowId: wf.id, runId, stepIndex: index, category: 'workflow' }, 'Workflow run paused for human approval')
        return getRun(runId)!
      }

      let output: string
      if (step.forEach) {
        const list = parseForEachList(resolveVarRef(step.forEach.var, vars), step.forEach.maxItems ?? FOREACH_DEFAULT_CAP)
        const itemOutputs = restoreForEachOutputs(activeCheckpoint, step, index, list)
        if (list.length === 0) {
          recordWorkflowSkippedStep(runId)
          const emptySpan = startAgentOpsSpan({
            traceId,
            kind: 'workflow_skipped',
            name: step.id ?? `step${index + 1}`,
            agentId: wf.agentId,
            workflowStepId: step.id ?? `step${index + 1}`,
            workflowStepIndex: index,
            coverage: 'exact',
          })
          recordAgentOpsStep({ traceId, spanId: emptySpan.id, skipped: true })
          finishAgentOpsSpan(emptySpan.id, 'success', { stopReason: 'foreach_empty' })
          output = '（forEach 列表为空，本步无事可做）'
        } else {
          for (let itemIndex = itemOutputs.length; itemIndex < list.length; itemIndex++) {
            const item = list[itemIndex]!
            const iterVars: RenderVars = {
              inputs: { ...vars.inputs, item, item_index: String(itemIndex + 1) },
              steps: vars.steps,
            }
            const part = await executeStepOnce(
              d,
              wf,
              runId,
              traceId,
              step,
              index,
              iterVars,
              chatId,
              lastRealOutput,
              itemIndex,
            )
            itemOutputs.push(part)
            activeCheckpoint = {
              stepIndex: index,
              stepId: step.id ?? `step${index + 1}`,
              items: [...list],
              outputs: [...itemOutputs],
            }
            // 每项成功即持久化；若下一项失败/进程退出，续跑从 itemOutputs.length 开始。
            updateRunProgress(runId, index, outputs, activeCheckpoint)
          }
          output = formatForEachOutput(list, itemOutputs)
        }
      } else {
        if (activeCheckpoint) {
          throw new WorkflowError(WORKFLOW_INVALID, '非 forEach 步骤存在逐项检查点，无法安全续跑')
        }
        output = await executeStepOnce(d, wf, runId, traceId, step, index, vars, chatId, lastRealOutput)
      }

      outputs.push(output)
      vars.steps[step.id ?? `step${index + 1}`] = output
      lastRealOutput = output
      activeCheckpoint = null
      // 完整步骤产出与检查点清理同一条 SQL 落库，避免崩溃窗口导致重复项。
      updateRunProgress(runId, index + 1, outputs, null)
    }
    finishRun(runId, 'success')
    const completed = getRun(runId)!
    syncWorkflowTraceActiveDuration(traceId, completed.usage.activeDurationMs)
    finishAgentOpsTrace(traceId, 'success')
    getLogger().info({ workflowId: wf.id, runId, steps: wf.steps.length, category: 'workflow' }, 'Workflow run finished')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const typed = err as Error & { code?: string; stopReason?: string }
    const errorCode = typed.code ?? (isWorkflowBudgetError(err) ? WORKFLOW_BUDGET_EXCEEDED : 'WORKFLOW_RUN_FAILED')
    const stopReason = typed.stopReason ?? (isWorkflowBudgetError(err) ? err.stopReason : 'execution_error')
    finishRun(runId, 'failed', message, { errorCode, stopReason })
    const failed = getRun(runId)!
    syncWorkflowTraceActiveDuration(traceId, failed.usage.activeDurationMs)
    finishAgentOpsTrace(traceId, typed.code === 'TURN_CANCELLED' ? 'cancelled' : 'failed', {
      errorCode,
      stopReason,
    })
    getLogger().warn({ workflowId: wf.id, runId, error: message, category: 'workflow' }, 'Workflow run failed')
  } finally {
    runningWorkflows.delete(wf.id)
  }
  return getRun(runId)!
}

/**
 * 启动一次工作流运行（异步跑完）。返回创建好的 run（status=running）；
 * 调用方可轮询 getRun(run.id) 或 await 返回的 done promise。
 */
export function startWorkflowRun(
  workflowId: string,
  inputs: Record<string, string>,
  options?: { budgets?: WorkflowBudgets | null },
): { run: WorkflowRun; done: Promise<WorkflowRun> } {
  const d = deps
  if (!d) throw new WorkflowError(WORKFLOW_INVALID, '工作流运行时未装配')
  const wf = getWorkflow(workflowId)
  if (!wf) throw new WorkflowError(WORKFLOW_NOT_FOUND, `工作流「${workflowId}」不存在`)
  if (!d.hasEmployee(wf.agentId)) throw new WorkflowError(WORKFLOW_INVALID, `执行员工「${wf.agentId}」不存在`)
  if (runningWorkflows.has(wf.id) || hasRunningRun(wf.id)) {
    throw new WorkflowError(WORKFLOW_INVALID, `工作流「${wf.name}」正在运行中，等它跑完再启动`)
  }

  const cleanInputs: Record<string, string> = {}
  for (const field of wf.inputs) {
    const v = inputs[field.key]
    cleanInputs[field.key] = typeof v === 'string' ? v.trim().slice(0, 4000) : ''
  }

  const chatId = `workflow:${wf.id}:${Date.now().toString(36)}`
  upsertChat(chatId, wf.agentId, `工作流·${wf.name}`, 'web')
  const traceId = randomUUID()
  const run = createRun(wf.id, cleanInputs, chatId, { budgets: options?.budgets, traceId })
  startAgentOpsTrace({
    id: traceId,
    kind: 'workflow',
    status: 'running',
    agentId: wf.agentId,
    chatId,
    workflowId: wf.id,
    workflowRunId: run.id,
    coverage: 'exact',
  })
  runningWorkflows.add(wf.id)

  const done = executeRunLoop(d, wf, run.id, traceId, chatId, { inputs: cleanInputs, steps: {} }, [], 0, null)
  return { run, done }
}

/**
 * 断点续跑：从失败的那一步继续（已完成步骤的产出直接复用，不重跑不重扣 token）。
 * 守卫：只有 failed 可续；工作流定义在本次运行开始后被改过则拒绝（步序/变量可能已对不上）。
 */
export function resumeWorkflowRun(runId: string): { run: WorkflowRun; done: Promise<WorkflowRun> } {
  const d = deps
  if (!d) throw new WorkflowError(WORKFLOW_INVALID, '工作流运行时未装配')
  const run = getRun(runId)
  if (!run) throw new WorkflowError(WORKFLOW_NOT_FOUND, `运行「${runId}」不存在`)
  if (run.status !== 'failed') throw new WorkflowError(WORKFLOW_INVALID, `只有失败的运行可以续跑（当前状态：${run.status}）`)
  const wf = getWorkflow(run.workflowId)
  if (!wf) throw new WorkflowError(WORKFLOW_NOT_FOUND, `工作流「${run.workflowId}」已被删除，无法续跑`)
  if (!d.hasEmployee(wf.agentId)) throw new WorkflowError(WORKFLOW_INVALID, `执行员工「${wf.agentId}」不存在`)
  if (runningWorkflows.has(wf.id) || hasRunningRun(wf.id)) {
    throw new WorkflowError(WORKFLOW_INVALID, `工作流「${wf.name}」正在运行中`)
  }
  if (wf.updatedAt > run.startedAt) {
    throw new WorkflowError(WORKFLOW_INVALID, '工作流定义在该次运行之后被修改过，步骤可能已对不上；请直接重新运行')
  }

  // 重建变量表：已完成步骤（含跳过占位对齐）→ vars.steps
  const startIndex = Math.min(run.currentStep, run.outputs.length)
  const outputs = run.outputs.slice(0, startIndex)
  const vars: RenderVars = { inputs: { ...run.inputs }, steps: {} }
  for (let i = 0; i < startIndex; i++) {
    if (outputs[i] !== SKIP_MARKER) {
      vars.steps[wf.steps[i]?.id ?? `step${i + 1}`] = outputs[i]!
    }
  }
  const forEachCheckpoint = getRunForEachCheckpoint(run.id)
  const traceId = run.traceId ?? randomUUID()
  if (!run.traceId) {
    setRunTraceId(run.id, traceId)
    startAgentOpsTrace({
      id: traceId,
      kind: 'workflow',
      status: 'running',
      agentId: wf.agentId,
      chatId: run.chatId,
      workflowId: wf.id,
      workflowRunId: run.id,
      coverage: 'partial',
      coverageNotes: ['legacy_run_before_tracing'],
      startedAt: run.startedAt,
    })
  } else {
    markAgentOpsTraceRunning(traceId)
  }

  reopenRun(run.id)
  runningWorkflows.add(wf.id)
  getLogger().info({ workflowId: wf.id, runId: run.id, resumeFrom: startIndex, category: 'workflow' }, 'Workflow run resumed')

  const done = executeRunLoop(d, wf, run.id, traceId, run.chatId, vars, outputs, startIndex, forEachCheckpoint)
  return { run: getRun(run.id)!, done }
}

/**
 * [XJC] 人工批准审批节点：awaiting_approval → 从 approval 的下一步续跑。
 * approval 步记为「已批准」产出（供后续步骤引用），已完成步骤产出复用不重跑。
 */
export function approveWorkflowRun(runId: string): { run: WorkflowRun; done: Promise<WorkflowRun> } {
  const d = deps
  if (!d) throw new WorkflowError(WORKFLOW_INVALID, '工作流运行时未装配')
  const run = getRun(runId)
  if (!run) throw new WorkflowError(WORKFLOW_NOT_FOUND, `运行「${runId}」不存在`)
  if (run.status !== 'awaiting_approval') {
    throw new WorkflowError(WORKFLOW_INVALID, `只有待审批的运行可以批准（当前状态：${run.status}）`)
  }
  const wf = getWorkflow(run.workflowId)
  if (!wf) throw new WorkflowError(WORKFLOW_NOT_FOUND, `工作流「${run.workflowId}」已被删除`)
  if (!d.hasEmployee(wf.agentId)) throw new WorkflowError(WORKFLOW_INVALID, `执行员工「${wf.agentId}」不存在`)
  if (wf.updatedAt > run.startedAt) {
    throw new WorkflowError(WORKFLOW_INVALID, '工作流定义在该次运行之后被修改过，步骤可能已对不上；请重新运行')
  }

  const approvalIndex = run.currentStep
  const approvalStep = wf.steps[approvalIndex]
  const outputs = run.outputs.slice(0, approvalIndex)
  const vars: RenderVars = { inputs: { ...run.inputs }, steps: {} }
  for (let i = 0; i < approvalIndex; i++) {
    if (outputs[i] !== SKIP_MARKER) vars.steps[wf.steps[i]?.id ?? `step${i + 1}`] = outputs[i]!
  }
  const approvalOutput = `✅ 已批准：${approvalStep?.title ?? '审批'}`
  outputs.push(approvalOutput)
  vars.steps[approvalStep?.id ?? `step${approvalIndex + 1}`] = approvalOutput

  const traceId = run.traceId ?? randomUUID()
  if (!run.traceId) {
    setRunTraceId(run.id, traceId)
    startAgentOpsTrace({
      id: traceId, kind: 'workflow', status: 'running', agentId: wf.agentId, chatId: run.chatId,
      workflowId: wf.id, workflowRunId: run.id, coverage: 'partial',
      coverageNotes: ['legacy_run_before_tracing'], startedAt: run.startedAt,
    })
  } else {
    markAgentOpsTraceRunning(traceId)
  }

  reopenApprovedRun(run.id)
  runningWorkflows.add(wf.id)
  getLogger().info({ workflowId: wf.id, runId: run.id, approvedStep: approvalIndex, category: 'workflow' }, 'Workflow approval granted, resuming')
  const done = executeRunLoop(d, wf, run.id, traceId, run.chatId, vars, outputs, approvalIndex + 1, null)
  return { run: getRun(run.id)!, done }
}

/** [XJC] 人工拒绝审批节点：awaiting_approval → failed（终止本次运行，用户可重新运行）。 */
export function rejectWorkflowRun(runId: string, reason?: string): WorkflowRun {
  const run = getRun(runId)
  if (!run) throw new WorkflowError(WORKFLOW_NOT_FOUND, `运行「${runId}」不存在`)
  if (run.status !== 'awaiting_approval') {
    throw new WorkflowError(WORKFLOW_INVALID, `只有待审批的运行可以拒绝（当前状态：${run.status}）`)
  }
  rejectRun(run.id, reason?.trim() || '用户拒绝了审批')
  if (run.traceId) {
    finishAgentOpsTrace(run.traceId, 'failed', { errorCode: 'WORKFLOW_REJECTED', stopReason: 'rejected' })
  }
  getLogger().info({ runId: run.id, category: 'workflow' }, 'Workflow approval rejected')
  return getRun(run.id)!
}
