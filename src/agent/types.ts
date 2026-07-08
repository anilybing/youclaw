import type { AgentRuntime } from './runtime.ts'
import type { AgentConfig as SchemaAgentConfig } from './schema.ts'

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
