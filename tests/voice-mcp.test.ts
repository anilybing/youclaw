// [XJC] 录音转写 MCP 工具测试（丰富性强化）：路径守卫/未配置引导/假 ASR 服务端全链路。
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../src/config/paths.ts'
import { assertReadableAudioPath, createVoiceTools } from '../src/agent/voice-mcp.ts'

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v1/audio/transcriptions') {
      const form = await req.formData()
      const file = form.get('file') as File | null
      return Response.json({ text: `转写结果(${file?.name ?? 'unknown'})` })
    }
    return new Response('not found', { status: 404 })
  },
})

function writeAsrSettings(configured: boolean) {
  getDatabase().run(
    'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
    ['settings', JSON.stringify({
      voice: configured
        ? { asr: { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-t', model: 'fake-asr' } }
        : {},
    })],
  )
}

const attachmentsDir = resolve(getPaths().data, 'attachments')
const audioPath = resolve(attachmentsDir, 'meeting.mp3')

beforeEach(() => {
  mkdirSync(attachmentsDir, { recursive: true })
  writeFileSync(audioPath, new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])) // 假 mp3
})

afterAll(() => {
  server.stop(true)
  rmSync(audioPath, { force: true })
})

describe('assertReadableAudioPath', () => {
  test('附件目录内音频放行', () => {
    expect(assertReadableAudioPath(audioPath)).toBe(resolve(audioPath))
  })

  test('非音频扩展名拒绝', () => {
    const bad = resolve(attachmentsDir, 'notes.txt')
    writeFileSync(bad, 'x')
    expect(() => assertReadableAudioPath(bad)).toThrow(/音频/)
  })

  test('目录外文件拒绝', () => {
    const outside = resolve(getPaths().data, '..', 'outside.mp3')
    writeFileSync(outside, 'x')
    try {
      expect(() => assertReadableAudioPath(outside)).toThrow(/附件|工作区/)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('不存在的文件拒绝', () => {
    expect(() => assertReadableAudioPath(resolve(attachmentsDir, 'ghost.mp3'))).toThrow(/不存在/)
  })
})

describe('mcp__voice__transcribe_audio', () => {
  const tool = createVoiceTools()[0]!

  test('未配置 ASR：报错并引导到设置', async () => {
    writeAsrSettings(false)
    await expect(tool.execute('t', { audioPath })).rejects.toThrow(/未配置/)
  })

  test('已配置：全链路转写并带真实文件名', async () => {
    writeAsrSettings(true)
    const res = await tool.execute('t', { audioPath })
    const parsed = JSON.parse(res.content[0]!.text) as { transcript: string }
    expect(parsed.transcript).toBe('转写结果(meeting.mp3)')
  })
})
