import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_MEMORY_MD, DEFAULT_WORKSPACE_DOCS } from './templates.ts'

const WORKSPACE_STATE_DIRNAME = '.XiaoJuClaw'
const WORKSPACE_STATE_FILENAME = 'workspace-state.json'
const WORKSPACE_STATE_VERSION = 1
const DEFAULT_BOOTSTRAP_FILENAME = 'BOOTSTRAP.md'
const DEFAULT_MEMORY_FILENAME = 'MEMORY.md'

export const WORKSPACE_STATE_PATH_SEGMENTS = [
  WORKSPACE_STATE_DIRNAME,
  WORKSPACE_STATE_FILENAME,
] as const

type WorkspaceSetupState = {
  version: typeof WORKSPACE_STATE_VERSION
  bootstrapSeededAt?: string
  setupCompletedAt?: string
}

function resolveWorkspaceStatePath(agentDir: string): string {
  return resolve(agentDir, ...WORKSPACE_STATE_PATH_SEGMENTS)
}

function readWorkspaceSetupState(agentDir: string): WorkspaceSetupState {
  const statePath = resolveWorkspaceStatePath(agentDir)
  if (!existsSync(statePath)) {
    return { version: WORKSPACE_STATE_VERSION }
  }

  try {
    const raw = readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown
      setupCompletedAt?: unknown
    }
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt: typeof parsed.bootstrapSeededAt === 'string' ? parsed.bootstrapSeededAt : undefined,
      setupCompletedAt: typeof parsed.setupCompletedAt === 'string' ? parsed.setupCompletedAt : undefined,
    }
  } catch {
    return { version: WORKSPACE_STATE_VERSION }
  }
}

function writeWorkspaceSetupState(agentDir: string, state: WorkspaceSetupState): void {
  const statePath = resolveWorkspaceStatePath(agentDir)
  mkdirSync(resolve(agentDir, WORKSPACE_STATE_DIRNAME), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

function writeFileIfMissing(filePath: string, content: string): boolean {
  if (existsSync(filePath)) return false
  writeFileSync(filePath, content)
  return true
}

function nowIso(): string {
  return new Date().toISOString()
}

export function ensureAgentWorkspace(agentDir: string, options?: {
  ensureBootstrap?: boolean
  ensureSkillsDir?: boolean
  ensurePromptsDir?: boolean
}): {
  bootstrapPending: boolean
  state: WorkspaceSetupState
} {
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(resolve(agentDir, 'memory'), { recursive: true })

  if (options?.ensureSkillsDir) {
    mkdirSync(resolve(agentDir, 'skills'), { recursive: true })
  }
  if (options?.ensurePromptsDir) {
    mkdirSync(resolve(agentDir, 'prompts'), { recursive: true })
  }

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_DOCS)) {
    if (filename === DEFAULT_BOOTSTRAP_FILENAME) continue
    writeFileIfMissing(resolve(agentDir, filename), content)
  }
  writeFileIfMissing(resolve(agentDir, DEFAULT_MEMORY_FILENAME), DEFAULT_MEMORY_MD)

  const bootstrapPath = resolve(agentDir, DEFAULT_BOOTSTRAP_FILENAME)
  const bootstrapTemplate = DEFAULT_WORKSPACE_DOCS[DEFAULT_BOOTSTRAP_FILENAME] ?? ''

  let state = readWorkspaceSetupState(agentDir)
  let stateDirty = false
  const markState = (next: Partial<WorkspaceSetupState>) => {
    state = { ...state, ...next }
    stateDirty = true
  }

  let bootstrapExists = existsSync(bootstrapPath)
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() })
  }

  if (!state.setupCompletedAt && state.bootstrapSeededAt && !bootstrapExists) {
    markState({ setupCompletedAt: nowIso() })
  }

  if (options?.ensureBootstrap !== false && !state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
    writeFileIfMissing(bootstrapPath, bootstrapTemplate)
    bootstrapExists = existsSync(bootstrapPath)
    if (bootstrapExists && !state.bootstrapSeededAt) {
      markState({ bootstrapSeededAt: nowIso() })
    }
  }

  if (stateDirty) {
    writeWorkspaceSetupState(agentDir, state)
  }

  return {
    bootstrapPending: bootstrapExists,
    state,
  }
}
