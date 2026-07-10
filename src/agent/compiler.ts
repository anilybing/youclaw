// [XJC-PATCH] compatibility layer for referenced sub-agent definitions.
import {
  existsSync,
  realpathSync,
  statSync,
  readFileSync,
} from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { getPaths } from '../config/index.ts'
import {
  AgentConfigSchema,
  AgentEntrySchema,
  type AgentDefinition,
  type AgentEntry,
  type AgentRef,
} from './schema.ts'
import type { AgentConfig } from './types.ts'
import type { PromptBuilder } from './prompt-builder.ts'

const AGENT_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const MAX_AGENT_CONFIG_BYTES = 256 * 1024
const MAX_AGENT_PROMPT_FILE_BYTES = 1024 * 1024
const MAX_REFERENCE_DEPTH = 16
const PROMPT_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const

type LoadedAgent = {
  config: AgentConfig
  workspaceDir: string
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readBoundedFile(path: string, root: string, maxBytes: number, label: string): string {
  const realRoot = realpathSync(root)
  const realPath = realpathSync(path)
  if (!isPathInside(realRoot, realPath)) {
    throw new Error(`${label} resolves outside the referenced agent directory`)
  }

  const stat = statSync(realPath)
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file`)
  }
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit`)
  }

  return readFileSync(realPath, 'utf-8')
}

/**
 * Resolves legacy `agents.<name>.ref` entries into the inline definitions used
 * by the current sub-agent runtime. Referenced agents are loaded with the same
 * schema/default semantics as AgentManager, while reference overrides win.
 */
export class AgentCompiler {
  constructor(private readonly promptBuilder: PromptBuilder) {}

  resolve(entries: Record<string, AgentEntry>, parentAgentId: string): Record<string, AgentDefinition> {
    const resolved: Record<string, AgentDefinition> = {}

    for (const [name, rawEntry] of Object.entries(entries)) {
      const entry = AgentEntrySchema.parse(rawEntry)
      resolved[name] = 'ref' in entry
        ? this.resolveReference(entry, parentAgentId)
        : entry
    }

    return resolved
  }

  private resolveReference(entry: AgentRef, parentAgentId: string): AgentDefinition {
    this.assertNoReferenceCycle(entry.ref, [parentAgentId], 0)
    const target = this.loadAgent(entry.ref)
    const basePrompt = this.promptBuilder.build(target.workspaceDir, target.config)
    const prompt = [basePrompt, entry.prompt]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join('\n\n')

    return {
      description: entry.description ?? target.config.name,
      ...(prompt ? { prompt } : {}),
      ...(entry.tools ?? target.config.allowedTools
        ? { tools: entry.tools ?? target.config.allowedTools }
        : {}),
      ...(entry.disallowedTools ?? target.config.disallowedTools
        ? { disallowedTools: entry.disallowedTools ?? target.config.disallowedTools }
        : {}),
      ...(entry.model ?? target.config.model
        ? { model: entry.model ?? target.config.model }
        : {}),
      ...(entry.maxTurns ?? target.config.maxTurns
        ? { maxTurns: entry.maxTurns ?? target.config.maxTurns }
        : {}),
      ...(target.config.mcpServers ? { mcpServers: target.config.mcpServers } : {}),
    }
  }

  private assertNoReferenceCycle(agentId: string, ancestors: string[], depth: number): void {
    if (ancestors.includes(agentId)) {
      throw new Error(`Circular agent reference detected: ${[...ancestors, agentId].join(' -> ')}`)
    }
    if (depth >= MAX_REFERENCE_DEPTH) {
      throw new Error(`Agent reference depth exceeds ${MAX_REFERENCE_DEPTH}`)
    }

    const target = this.loadAgent(agentId)
    const nextAncestors = [...ancestors, agentId]
    for (const nested of Object.values(target.config.agents ?? {})) {
      if ('ref' in nested) {
        this.assertNoReferenceCycle(nested.ref, nextAncestors, depth + 1)
      }
    }
  }

  private loadAgent(agentId: string): LoadedAgent {
    if (!AGENT_REF_PATTERN.test(agentId)) {
      throw new Error(`Invalid agent reference: ${agentId}`)
    }

    const agentsRoot = resolve(getPaths().agents)
    const workspaceDir = resolve(agentsRoot, agentId)
    if (!isPathInside(agentsRoot, workspaceDir)) {
      throw new Error(`Agent reference escapes the agents directory: ${agentId}`)
    }
    if (!existsSync(workspaceDir)) {
      throw new Error(`Referenced agent does not exist: ${agentId}`)
    }
    const realAgentsRoot = realpathSync(agentsRoot)
    const realWorkspaceDir = realpathSync(workspaceDir)
    if (!isPathInside(realAgentsRoot, realWorkspaceDir)) {
      throw new Error(`Referenced agent resolves outside the agents directory: ${agentId}`)
    }

    const configPath = resolve(workspaceDir, 'agent.yaml')
    if (!existsSync(configPath)) {
      throw new Error(`Referenced agent does not exist: ${agentId}`)
    }

    const rawYaml = readBoundedFile(
      configPath,
      workspaceDir,
      MAX_AGENT_CONFIG_BYTES,
      `Referenced agent config "${agentId}"`,
    )
    const parsed = parseYaml(rawYaml)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Referenced agent config is invalid: ${agentId}`)
    }

    for (const filename of PROMPT_FILES) {
      const path = resolve(workspaceDir, filename)
      if (existsSync(path)) {
        readBoundedFile(
          path,
          workspaceDir,
          MAX_AGENT_PROMPT_FILE_BYTES,
          `Referenced agent prompt "${agentId}/${filename}"`,
        )
      }
    }

    const source = parsed as Record<string, unknown>
    const config = AgentConfigSchema.parse({
      ...source,
      id: source.id ?? agentId,
      name: source.name ?? agentId,
    })

    return {
      config: {
        ...config,
        workspaceDir,
        hasExplicitModel: typeof source.model === 'string' && source.model.trim().length > 0,
      },
      workspaceDir,
    }
  }
}
