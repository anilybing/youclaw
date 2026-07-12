/**
 * System Prompt scheduled task documentation tests
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { PromptBuilder } from '../src/agent/prompt-builder.ts'
import type { AgentConfig } from '../src/agent/types.ts'
import { loadEnv } from '../src/config/env.ts'
import { initLogger } from '../src/logger/index.ts'
import { tmpdir } from 'node:os'
import { clearAllBootstrapSnapshots } from '../src/agent/bootstrap-cache.ts'
import { DEFAULT_AGENTS_MD } from '../src/agent/templates.ts'

const systemPromptPath = resolve(import.meta.dir, '../prompts/system.md')
const content = readFileSync(systemPromptPath, 'utf-8')

loadEnv()
initLogger()

describe('system.md — task MCP documentation', () => {
  test('contains list/update task MCP tool names', () => {
    expect(content).toContain('mcp__task__list_tasks')
    expect(content).toContain('mcp__task__update_task')
  })

  test('contains action create example with name', () => {
    expect(content).toContain('"action": "create"')
    expect(content).toContain('"name"')
    expect(content).toContain('"chat_id"')
  })

  test('contains schedule_type option descriptions', () => {
    expect(content).toContain('cron')
    expect(content).toContain('interval')
    expect(content).toContain('once')
  })

  test('contains update/pause/resume/delete action examples', () => {
    expect(content).toContain('"action": "update"')
    expect(content).toContain('"action": "pause"')
    expect(content).toContain('"action": "resume"')
    expect(content).toContain('"action": "delete"')
  })

  test('requires list before write operation', () => {
    expect(content).toContain('Always call `mcp__task__list_tasks` before any `mcp__task__update_task` write operation')
  })

  test('does not contain legacy IPC task file guidance', () => {
    expect(content).not.toContain('"type": "schedule_task"')
    expect(content).not.toContain('current_tasks.json')
    expect(content).not.toContain('./data/ipc/')
  })
})

describe('DEFAULT_AGENTS_MD — scheduled task guidance', () => {
  test('uses task MCP documentation instead of legacy IPC guidance', () => {
    expect(DEFAULT_AGENTS_MD).toContain('mcp__task__list_tasks')
    expect(DEFAULT_AGENTS_MD).toContain('mcp__task__update_task')
    expect(DEFAULT_AGENTS_MD).not.toContain('current_tasks.json')
    expect(DEFAULT_AGENTS_MD).not.toContain('"type": "schedule_task"')
    expect(DEFAULT_AGENTS_MD).not.toContain('Write JSON files to')
  })
})

describe('PromptBuilder channel context', () => {
  test('injects wechat-personal media delivery hints for current recipient', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'wxp:wechat-personal-main:user123@im.wechat',
      },
    )

    expect(prompt).toContain('Current channel: wechat-personal')
    expect(prompt).toContain('Current recipient WeChat ID: user123@im.wechat')
    expect(prompt).toContain('This channel supports sending text, images, and files back to the current user.')
    expect(prompt).toContain('`mcp__message__send_to_current_chat`')
    expect(prompt).toContain('do not claim that WeChat cannot send images or files')
  })
})

describe('PromptBuilder channel context', () => {
  test('injects wechat-personal media delivery hints for current recipient', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'wxp:wechat-personal-main:user123@im.wechat',
      },
    )

    expect(prompt).toContain('Current channel: wechat-personal')
    expect(prompt).toContain('Current recipient WeChat ID: user123@im.wechat')
    expect(prompt).toContain('This channel supports sending text, images, and files back to the current user.')
    expect(prompt).toContain('`mcp__message__send_to_current_chat`')
    expect(prompt).toContain('do not claim that WeChat cannot send images or files')
  })

  test('injects provided skills prompt and memory context overrides', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'web:chat-1',
        skillsPrompt: '<available_skills>\n  <skill>\n    <name>call-me-dad</name>\n  </skill>\n</available_skills>',
        memoryContext: '<memory>\nretrieved hit\n</memory>',
      },
    )

    expect(prompt).toContain('## Skills (on-demand)')
    expect(prompt).toContain('For ordinary requests, answer directly without reading any SKILL.md.')
    expect(prompt).toContain('call-me-dad')
    expect(prompt).toContain('<available_skills>')
    expect(prompt).toContain('<memory>')
    expect(prompt).toContain('retrieved hit')
  })

  test('uses task MCP guidance instead of IPC task file guidance', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'web:chat-1',
      },
    )

    expect(prompt).toContain('mcp__task__list_tasks')
    expect(prompt).toContain('mcp__task__update_task')
    expect(prompt).not.toContain('current_tasks.json')
    expect(prompt).not.toContain('Persistent scheduled tasks are managed through IPC task files')
    expect(prompt).not.toContain('IPC Directory:')
  })

  test('routes configured image requests to the built-in media tool instead of skill discovery', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'web:chat-media',
        mediaStatus: {
          imageConfigured: true,
          imageEditConfigured: true,
          videoConfigured: false,
        },
        mediaTurnInstruction: '<runtime_media_instruction>authorized test turn</runtime_media_instruction>',
        availableToolNames: [
          'Read',
          'mcp__media__generate_image',
          'mcp__media__edit_image',
          'mcp__media__generate_video',
        ],
      },
    )

    expect(prompt).toContain('## Built-in Media Generation Rule')
    expect(prompt).toContain('text-to-image=configured')
    expect(prompt).toContain('Tool execution enforces per-turn authorization and call limits')
    expect(prompt).toContain('Never call skill list/discovery/install tools')
    expect(prompt).toContain('do not claim that an image skill is missing')
    expect(prompt).toContain('<runtime_media_instruction>authorized test turn</runtime_media_instruction>')
    expect(prompt).not.toContain('## Image Understanding Rule')
    // 工具规则按需注入：本轮未挂载 skills/document/task 工具时，对应规则不再占 token
    expect(prompt).not.toContain('## Skill Self-Service Rule')
    expect(prompt).not.toContain('## Document Handling Rule')
    expect(prompt).not.toContain('## Scheduled Task Rule')
  })

  test('only injects image understanding policy when the VLM tool is actually available', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'web:chat-vlm',
        availableToolNames: ['Read', 'mcp__minimax__understand_image'],
      },
    )

    expect(prompt).toContain('## Image Understanding Rule')
    expect(prompt).toContain('mcp__minimax__understand_image')
    expect(prompt).toContain('edit_image` may operate directly')
  })

  test('does not advertise configured media tools that were filtered out for the employee', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'restricted',
        chatId: 'web:chat-restricted',
        mediaStatus: {
          imageConfigured: true,
          imageEditConfigured: true,
          videoConfigured: true,
        },
        availableToolNames: ['Read'],
      },
    )

    expect(prompt).not.toContain('## Built-in Media Generation Rule')
    expect(prompt).not.toContain('mcp__media__generate_image')
  })
})

describe('PromptBuilder cache-prefix ordering & conditional rules', () => {
  test('volatile memory context and media turn instruction are placed after static rules', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'web:chat-order',
        skillsPrompt: '<available_skills><skill><name>x</name></skill></available_skills>',
        memoryContext: '<memory>\nvolatile retrieved hit\n</memory>',
        mediaTurnInstruction: '<runtime_media_instruction>turn-scoped</runtime_media_instruction>',
        availableToolNames: [
          'read',
          'mcp__document__search_document',
          'mcp__task__list_tasks',
          'mcp__skills__list_skills',
        ],
      },
    )

    const memoryIdx = prompt.indexOf('<memory>')
    const mediaTurnIdx = prompt.indexOf('<runtime_media_instruction>')
    const skillsIdx = prompt.indexOf('## Skills (on-demand)')
    const documentRuleIdx = prompt.indexOf('## Document Handling Rule')
    const taskRuleIdx = prompt.indexOf('## Scheduled Task Rule')
    const skillRuleIdx = prompt.indexOf('## Skill Self-Service Rule')
    const currentContextIdx = prompt.indexOf('## Current Context')

    expect(memoryIdx).toBeGreaterThan(-1)
    expect(mediaTurnIdx).toBeGreaterThan(-1)
    for (const staticIdx of [skillsIdx, documentRuleIdx, taskRuleIdx, skillRuleIdx, currentContextIdx]) {
      expect(staticIdx).toBeGreaterThan(-1)
      expect(memoryIdx).toBeGreaterThan(staticIdx)
      expect(mediaTurnIdx).toBeGreaterThan(staticIdx)
    }
    expect(mediaTurnIdx).toBeGreaterThan(memoryIdx)
  })

  test('injected-files notice and action-first principles are present with workspace docs', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'XiaoJuClaw-principles-'))
    try {
      writeFileSync(resolve(workspaceDir, 'SOUL.md'), '# Soul\n先确认需求要点（一次问全），再动手\n')
      writeFileSync(resolve(workspaceDir, 'AGENTS.md'), '# Agents\n## Session Startup\nRead SOUL.md first\n')

      const builder = new PromptBuilder(null, null)
      const prompt = builder.build(workspaceDir, { workspaceDir } as AgentConfig, {
        agentId: 'a-principles',
        chatId: 'web:chat-principles',
      })

      expect(prompt).toContain('Never use Read/tools to re-open these injected files')
      expect(prompt).toContain('## Operating Principles (行动优先)')
      expect(prompt).toContain('信息足够就直接动手')
      expect(prompt).toContain('不可逆/破坏性操作')
    } finally {
      clearAllBootstrapSnapshots()
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })

  test('tool rules stay fully injected when availableToolNames is not provided (legacy paths)', () => {
    const builder = new PromptBuilder(null, null)
    const prompt = builder.build(
      resolve(import.meta.dir, '..'),
      { workspaceDir: resolve(import.meta.dir, '..') } as AgentConfig,
      {
        agentId: 'default',
        chatId: 'web:chat-legacy',
      },
    )

    expect(prompt).toContain('## Document Handling Rule')
    expect(prompt).toContain('## Scheduled Task Rule')
    expect(prompt).toContain('## Skill Self-Service Rule')
  })
})

describe('PromptBuilder bootstrap snapshots', () => {
  test('reuses injected bootstrap docs within the same chat until snapshot is cleared', () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'XiaoJuClaw-bootstrap-snapshot-'))
    try {
      writeFileSync(resolve(workspaceDir, 'AGENTS.md'), '# Agents\n')
      writeFileSync(resolve(workspaceDir, 'SOUL.md'), '# Soul\n')
      writeFileSync(resolve(workspaceDir, 'TOOLS.md'), '# Tools\n')
      writeFileSync(resolve(workspaceDir, 'IDENTITY.md'), '# Identity\n')
      writeFileSync(resolve(workspaceDir, 'USER.md'), 'alpha')
      writeFileSync(resolve(workspaceDir, 'HEARTBEAT.md'), '# Heartbeat\n')
      writeFileSync(resolve(workspaceDir, 'BOOTSTRAP.md'), '# Bootstrap\n')

      const builder = new PromptBuilder(null, null)
      const baseConfig = { workspaceDir } as AgentConfig
      const first = builder.build(workspaceDir, baseConfig, { agentId: 'a1', chatId: 'web:chat-1' })
      writeFileSync(resolve(workspaceDir, 'USER.md'), 'beta')
      const second = builder.build(workspaceDir, baseConfig, { agentId: 'a1', chatId: 'web:chat-1' })
      clearAllBootstrapSnapshots()
      const third = builder.build(workspaceDir, baseConfig, { agentId: 'a1', chatId: 'web:chat-1' })

      expect(first).toContain('alpha')
      expect(second).toContain('alpha')
      expect(second).not.toContain('beta')
      expect(third).toContain('beta')
    } finally {
      clearAllBootstrapSnapshots()
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })
})
