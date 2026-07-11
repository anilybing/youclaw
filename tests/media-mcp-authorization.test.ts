// [XJC] Media tools enforce billed-call authorization independently of model compliance.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createMediaTools } from '../src/agent/media-mcp.ts'
import { getMediaService } from '../src/media/service.ts'

const tempRoots: string[] = []

function workspace(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'xjc-media-tool-auth-'))
  tempRoots.push(root)
  return root
}

function toolByName(name: string, authorization: {
  allowGenerateImage: boolean
  allowEditImage: boolean
  allowGenerateVideo: boolean
}) {
  return createMediaTools({
    agentId: 'default',
    workspaceDir: workspace(),
    attachmentPaths: [],
    authorization: { ...authorization, reason: 'test' },
  }).find((tool) => tool.name === name)!
}

async function execute(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return (tool.execute as any)('call-1', args, new AbortController().signal, () => {})
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('media MCP execution authorization', () => {
  test('denies image generation without explicit current-turn authorization and preserves error code', async () => {
    const tool = toolByName('mcp__media__generate_image', {
      allowGenerateImage: false,
      allowEditImage: false,
      allowGenerateVideo: false,
    })

    await expect(execute(tool, { prompt: 'cat' }))
      .rejects.toThrow('MEDIA_AUTHORIZATION_REQUIRED')
  })

  test('allows one image provider call and blocks a second call in the same turn', async () => {
    const service = getMediaService()
    const original = service.generateImage
    let providerCalls = 0
    service.generateImage = (async () => {
      providerCalls += 1
      return { filePath: 'C:\\media\\generated.png', filename: 'generated.png' }
    }) as typeof service.generateImage
    try {
      const tool = toolByName('mcp__media__generate_image', {
        allowGenerateImage: true,
        allowEditImage: false,
        allowGenerateVideo: false,
      })
      await execute(tool, { prompt: 'cat' })
      await expect(execute(tool, { prompt: 'another cat' }))
        .rejects.toThrow('MEDIA_CALL_LIMIT')
      expect(providerCalls).toBe(1)
    } finally {
      service.generateImage = original
    }
  })

  test('video tool cannot execute from prompt compliance alone', async () => {
    const tool = toolByName('mcp__media__generate_video', {
      allowGenerateImage: false,
      allowEditImage: false,
      allowGenerateVideo: false,
    })

    await expect(execute(tool, { prompt: 'five second video' }))
      .rejects.toThrow('MEDIA_AUTHORIZATION_REQUIRED')
  })
})
