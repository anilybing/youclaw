// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import type { AgentRuntime } from './runtime.ts'
import type { AgentConfig as SchemaAgentConfig } from './schema.ts'
import type { AgentOpsTraceContext } from '../agentops/types.ts'

// Extend schema config with runtime fields
export interface AgentConfig extends SchemaAgentConfig {
  workspaceDir: string
  hasExplicitModel?: boolean
}

export interface AgentState {
  sessionId: string | null
  isProcessing: boolean
  lastProcessedAt: string | null
  totalProcessed: number
  lastError: string | null
  queueDepth: number
}

export interface ProcessParams {
  chatId: string
  prompt: string
  agentId: string
  turnId?: string
  /** Queue-owned controller. Direct runtime callers may omit it. */
  abortController?: AbortController
  /** Durable trace context; queue creates a root trace when omitted. */
  agentOps?: AgentOpsTraceContext
  /** Mutable queue/runtime outcome bridge; kept optional for legacy callers. */
  executionState?: {
    status: 'pending' | 'success' | 'failed' | 'cancelled'
    errorCode?: string
  }
  requestedSkills?: string[]
  browserProfileId?: string | null
  attachments?: Array<{ filename: string; mediaType: string; filePath: string }>
  // [XJC] 调度器发起的运行置真：runtime 仍 emit complete（供落库/前端），
  // 但 MessageRouter 跳过 handleOutbound，避免与 scheduler.deliver() 向渠道重复发送。
  suppressOutbound?: boolean
}

export interface AgentInstance {
  config: AgentConfig
  workspaceDir: string
  runtime: AgentRuntime
  state: AgentState
}

// Backward-compatible alias
export type ManagedAgent = AgentInstance
