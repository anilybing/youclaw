// [XJC] T-A3 视觉：附件图片转 base64 纯函数单测
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { hydratePromptImageAttachments } from '../src/agent/runtime.ts'

const tempDir = resolve(tmpdir(), `xjc-prompt-images-${Date.now()}`)
mkdirSync(tempDir, { recursive: true })

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function createImageFile(name: string, bytes: number): string {
  const filePath = resolve(tempDir, name)
  writeFileSync(filePath, Buffer.alloc(bytes, 7))
  return filePath
}

describe('hydratePromptImageAttachments', () => {
  test('returns input unchanged when attachments are missing or empty', () => {
    expect(hydratePromptImageAttachments(undefined)).toBeUndefined()
    expect(hydratePromptImageAttachments([])).toEqual([])
  })

  test('fills base64 data for image attachments with a readable filePath', () => {
    const filePath = createImageFile('small.png', 16)
    const result = hydratePromptImageAttachments([
      { filename: 'small.png', mediaType: 'image/png', filePath },
    ])!

    expect(result[0]!.data).toBe(Buffer.alloc(16, 7).toString('base64'))
  })

  test('leaves non-image attachments untouched', () => {
    const filePath = createImageFile('notes.txt', 8)
    const attachment = { filename: 'notes.txt', mediaType: 'text/plain', filePath }
    const result = hydratePromptImageAttachments([attachment])!

    expect(result[0]).toBe(attachment)
    expect(result[0]!.data).toBeUndefined()
  })

  test('skips images above the size limit and warns', () => {
    const filePath = createImageFile('big.png', 64)
    const warnings: string[] = []
    const result = hydratePromptImageAttachments(
      [{ filename: 'big.png', mediaType: 'image/png', filePath }],
      { maxBytes: 32, warn: (_ctx, message) => warnings.push(message) },
    )!

    expect(result[0]!.data).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('size limit')
  })

  test('caps the number of hydrated images and warns for the overflow', () => {
    const attachments = [1, 2, 3].map((i) => ({
      filename: `img-${i}.png`,
      mediaType: 'image/png',
      filePath: createImageFile(`img-${i}.png`, 8),
    }))
    const warnings: string[] = []
    const result = hydratePromptImageAttachments(attachments, {
      maxCount: 2,
      warn: (_ctx, message) => warnings.push(message),
    })!

    expect(result[0]!.data).toBeDefined()
    expect(result[1]!.data).toBeDefined()
    expect(result[2]!.data).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('too many image attachments')
  })

  test('counts already-hydrated images toward the cap and keeps their data', () => {
    const filePath = createImageFile('second.png', 8)
    const result = hydratePromptImageAttachments(
      [
        { filename: 'first.png', mediaType: 'image/png', data: 'AAAA' },
        { filename: 'second.png', mediaType: 'image/png', filePath },
      ],
      { maxCount: 1 },
    )!

    expect(result[0]!.data).toBe('AAAA')
    expect(result[1]!.data).toBeUndefined()
  })

  test('skips unreadable files without throwing and warns', () => {
    const warnings: string[] = []
    const result = hydratePromptImageAttachments(
      [{ filename: 'gone.png', mediaType: 'image/png', filePath: resolve(tempDir, 'does-not-exist.png') }],
      { warn: (_ctx, message) => warnings.push(message) },
    )!

    expect(result[0]!.data).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('failed to read')
  })
})
