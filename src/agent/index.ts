// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
export { AgentRuntime } from './runtime.ts'
export { AgentManager } from './manager.ts'
export {
  AgentQueue,
  QueueCancellationError,
  isQueueCancellationError,
  QUEUE_CANCELLATION_CODE,
} from './queue.ts'
export type { EnqueueOptions, QueueCancelResult } from './queue.ts'
export { PromptBuilder } from './prompt-builder.ts'
export { AgentCompiler } from './compiler.ts'
export { abortRegistry } from './abort-registry.ts'
export { AgentRouter } from './router.ts'
export { HooksManager } from './hooks.ts'
export { SecretsManager } from './secrets.ts'
export { createSecurityHook } from './security.ts'
export { DEFAULT_WORKSPACE_DOCS, DEFAULT_MEMORY_MD, EDITABLE_WORKSPACE_DOCS } from './templates.ts'
export { ensureAgentWorkspace, WORKSPACE_STATE_PATH_SEGMENTS } from './workspace.ts'
export { AgentConfigSchema, McpServerSchema, AgentDefinitionSchema, AgentRefSchema, AgentEntrySchema, BindingSchema, HookEntrySchema, HooksConfigSchema, SecurityConfigSchema, BrowserConfigSchema } from './schema.ts'
export type { AgentConfig, AgentState, ProcessParams, AgentInstance, ManagedAgent } from './types.ts'
export type { RouteContext, RouteTableEntry } from './router.ts'
export type { HookPhase, HookContext, HookHandler } from './hooks.ts'
export type { AgentDefinition, McpServerConfig, AgentRef, AgentEntry, Binding, BindingCondition, HooksConfig, HookEntry, SecurityConfig, BrowserConfig } from './schema.ts'
