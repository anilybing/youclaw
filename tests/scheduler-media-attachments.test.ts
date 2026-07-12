/**
 * [XJC] 定时任务媒体产物内联展示测试（scheduler media attachments）
 *
 * 覆盖：
 * - mediaTypeForPath：图片/视频扩展名映射（大小写不敏感）、非媒体返回 null
 * - mediaAttachmentFromPath：真实图片 → Attachment；非媒体/缺失 → null
 * - buildTaskMediaAttachments：工作区内媒体保留、非媒体/工作区外/缺失剔除、顺序、上限
 * - saveTaskMessages / executeTask / runManually：把工作区内图片/视频写入 messages.attachments，
 *   正文仍保留 📎 行不变；非媒体或纯文本不写结构化附件（保持旧行为）
 */

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanTables } from './setup.ts'
import { createTask, getTask, getMessages } from '../src/db/index.ts'
import { Scheduler } from '../src/scheduler/scheduler.ts'
import { getPaths } from '../src/config/index.ts'
import { MAX_TASK_ATTACHMENTS } from '../src/scheduler/attachments.ts'
import {
  buildTaskMediaAttachments,
  mediaAttachmentFromPath,
  mediaTypeForPath,
} from '../src/scheduler/media-attachments.ts'
import type { Attachment } from '../src/types/attachment.ts'

const mockEventBus = { emit: mock(() => {}) } as any

// ===== mediaTypeForPath =====

describe('mediaTypeForPath', () => {
  test('maps image/video extensions (case-insensitive)', () => {
    expect(mediaTypeForPath('a.png')).toBe('image/png')
    expect(mediaTypeForPath('a.JPG')).toBe('image/jpeg')
    expect(mediaTypeForPath('a.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForPath('a.webp')).toBe('image/webp')
    expect(mediaTypeForPath('a.gif')).toBe('image/gif')
    expect(mediaTypeForPath('a.mp4')).toBe('video/mp4')
    expect(mediaTypeForPath('a.WEBM')).toBe('video/webm')
    expect(mediaTypeForPath('a.mov')).toBe('video/quicktime')
  })

  test('returns null for non-media / missing extensions', () => {
    expect(mediaTypeForPath('a.pptx')).toBeNull()
    expect(mediaTypeForPath('a.xlsx')).toBeNull()
    expect(mediaTypeForPath('a.txt')).toBeNull()
    expect(mediaTypeForPath('a.html')).toBeNull()
    expect(mediaTypeForPath('noext')).toBeNull()
  })
})

// ===== mediaAttachmentFromPath =====

describe('mediaAttachmentFromPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xjc-sched-media-single-'))
  const png = resolve(dir, 'a.png'); writeFileSync(png, 'x')
  const txt = resolve(dir, 'a.txt'); writeFileSync(txt, 'x')

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('builds an image attachment for an existing image file', () => {
    const att = mediaAttachmentFromPath(png)
    expect(att).not.toBeNull()
    expect(att?.mediaType).toBe('image/png')
    expect(att?.filename).toBe('a.png')
    expect(att?.filePath).toBe(realpathSync(png))
  })

  test('returns null for a non-media extension', () => {
    expect(mediaAttachmentFromPath(txt)).toBeNull()
  })

  test('returns null for a missing file', () => {
    expect(mediaAttachmentFromPath(resolve(dir, 'missing.png'))).toBeNull()
  })
})

// ===== buildTaskMediaAttachments =====

describe('buildTaskMediaAttachments', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'xjc-sched-media-'))
  const workspaceDir = resolve(baseDir, 'agents', 'agent-1')
  mkdirSync(workspaceDir, { recursive: true })
  const png = resolve(workspaceDir, 'img.png'); writeFileSync(png, 'x')
  const mp4 = resolve(workspaceDir, 'clip.mp4'); writeFileSync(mp4, 'x')
  const pptx = resolve(workspaceDir, 'report.pptx'); writeFileSync(pptx, 'x')
  const outsidePng = resolve(baseDir, 'outside.png'); writeFileSync(outsidePng, 'x')

  afterAll(() => rmSync(baseDir, { recursive: true, force: true }))

  test('image inside the workspace → one image attachment', () => {
    const list = buildTaskMediaAttachments([png], workspaceDir)
    expect(list).toEqual([{ filename: 'img.png', mediaType: 'image/png', filePath: realpathSync(png) }])
  })

  test('video inside the workspace → one video attachment', () => {
    const list = buildTaskMediaAttachments([mp4], workspaceDir)
    expect(list).toEqual([{ filename: 'clip.mp4', mediaType: 'video/mp4', filePath: realpathSync(mp4) }])
  })

  test('non-media file (pptx) inside the workspace is skipped', () => {
    expect(buildTaskMediaAttachments([pptx], workspaceDir)).toEqual([])
  })

  test('media file outside the workspace is skipped', () => {
    expect(buildTaskMediaAttachments([outsidePng], workspaceDir)).toEqual([])
  })

  test('nonexistent media path is skipped', () => {
    expect(buildTaskMediaAttachments([resolve(workspaceDir, 'missing.png')], workspaceDir)).toEqual([])
  })

  test('mixed list keeps only workspace media, preserving order', () => {
    const list = buildTaskMediaAttachments([pptx, png, outsidePng, mp4], workspaceDir)
    expect(list.map((a) => a.filename)).toEqual(['img.png', 'clip.mp4'])
    expect(list.map((a) => a.mediaType)).toEqual(['image/png', 'video/mp4'])
  })

  test('empty input returns empty output', () => {
    expect(buildTaskMediaAttachments([], workspaceDir)).toEqual([])
  })

  test(`caps the result at MAX_TASK_ATTACHMENTS (${MAX_TASK_ATTACHMENTS})`, () => {
    const many: string[] = []
    for (let i = 1; i <= MAX_TASK_ATTACHMENTS + 1; i++) {
      const p = resolve(workspaceDir, `m${i}.png`)
      writeFileSync(p, 'x')
      many.push(p)
    }
    const list = buildTaskMediaAttachments(many, workspaceDir)
    expect(list.length).toBe(MAX_TASK_ATTACHMENTS)
    expect(list[0].filename).toBe('m1.png')
    expect(list[MAX_TASK_ATTACHMENTS - 1].filename).toBe(`m${MAX_TASK_ATTACHMENTS}.png`)
  })
})

// ===== integration: saveTaskMessages writes messages.attachments =====

/** Create a real file inside the (test DATA_DIR sandboxed) agent workspace; returns its absolute path. */
function createAgentWorkspaceFile(agentId: string, fileName: string): string {
  const dir = resolve(getPaths().agents, agentId)
  mkdirSync(dir, { recursive: true })
  const filePath = resolve(dir, fileName)
  writeFileSync(filePath, 'attachment content')
  return filePath
}

describe('Scheduler.saveTaskMessages — structured media attachments in messages.attachments', () => {
  beforeEach(() => cleanTables('messages', 'chats', 'scheduled_tasks', 'task_run_logs'))

  /** Run a scheduled task (non-push, so delivery is skipped) whose enqueue resolves to `result`. */
  function runTask(id: string, agentId: string, result: string): Promise<void> {
    createTask({
      id,
      agentId,
      chatId: `task:${id}`,
      prompt: 'generate media',
      scheduleType: 'interval',
      scheduleValue: '60000',
      nextRun: new Date(Date.now() - 1000).toISOString(),
      name: 'Media Task',
    })
    const mockQueue = { enqueue: mock(() => Promise.resolve(result)) } as any
    const scheduler = new Scheduler(mockQueue, {} as any, mockEventBus)
    return scheduler.executeTask(getTask(id)!)
  }

  function botMessage(chatId: string) {
    return getMessages(chatId, 10).find((m) => m.is_bot_message === 1)!
  }

  test('image attachment → bot message.attachments populated; content keeps 📎 line, no raw marker', async () => {
    const png = createAgentWorkspaceFile('agent-media', 'poster.png')
    await runTask('media-img', 'agent-media', `海报已生成。\n[[attach:${png}]]`)

    const botMsg = botMessage('task:media-img')
    expect(botMsg.attachments).not.toBeNull()
    const list = JSON.parse(botMsg.attachments!) as Attachment[]
    expect(list.length).toBe(1)
    expect(list[0].mediaType).toBe('image/png')
    expect(list[0].filename).toBe('poster.png')
    expect(list[0].filePath.endsWith('poster.png')).toBe(true)

    // 正文口径不变：保留 📎 行、含正文、不暴露内部标记
    expect(botMsg.content).toContain('📎 ' + png)
    expect(botMsg.content).toContain('海报已生成。')
    expect(botMsg.content).not.toContain('[[attach')
  })

  test('image + video → two attachments written in order', async () => {
    const png = createAgentWorkspaceFile('agent-media', 'a.png')
    const mp4 = createAgentWorkspaceFile('agent-media', 'b.mp4')
    await runTask('media-two', 'agent-media', `产出：\n[[attach:${png}]]\n[[attach:${mp4}]]`)

    const list = JSON.parse(botMessage('task:media-two').attachments!) as Attachment[]
    expect(list.map((a) => a.filename)).toEqual(['a.png', 'b.mp4'])
    expect(list.map((a) => a.mediaType)).toEqual(['image/png', 'video/mp4'])
  })

  test('non-media attachment (pptx) → attachments stays null, 📎 line kept', async () => {
    const pptx = createAgentWorkspaceFile('agent-media', 'report.pptx')
    await runTask('media-doc', 'agent-media', `报告已生成。\n[[attach:${pptx}]]`)

    const botMsg = botMessage('task:media-doc')
    expect(botMsg.attachments).toBeNull()
    expect(botMsg.content).toContain('📎 ' + pptx)
  })

  test('media file outside the agent workspace → attachments stays null', async () => {
    const outside = resolve(getPaths().data, 'stray.png')
    writeFileSync(outside, 'x')
    await runTask('media-outside', 'agent-media', `图片\n[[attach:${outside}]]`)

    expect(botMessage('task:media-outside').attachments).toBeNull()
  })

  test('plain-text result → attachments null (unchanged legacy behavior)', async () => {
    await runTask('media-plain', 'agent-media', '纯文本结果，无附件')

    const botMsg = botMessage('task:media-plain')
    expect(botMsg.attachments).toBeNull()
    expect(botMsg.content).toBe('纯文本结果，无附件')
  })

  test('runManually also persists structured media attachments', async () => {
    const png = createAgentWorkspaceFile('agent-media', 'manual.png')
    createTask({
      id: 'media-manual',
      agentId: 'agent-media',
      chatId: 'task:media-manual',
      prompt: 'manual media',
      scheduleType: 'interval',
      scheduleValue: '60000',
      nextRun: new Date(Date.now() + 60000).toISOString(),
    })
    const mockQueue = { enqueue: mock(() => Promise.resolve(`手动结果\n[[attach:${png}]]`)) } as any
    const scheduler = new Scheduler(mockQueue, {} as any, mockEventBus)

    await scheduler.runManually(getTask('media-manual')!)

    const list = JSON.parse(botMessage('task:media-manual').attachments!) as Attachment[]
    expect(list.length).toBe(1)
    expect(list[0].filename).toBe('manual.png')
    expect(list[0].mediaType).toBe('image/png')
  })
})
