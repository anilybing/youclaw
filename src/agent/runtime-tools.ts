// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { createBuiltinImageTool, isVlmAvailable } from './builtin-mcp.ts'
import { createMessageTool } from './message-mcp.ts'
import { createDocumentTools } from './document-mcp.ts'
import { createTaskTools } from './task-mcp.ts'
import { createSkillsTools } from './skills-mcp.ts'
import { createKnowledgeTools } from './knowledge-mcp.ts'
import { createMediaTools } from './media-mcp.ts'
import { createMemoryTools } from './memory-mcp.ts'
import { createPlanTools } from './plan-mcp.ts'
import { createEmployeeTools } from './employee-mcp.ts'
import { createVoiceTools } from './voice-mcp.ts'
import { createFulfillmentTools } from './fulfillment-mcp.ts'
import { createWorkflowTools } from './workflow-mcp.ts'
import type { MemoryManager } from '../memory/index.ts'
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
  memoryManager?: MemoryManager | null
  chatId: string
  agentId: string
  workspaceDir: string
  documentAttachmentPaths?: string[]
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
    ...createDocumentTools(params.chatId, {
      workspaceDir: params.workspaceDir,
      attachmentPaths: params.documentAttachmentPaths,
    }),
    ...createTaskTools({ chatId: params.chatId, agentId: params.agentId }),
    // [XJC] 对话式技能自管理：依赖在 index.ts 启动时经 configureSkillsMcpRuntime 注入
    ...createSkillsTools({ agentId: params.agentId }),
    // [XJC] 知识库检索（T-A1）：FTS5 全文检索用户上传文档，回答须标注来源
    ...createKnowledgeTools(),
    // [XJC] 媒体生成（T-B7）：生图/对话式改图/视频，产物落「媒体产出」
    ...createMediaTools({ agentId: params.agentId }),
    // [XJC] 记忆自管理（学习强化）：确定性「记住/回忆」，用户显式教学不再靠 agent 自觉写文件
    ...(params.memoryManager ? createMemoryTools({ agentId: params.agentId, memoryManager: params.memoryManager }) : []),
    // [XJC] 显式计划（自主强化）：多步任务建持久化计划，每轮注入，压缩/重启不丢
    ...createPlanTools({ chatId: params.chatId, agentId: params.agentId }),
    // [XJC] 对话式建员工（自主强化）：征得同意后创建顶层数字员工（依赖 index.ts 装配）
    ...createEmployeeTools(),
    // [XJC] 录音转写（丰富性强化）：会议录音/语音备忘 → 文本，接 meeting-notes 成纪要
    ...createVoiceTools(),
    // [XJC] 虚拟商品发货（闲鱼客服员工）：卡密库存 + 原子幂等发货。
    // 默认关闭、仅闲鱼客服员工挂载——deliver 会把真实卡密带进对话上下文，
    // 若全员工可用，接了渠道的员工（微信/TG 面向陌生人）一句注入话术就能套走卡密。
    ...(params.agentId === 'xianyu-cs' ? createFulfillmentTools({ agentId: params.agentId }) : []),
    // [XJC] 工作流（通用/垂直编排原语）：察觉固定流水线→沉淀→一句话复跑
    ...createWorkflowTools({ agentId: params.agentId, chatId: params.chatId }),
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
