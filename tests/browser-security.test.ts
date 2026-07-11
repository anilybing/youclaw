import { describe, expect, test } from 'bun:test'
import './setup.ts'
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { getPaths } from '../src/config/paths.ts'
import {
  assertSafeBrowserNavigationUrl,
  createBrowserMcpServer,
  createBrowserScreenshotPath,
  resolveSafeBrowserNavigationUrl,
} from '../src/browser/mcp.ts'

function browserTools() {
  return createBrowserMcpServer({
    browserManager: { getProfile: () => null } as any,
    chatId: 'browser-security-chat',
    agentId: 'browser-security-agent',
    profileId: 'browser-security-profile',
    target: 'host',
  })
}

async function runStandaloneRunner(payload: Record<string, unknown>) {
  const runner = resolve(process.cwd(), 'src', 'browser', 'playwright-runner.js')
  const child = Bun.spawn(['node', runner], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      DATA_DIR: getPaths().data,
    },
  })
  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])
  return { exitCode, stderr }
}

describe('browser navigation security', () => {
  test('only allows public http/https URLs', () => {
    expect(assertSafeBrowserNavigationUrl('https://example.com/path')).toBe('https://example.com/path')
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings/',
      'data:text/html,<h1>x</h1>',
      'javascript:alert(1)',
      'http://127.0.0.1:3000/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(() => assertSafeBrowserNavigationUrl(url)).toThrow(/blocked/i)
    }
  })

  test('DNS preflight rejects mixed public/private answers before navigation', async () => {
    await expect(resolveSafeBrowserNavigationUrl(
      'https://browser.example/page',
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    )).rejects.toThrow('内网/保留')

    await expect(resolveSafeBrowserNavigationUrl(
      'https://browser.example/page',
      async () => [{ address: '93.184.216.34', family: 4 }],
    )).resolves.toBe('https://browser.example/page')
  })

  test('MCP rejects file URLs before invoking the browser router', async () => {
    const navigate = browserTools().find((tool) => tool.name === 'mcp__browser__navigate')!
    await expect(
      navigate.execute('tool-1', { url: 'file:///C:/Windows/win.ini' } as never),
    ).rejects.toThrow(/http\/https/)
  })

  test('standalone runner rejects unsafe navigation before connecting to CDP', async () => {
    const result = await runStandaloneRunner({
      endpoint: 'http://127.0.0.1:1',
      action: 'navigate',
      url: 'file:///etc/passwd',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('only allows http/https')
    expect(result.stderr).not.toContain('ECONNREFUSED')
  })
})

describe('browser screenshot path security', () => {
  test('MCP rejects caller-controlled screenshot paths', async () => {
    const screenshot = browserTools().find((tool) => tool.name === 'mcp__browser__screenshot')!
    const outside = resolve(getPaths().data, '..', 'stolen.png')
    await expect(
      screenshot.execute('tool-2', { path: outside } as never),
    ).rejects.toThrow(/cannot be provided/)
  })

  test('generated screenshot path stays under the managed per-chat directory', () => {
    const output = createBrowserScreenshotPath('browser-safe-chat')
    const root = realpathSync(resolve(getPaths().data, 'browser-artifacts'))
    const rel = relative(root, output)
    expect(rel.startsWith('..') || isAbsolute(rel)).toBe(false)
    expect(output.endsWith('.png')).toBe(true)
  })

  test('rejects a per-chat directory replaced by a symlink or junction', () => {
    const chatId = `browser-link-escape-${Date.now()}`
    const firstPath = createBrowserScreenshotPath(chatId)
    const chatDir = dirname(firstPath)
    const outside = resolve(getPaths().data, `browser-artifacts-outside-${Date.now()}`)
    rmSync(chatDir, { recursive: true, force: true })
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, chatDir, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => createBrowserScreenshotPath(chatId)).toThrow(/symlink|junction/)
    } finally {
      rmSync(chatDir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('standalone runner rejects arbitrary screenshot paths before CDP access', async () => {
    const outside = resolve(getPaths().data, '..', 'arbitrary-browser-shot.png')
    const result = await runStandaloneRunner({
      endpoint: 'http://127.0.0.1:1',
      action: 'screenshot',
      path: outside,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('must stay inside data/browser-artifacts')
    expect(result.stderr).not.toContain('ECONNREFUSED')
  })
})
