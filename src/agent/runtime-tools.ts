// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { createBuiltinImageTool, isVlmAvailable } from './builtin-mcp.ts'
import { createMessageTool } from './message-mcp.ts'
import { createDocumentTools } from './document-mcp.ts'
import { createTaskTools } from './task-mcp.ts'
import { createSkillsTools } from './skills-mcp.ts'
import type { BrowserManager, BrowserTarget } from '../browser/index.ts'
import { createBrowserMcpServer, logBrowserToolRegistration } from '../browser/index.ts'
import type { SecretsManager } from './secrets.ts'
import { createExternalMcpToolRuntime } from './mcp-tools.ts'
import { wrapToolsWithSqueeze } from './output-squeeze.ts'
import type { AgentConfig } from './types.ts'

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}

export function filterConfiguredTools<T extends { name: string }>(
  tools: T[],
  config: Pick<AgentConfig, 'allowedTools' | 'disallowedTools'>,
): T[] {
  const allowedTools = config.allowedTools
    ? new Set(config.allowedTools.map((name) => normalizeToolName(name)))
    : null
  const disallowedTools = new Set((config.disallowedTools ?? []).map((name) => normalizeToolName(name)))

  return tools.filter((tool) => {
    const normalized = normalizeToolName(tool.name)
    if (disallowedTools.has(normalized)) {
      return false
    }
    if (allowedTools && !allowedTools.has(normalized)) {
      return false
    }
    return true
  })
}

export async function buildRuntimeCustomTools(params: {
  config: Pick<AgentConfig, 'mcpServers'>
  browserManager: BrowserManager | null
  secretsManager: SecretsManager | null
  chatId: string
  agentId: string
  browserProfileId?: string
  browserTarget?: BrowserTarget
  reservedToolNames?: string[]
}): Promise<{
  tools: ToolDefinition[]
  dispose: () => Promise<void>
}> {
  const customTools: ToolDefinition[] = [
    // Image tool requires a configured VLM endpoint; skip registration when absent
    ...(isVlmAvailable() ? [createBuiltinImageTool()] : []),
    createMessageTool(params.chatId, params.agentId),
    ...createDocumentTools(params.chatId),
    ...createTaskTools({ chatId: params.chatId, agentId: params.agentId }),
    // [XJC] 对话式技能自管理：依赖在 index.ts 启动时经 configureSkillsMcpRuntime 注入
    ...createSkillsTools({ agentId: params.agentId }),
  ]
  let externalMcpDispose: (() => Promise<void>) | undefined

  if (params.browserManager && params.browserProfileId) {
    const browserTools = createBrowserMcpServer({
      browserManager: params.browserManager,
      chatId: params.chatId,
      agentId: params.agentId,
      profileId: params.browserProfileId,
      target: params.browserTarget ?? 'host',
    })
    customTools.push(...browserTools)
    logBrowserToolRegistration(params.browserProfileId, params.browserTarget ?? 'host')
  }

  if (params.config.mcpServers) {
    const resolvedServers = params.secretsManager
      ? params.secretsManager.injectToMcpEnv(params.agentId, params.config.mcpServers)
      : params.config.mcpServers
    const mcpRuntime = await createExternalMcpToolRuntime({
      servers: resolvedServers,
      reservedToolNames: [...(params.reservedToolNames ?? []), ...customTools.map((tool) => tool.name)],
    })
    customTools.push(...mcpRuntime.tools)
    externalMcpDispose = mcpRuntime.dispose
  }

  return {
    // [XJC-PATCH] T-G2 输出压缩层：结果进上下文前超阈值截断+原文落盘（顺序与名称不变）
    tools: wrapToolsWithSqueeze(customTools),
    dispose: async () => {
      await externalMcpDispose?.()
    },
  }
}
