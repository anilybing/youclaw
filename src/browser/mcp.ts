// [XJC-PATCH] 浏览器导航 SSRF 与截图落盘边界
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import {
  assertSafeRemoteAddress,
  assertSafeRemoteUrl,
} from '../channel/media-fetch.ts'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import {
  resolveValidatedRemoteAddresses,
  type RemoteLookupFn,
} from '../security/pinned-http.ts'
import type { BrowserManager } from './manager.ts'
import { createBrowserActionRouter } from './router.ts'
import type { BrowserTarget } from './types.ts'

const BROWSER_ARTIFACT_ROOT_ENV = 'XJC_BROWSER_ARTIFACT_ROOT'

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 创建只位于 data/browser-artifacts/<chat hash> 下的随机截图路径。
 * requestedPath 仅用于在工具执行边界明确拒绝旧版的任意路径参数。
 */
export function createBrowserScreenshotPath(chatId: string, requestedPath?: unknown): string {
  if (requestedPath !== undefined) {
    throw new Error('Browser screenshot path is managed by XiaoJuClaw and cannot be provided by the caller')
  }

  const dataRoot = getPaths().data
  mkdirSync(dataRoot, { recursive: true })
  const realDataRoot = realpathSync(dataRoot)
  const root = resolve(dataRoot, 'browser-artifacts')
  mkdirSync(root, { recursive: true })
  const realRoot = realpathSync(root)
  if (!isWithin(realDataRoot, realRoot)) {
    throw new Error('Browser artifact root escapes the data directory through a symlink or junction')
  }
  // 让独立 Node runner 复核同一个规范根；子进程由 sidecar 启动并继承该环境变量。
  process.env[BROWSER_ARTIFACT_ROOT_ENV] = realRoot

  const chatKey = createHash('sha256').update(chatId).digest('hex').slice(0, 32)
  const dir = resolve(realRoot, chatKey)
  mkdirSync(dir, { recursive: true })
  const realDir = realpathSync(dir)
  if (!isWithin(realRoot, realDir)) {
    throw new Error('Browser artifact directory escapes data/browser-artifacts through a symlink or junction')
  }

  return resolve(realDir, `browser-${Date.now()}-${randomUUID()}.png`)
}

/** 浏览器仅允许导航到公网 http(s) URL；默认不开放 localhost/私网例外。 */
export function assertSafeBrowserNavigationUrl(rawUrl: string): string {
  try {
    return assertSafeRemoteUrl(rawUrl).href
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Browser navigation blocked: ${detail}`)
  }
}

/**
 * Resolve every A/AAAA answer immediately before browser navigation. Chromium
 * remains the connection owner, so this is a fail-closed DNS preflight rather
 * than socket pinning; untrusted downloads use the stronger pinned transport.
 */
export async function resolveSafeBrowserNavigationUrl(
  rawUrl: string,
  lookupFn?: RemoteLookupFn,
): Promise<string> {
  const safeUrl = new URL(assertSafeBrowserNavigationUrl(rawUrl))
  try {
    await resolveValidatedRemoteAddresses(safeUrl, {
      signal: AbortSignal.timeout(5_000),
      validateAddress: assertSafeRemoteAddress,
      lookupFn,
    })
    return safeUrl.href
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Browser navigation blocked: ${detail}`)
  }
}

function createJsonTool<T extends Record<string, unknown>>(
  name: string,
  description: string,
  parameters: ToolDefinition['parameters'],
  run: (args: T) => Promise<unknown>,
  formatError: (args: T, message: string) => string,
): ToolDefinition {
  return {
    name: `mcp__browser__${name}`,
    label: `mcp__browser__${name}`,
    description,
    parameters,
    async execute(_toolCallId, args: T) {
      try {
        const result = await run(args)
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
          details: {},
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(formatError(args, msg))
      }
    },
  }
}

export function createBrowserMcpServer(params: {
  browserManager: BrowserManager
  chatId: string
  agentId: string
  profileId: string
  target: BrowserTarget
}): ToolDefinition[] {
  const { browserManager, chatId, agentId, profileId, target } = params
  const router = createBrowserActionRouter({
    browserManager,
    chatId,
    agentId,
    profileId,
    target,
  })

  return [
    createJsonTool(
      'status',
      'Get the status of the current browser profile runtime.',
      Type.Object({}),
      async () => router.getStatus(),
      (_args, message) => `Failed to get browser status: ${message}`,
    ),
    createJsonTool(
      'list_tabs',
      'List browser tabs for the current profile.',
      Type.Object({}),
      async () => router.listTabs(),
      (_args, message) => `Failed to list tabs: ${message}`,
    ),
    createJsonTool(
      'open_tab',
      'Open a new browser tab. Optionally navigate to a URL immediately.',
      Type.Object({
        url: Type.Optional(Type.String({ description: 'Optional absolute URL to open in the new tab' })),
      }),
      async (args: { url?: string }) =>
        router.openTab(args.url === undefined ? undefined : await resolveSafeBrowserNavigationUrl(args.url)),
      (_args, message) => `Failed to open tab: ${message}`,
    ),
    createJsonTool(
      'navigate',
      'Navigate the current browser tab to a URL.',
      Type.Object({
        url: Type.String({ description: 'Absolute URL to navigate to' }),
      }),
      async (args: { url: string }) => router.navigate(await resolveSafeBrowserNavigationUrl(args.url)),
      (_args, message) => `Failed to navigate: ${message}`,
    ),
    createJsonTool(
      'snapshot',
      'Capture a text snapshot of the current tab and assign refs to visible interactive elements.',
      Type.Object({}),
      async () => router.snapshot(),
      (_args, message) => `Failed to capture snapshot: ${message}`,
    ),
    createJsonTool(
      'act',
      'Interact with a visible element ref from the latest browser snapshot. Prefer this over raw CSS selectors.',
      Type.Object({
        ref: Type.String({ description: 'Element ref returned by the latest browser snapshot' }),
        action: Type.Union([
          Type.Literal('click'),
          Type.Literal('type'),
          Type.Literal('select'),
          Type.Literal('check'),
          Type.Literal('uncheck'),
        ], { description: 'Interaction to perform with the element ref' }),
        text: Type.Optional(Type.String({ description: 'Required when action is type' })),
        option: Type.Optional(Type.String({ description: 'Required when action is select; matches option label first, then value' })),
      }),
      async (args: {
        ref: string
        action: 'click' | 'type' | 'select' | 'check' | 'uncheck'
        text?: string
        option?: string
      }) => router.act(args),
      (args, message) => `Failed to act on ref ${args.ref}: ${message}`,
    ),
    createJsonTool(
      'screenshot',
      'Capture a screenshot of the current tab into the managed browser artifacts directory.',
      Type.Object({}, { additionalProperties: false }),
      async (args: Record<string, unknown>) => {
        const targetPath = createBrowserScreenshotPath(chatId, args.path)
        const result = await router.screenshot(targetPath)
        return {
          ...result,
          path: targetPath,
          filename: basename(targetPath),
        }
      },
      (_args, message) => `Failed to take screenshot: ${message}`,
    ),
    createJsonTool(
      'click',
      'Click the first DOM element matching a CSS selector in the current tab. Prefer snapshot + act when possible.',
      Type.Object({
        selector: Type.String({ description: 'CSS selector for the element to click' }),
      }),
      async (args: { selector: string }) => router.click(args.selector),
      (args, message) => `Failed to click selector ${args.selector}: ${message}`,
    ),
    createJsonTool(
      'type',
      'Fill an input or textarea identified by a CSS selector in the current tab. Prefer snapshot + act when possible.',
      Type.Object({
        selector: Type.String({ description: 'CSS selector for the input element' }),
        text: Type.String({ description: 'Text to enter into the field' }),
      }),
      async (args: { selector: string; text: string }) => router.type(args.selector, args.text),
      (args, message) => `Failed to type into selector ${args.selector}: ${message}`,
    ),
    createJsonTool(
      'press_key',
      'Send a keyboard shortcut or key to the current tab.',
      Type.Object({
        key: Type.String({ description: 'Key name accepted by Playwright, for example Enter or Meta+L' }),
      }),
      async (args: { key: string }) => router.pressKey(args.key),
      (args, message) => `Failed to press key ${args.key}: ${message}`,
    ),
    createJsonTool(
      'close_tab',
      'Close the current tab or a tab identified by URL.',
      Type.Object({
        url: Type.Optional(Type.String({ description: 'Optional exact tab URL to close' })),
      }),
      async (args: { url?: string }) => router.closeTab(args.url),
      (_args, message) => `Failed to close tab: ${message}`,
    ),
  ]
}

export function logBrowserToolRegistration(profileId: string, target: BrowserTarget): void {
  const logger = getLogger()
  logger.info({ profileId, target, category: 'browser' }, 'Built-in browser toolset registered')
}
