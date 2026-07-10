// [XJC] 子代理委派 · 隔离子会话 runner（自主能力 P0）
//
// 背景：办公助理等在 SOUL/agent.yaml 里承诺"派专员分治长文档/复杂表格"，但此前 runtime
// 从不读 config.agents，"派专员"是空头支票。此模块把它落地：为一个子代理规格开一个
// **全新、隔离**的 agent 会话（SessionManager.inMemory()，不共享父会话历史 = 真正分治），
// 跑到完成后把最终文本返回给父代理作为工具结果。
//
// 隔离要点：
//  - 内存会话：子代理上下文与父对话完全隔离，长文档分段处理不污染主上下文；
//  - 系统提示整体覆盖为子代理 persona（不注入父的 SOUL/记忆/技能，保持精简聚焦）；
//  - 工具白名单：由调用方按子代理定义过滤后传入，且**绝不含 delegate 工具本身**（防套娃）；
//  - 安全阀：工具调用数上限（近似 maxTurns）+ 墙钟超时，任一触发即 abort，返回已产出文本。

import { createAgentSession, createCodingTools, SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession, AgentSessionEvent, ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Api, AssistantMessage, Model } from '@mariozechner/pi-ai'
import { randomUUID } from 'node:crypto'
import { getLogger } from '../logger/index.ts'
import {
  classifyToolEffect,
  finishAgentOpsTrace,
  isModelPriceKnown,
  recordAgentOpsModelUsage,
  recordAgentOpsTool,
  startAgentOpsTrace,
} from '../agentops/index.ts'

/** pi-coding-agent 未在包根导出 Tool 类型，从 createCodingTools 返回值推导 */
type Tool = ReturnType<typeof createCodingTools>[number]

/** 子代理默认工具调用数上限（近似"轮次"，防失控循环）；子代理定义可覆盖 */
export const SUBAGENT_DEFAULT_MAX_TOOL_CALLS = 25
/** 子代理默认墙钟超时（分治任务通常较重，给足时间但必须有上限） */
export const SUBAGENT_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
/** 全局并发子代理上限：单体深度已由"子代理不带 delegate"结构性封顶，此处封"广度"——
 *  父 LLM 一轮并行多发 delegate 时，超出的排队而非同时起 N 个会话，防资源/成本放大。 */
export const SUBAGENT_MAX_CONCURRENCY = 3

// 交接式信号量（子代理不能再委派 → 无嵌套 acquire → 无死锁）
let activeSubagents = 0
const subagentWaiters: Array<() => void> = []

function acquireSubagentSlot(): Promise<void> {
  if (activeSubagents < SUBAGENT_MAX_CONCURRENCY) {
    activeSubagents += 1
    return Promise.resolve()
  }
  // 满槽：入队等待，槽位由 release 直接交接（不改 activeSubagents 计数）
  return new Promise<void>((resolve) => subagentWaiters.push(resolve))
}

function releaseSubagentSlot(): void {
  const next = subagentWaiters.shift()
  if (next) next() // 把槽交接给下一个等待者，计数不变
  else activeSubagents = Math.max(0, activeSubagents - 1)
}

export interface SubagentRunSpec {
  /** 子代理系统提示（persona + 守则，整体覆盖）*/
  systemPrompt: string
  /** 复用父代理已解析的模型（MVP：不支持子代理独立模型）*/
  model: Model<Api>
  cwd: string
  /** 过滤后的内置工具（read/bash/edit/write 子集）*/
  builtinTools: Tool[]
  /** 过滤后的自定义工具（不含 delegate，防套娃）*/
  customTools: ToolDefinition[]
  /** 工具调用数上限 */
  maxToolCalls: number
  /** 墙钟超时 */
  timeoutMs: number
}

export interface SubagentRunResult {
  text: string
  toolCalls: number
  aborted: boolean
  abortReason?: 'maxTurns' | 'timeout'
}

/** 子会话系统提示整体覆盖（与 runtime.applySystemPromptOverrideToSession 同款，单文件自持） */
function overrideSystemPrompt(session: AgentSession, systemPrompt: string): void {
  const prompt = systemPrompt.trim()
  session.agent.setSystemPrompt(prompt)
  const mutable = session as unknown as { _baseSystemPrompt?: string }
  mutable._baseSystemPrompt = prompt
}

/**
 * 运行一次子代理任务，返回其最终文本产出。绝不抛错影响父流程：
 * 任何异常/中止都归一化为"返回已累积文本 + aborted 标记"。
 */
export async function runSubagentTask(spec: SubagentRunSpec, task: string): Promise<SubagentRunResult> {
  // 并发闸：满槽则排队（超时从取得槽位后才开始计，排队不算超时）
  await acquireSubagentSlot()
  try {
    return await runSubagentTaskInner(spec, task)
  } finally {
    releaseSubagentSlot()
  }
}

async function runSubagentTaskInner(spec: SubagentRunSpec, task: string): Promise<SubagentRunResult> {
  const traceId = randomUUID()
  const pricingKnown = isModelPriceKnown(spec.model)
  try {
    startAgentOpsTrace({
      id: traceId,
      kind: 'subagent',
      status: 'running',
      modelProvider: spec.model.provider,
      modelId: spec.model.id,
      coverage: 'partial',
      coverageNotes: [
        'parent_trace_unavailable',
        'model_latency_unavailable',
        ...(pricingKnown ? [] : ['unknown_model_price']),
      ],
    })
  } catch {
    // Trace persistence is best-effort.
  }
  let session: AgentSession
  try {
    ({ session } = await createAgentSession({
      cwd: spec.cwd,
      model: spec.model,
      tools: spec.builtinTools,
      customTools: spec.customTools,
      sessionManager: SessionManager.inMemory(spec.cwd),
    }))
  } catch (err) {
    try {
      finishAgentOpsTrace(traceId, 'failed', {
        errorCode: 'SUBAGENT_SESSION_CREATE_FAILED',
        stopReason: 'session_create_error',
      })
    } catch {
      // Trace persistence is best-effort.
    }
    throw err
  }
  overrideSystemPrompt(session, spec.systemPrompt)

  let text = ''
  let toolCalls = 0
  let aborted = false
  let failed = false
  let abortReason: 'maxTurns' | 'timeout' | undefined

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_update') {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta') text += inner.delta
      return
    }
    if (event.type === 'tool_execution_start') {
      toolCalls += 1
      try {
        recordAgentOpsTool({
          traceId,
          toolName: event.toolName,
          effect: classifyToolEffect(event.toolName),
        })
      } catch {
        // Trace persistence is best-effort.
      }
      if (toolCalls > spec.maxToolCalls && !aborted) {
        aborted = true
        abortReason = 'maxTurns'
        void session.abort().catch(() => { /* 已在结束 */ })
      }
    }
    if (event.type === 'turn_end') {
      const message = event.message as AssistantMessage
      if (message?.role === 'assistant' && message.usage) {
        try {
          recordAgentOpsModelUsage({
            traceId,
            model: { provider: spec.model.provider, id: spec.model.id },
            usage: message.usage,
            pricingKnown,
            latencyMs: 0,
          })
        } catch {
          // Trace persistence is best-effort.
        }
      }
    }
  })

  const timer = setTimeout(() => {
    if (aborted) return
    aborted = true
    abortReason = 'timeout'
    void session.abort().catch(() => { /* 已在结束 */ })
  }, spec.timeoutMs)

  try {
    await session.prompt(task)
  } catch (err) {
    // abort 会让 prompt reject；非 abort 的真实错误记日志但仍返回已产出文本
    if (!aborted) {
      failed = true
      getLogger().warn({ error: err instanceof Error ? err.message : String(err), category: 'subagent' }, 'Subagent run failed')
    }
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }

  try {
    finishAgentOpsTrace(
      traceId,
      aborted ? 'cancelled' : failed ? 'failed' : 'success',
      aborted
        ? { errorCode: 'SUBAGENT_CANCELLED', stopReason: abortReason }
        : failed ? { errorCode: 'SUBAGENT_FAILED', stopReason: 'execution_error' } : undefined,
    )
  } catch {
    // Trace persistence is best-effort.
  }
  return { text: text.trim(), toolCalls, aborted, abortReason }
}
