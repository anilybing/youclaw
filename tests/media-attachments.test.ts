// [XJC] 生成媒体内联展示：校验 tool_execution_end 产物 → 消息附件的采集与防御逻辑。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMediaTool, mediaAttachmentFromToolResult } from '../src/agent/media-attachments.ts'

function toolResult(saved: string): { content: Array<{ type: string; text: string }>; details: Record<string, never> } {
  return { content: [{ type: 'text', text: JSON.stringify({ saved, note: 'ok' }) }], details: {} }
}

describe('media attachment collection', () => {
  let dir: string
  let png: string
  let mp4: string
  let txt: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'xjc-media-att-'))
    png = join(dir, 'img_1.png'); writeFileSync(png, 'x')
    mp4 = join(dir, 'video_1.mp4'); writeFileSync(mp4, 'x')
    txt = join(dir, 'note.txt'); writeFileSync(txt, 'x')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('isMediaTool recognizes only the built-in media tools', () => {
    expect(isMediaTool('mcp__media__generate_image')).toBe(true)
    expect(isMediaTool('mcp__media__edit_image')).toBe(true)
    expect(isMediaTool('mcp__media__generate_video')).toBe(true)
    expect(isMediaTool('Bash')).toBe(false)
    expect(isMediaTool('mcp__knowledge__search')).toBe(false)
  })

  test('builds an image attachment from a generate_image result', () => {
    const att = mediaAttachmentFromToolResult('mcp__media__generate_image', toolResult(png), false)
    expect(att).not.toBeNull()
    expect(att?.mediaType).toBe('image/png')
    expect(att?.filename).toBe('img_1.png')
    expect(att?.filePath.endsWith('img_1.png')).toBe(true)
  })

  test('builds a video attachment from a generate_video result', () => {
    const att = mediaAttachmentFromToolResult('mcp__media__generate_video', toolResult(mp4), false)
    expect(att?.mediaType).toBe('video/mp4')
    expect(att?.filename).toBe('video_1.mp4')
  })

  test('rejects errored calls, non-media tools, missing files, unknown types, and missing saved path', () => {
    expect(mediaAttachmentFromToolResult('mcp__media__generate_image', toolResult(png), true)).toBeNull()
    expect(mediaAttachmentFromToolResult('Bash', toolResult(png), false)).toBeNull()
    expect(mediaAttachmentFromToolResult('mcp__media__generate_image', toolResult(join(dir, 'missing.png')), false)).toBeNull()
    expect(mediaAttachmentFromToolResult('mcp__media__generate_image', toolResult(txt), false)).toBeNull()
    expect(mediaAttachmentFromToolResult('mcp__media__generate_image', { content: [{ type: 'text', text: 'not json' }] }, false)).toBeNull()
    expect(mediaAttachmentFromToolResult('mcp__media__generate_image', {}, false)).toBeNull()
  })
})
