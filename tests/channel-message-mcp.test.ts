import '../tests/setup-light.ts'
import { describe, test, expect, mock, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMessageTool } from '../src/agent/message-mcp.ts'
import { registerChannelOutboundService, resetChannelOutboundService } from '../src/channel/outbound-service.ts'
import { getPaths } from '../src/config/index.ts'
import type { Channel } from '../src/channel/types.ts'

const AGENT_ID = 'agent-msg-mcp'

/** Create the agent workspace dir (agents/<agentId>/) and return its absolute path. */
function ensureWorkspace(agentId: string): string {
  const dir = resolve(getPaths().agents, agentId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Create a real file inside the agent workspace; returns its absolute path. */
function workspaceFile(agentId: string, name: string): string {
  const dir = ensureWorkspace(agentId)
  const p = resolve(dir, name)
  writeFileSync(p, 'content')
  return p
}

function registerFakeChannel() {
  const sendMedia = mock(async () => {})
  const sendMessage = mock(async () => {})
  const channel: Channel = {
    name: 'fake',
    connect: async () => {},
    isConnected: () => true,
    ownsChatId: () => true,
    disconnect: async () => {},
    sendMessage,
    sendMedia,
  }
  registerChannelOutboundService({ getChannelForChat: () => channel } as any)
  return { sendMedia, sendMessage }
}

afterEach(() => resetChannelOutboundService())

describe('send_to_current_chat — outbound media workspace boundary', () => {
  test('local media inside the agent workspace is allowed and dispatched', async () => {
    const file = workspaceFile(AGENT_ID, 'report.pdf')
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('feishu:chat1', AGENT_ID)

    await tool.execute('call-1', { media: file })

    expect(sendMedia).toHaveBeenCalledTimes(1)
    expect((sendMedia.mock.calls[0] as any[])[2]).toBe(file)
  })

  test('file:// URL inside the agent workspace is allowed', async () => {
    const file = workspaceFile(AGENT_ID, 'inside.png')
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('tg:1', AGENT_ID)

    await tool.execute('call-2', { media: pathToFileURL(file).href })

    expect(sendMedia).toHaveBeenCalledTimes(1)
    expect((sendMedia.mock.calls[0] as any[])[2]).toBe(file)
  })

  test('absolute local path OUTSIDE the agent workspace is rejected and not sent', async () => {
    ensureWorkspace(AGENT_ID)
    // A sensitive file living outside agents/<agentId>/ (mimics XiaoJuClawData/secrets.json)
    const outside = resolve(getPaths().data, 'secrets.json')
    writeFileSync(outside, 'SECRET')
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('feishu:chat1', AGENT_ID)

    await expect(tool.execute('call-3', { media: outside })).rejects.toThrow('工作区')
    expect(sendMedia).not.toHaveBeenCalled()
  })

  test('a different agent\'s workspace file is rejected for this agent', async () => {
    ensureWorkspace(AGENT_ID)
    const otherFile = workspaceFile('some-other-agent', 'x.pdf')
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('feishu:chat1', AGENT_ID)

    await expect(tool.execute('call-4', { media: otherFile })).rejects.toThrow('工作区')
    expect(sendMedia).not.toHaveBeenCalled()
  })

  test('nonexistent path under the workspace is rejected and not sent', async () => {
    const dir = ensureWorkspace(AGENT_ID)
    const missing = resolve(dir, 'does-not-exist.pdf')
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('feishu:chat1', AGENT_ID)

    await expect(tool.execute('call-5', { media: missing })).rejects.toThrow()
    expect(sendMedia).not.toHaveBeenCalled()
  })

  test('remote http(s) media is NOT workspace-constrained and is dispatched', async () => {
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('tg:1', AGENT_ID)

    await tool.execute('call-6', { media: 'https://example.com/pic.png' })

    expect(sendMedia).toHaveBeenCalledTimes(1)
    expect((sendMedia.mock.calls[0] as any[])[2]).toBe('https://example.com/pic.png')
  })

  test('remote media targeting an internal/metadata address is rejected by the SSRF layer', async () => {
    const { sendMedia } = registerFakeChannel()
    const tool = createMessageTool('tg:1', AGENT_ID)

    await expect(
      tool.execute('call-7', { media: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toThrow()
    expect(sendMedia).not.toHaveBeenCalled()
  })

  test('text-only sends remain unaffected', async () => {
    const { sendMessage, sendMedia } = registerFakeChannel()
    const tool = createMessageTool('feishu:chat1', AGENT_ID)

    await tool.execute('call-8', { text: 'hello' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMedia).not.toHaveBeenCalled()
  })
})
