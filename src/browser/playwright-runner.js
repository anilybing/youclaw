// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { stdin, stdout, stderr, exit } from 'node:process'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const REF_ATTRIBUTE = 'data-XiaoJuClaw-ref'
const BROWSER_ARTIFACT_ROOT_ENV = 'XJC_BROWSER_ARTIFACT_ROOT'

function isWithin(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function expandHome(input) {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(homedir(), input.slice(2))
  }
  return input
}

function configuredArtifactRoot() {
  const explicit = process.env[BROWSER_ARTIFACT_ROOT_ENV]?.trim()
  if (explicit) return resolve(expandHome(explicit))
  const dataDir = process.env.DATA_DIR?.trim() || './data'
  return resolve(expandHome(dataDir), 'browser-artifacts')
}

function configuredDataRoot() {
  return resolve(expandHome(process.env.DATA_DIR?.trim() || './data'))
}

function assertSafeScreenshotPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('Browser screenshot requires a managed output path')
  }
  if (extname(rawPath).toLowerCase() !== '.png') {
    throw new Error('Browser screenshots must use a .png path')
  }

  const root = configuredArtifactRoot()
  const dataRoot = configuredDataRoot()
  mkdirSync(dataRoot, { recursive: true })
  const realDataRoot = realpathSync(dataRoot)
  mkdirSync(root, { recursive: true })
  const realRoot = realpathSync(root)
  if (!isWithin(realDataRoot, realRoot)) {
    throw new Error('Browser artifact root escapes the data directory through a symlink or junction')
  }
  const candidate = resolve(rawPath)
  // 先做词法检查，避免为根外路径创建父目录。
  if (!isWithin(root, candidate) && !isWithin(realRoot, candidate)) {
    throw new Error('Browser screenshot path must stay inside data/browser-artifacts')
  }

  const parent = dirname(candidate)
  mkdirSync(parent, { recursive: true })
  const realParent = realpathSync(parent)
  if (!isWithin(realRoot, realParent)) {
    throw new Error('Browser screenshot path escapes through a symlink or junction')
  }

  const safePath = resolve(realParent, basename(candidate))
  if (existsSync(safePath)) {
    const existing = lstatSync(safePath)
    if (existing.isSymbolicLink()) {
      throw new Error('Browser screenshot target cannot be a symlink or junction')
    }
    // MCP 总是生成随机新文件；拒绝覆盖也封住预创建链接与竞态窗口。
    throw new Error('Browser screenshot target already exists')
  }
  return safePath
}

function isBlockedHostname(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) return true
  return ['.local', '.localdomain', '.lan', '.home', '.home.arpa', '.internal']
    .some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

function parseIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
  return octets.some((part) => part > 255) ? null : octets
}

function isBlockedIpv4([a, b, c]) {
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function extractMappedIpv4(host) {
  const prefix = ['::ffff:0:', '64:ff9b::', '::ffff:'].find((candidate) => host.startsWith(candidate))
  if (!prefix) return null
  const rest = host.slice(prefix.length)
  const dotted = parseIpv4(rest)
  if (dotted) return dotted
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (!hex) return null
  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]
}

function isBlockedIpv6(host) {
  if (host === '::' || host === '::1') return true
  const mapped = extractMappedIpv4(host)
  if (mapped && isBlockedIpv4(mapped)) return true
  const firstGroup = host.split(':')[0] ?? ''
  const first = firstGroup === '' ? 0 : Number.parseInt(firstGroup, 16)
  return (first & 0xff00) === 0xff00
    || (first >= 0xfc00 && first <= 0xfdff)
    || (first >= 0xfe80 && first <= 0xfebf)
    || host === '2001:db8::'
    || host.startsWith('2001:db8:')
}

function assertSafeNavigationUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid browser navigation URL: ${rawUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Browser navigation only allows http/https URLs; rejected ${parsed.protocol}`)
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host) throw new Error('Browser navigation URL is missing a host')
  const ipv4 = parseIpv4(host)
  if (ipv4 && isBlockedIpv4(ipv4)) {
    throw new Error(`Browser navigation to private/reserved address is blocked: ${host}`)
  }
  if (host.includes(':') && isBlockedIpv6(host)) {
    throw new Error(`Browser navigation to private/reserved address is blocked: ${host}`)
  }
  if (!ipv4 && !host.includes(':') && isBlockedHostname(host)) {
    throw new Error(`Browser navigation to local/private host is blocked: ${host}`)
  }
  return parsed.href
}

async function gotoSafely(page, rawUrl) {
  const initialUrl = assertSafeNavigationUrl(rawUrl)
  let blockedError = null
  const guard = async (route) => {
    const request = route.request()
    const requestUrl = request.url()
    try {
      if (request.isNavigationRequest() || /^https?:/i.test(requestUrl)) {
        assertSafeNavigationUrl(requestUrl)
      }
      await route.continue()
    } catch (err) {
      blockedError ??= err
      await route.abort('blockedbyclient').catch(() => {})
    }
  }

  await page.route('**/*', guard)
  try {
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded' })
  } catch (err) {
    if (blockedError) throw blockedError
    throw err
  } finally {
    await page.unroute('**/*', guard).catch(() => {})
  }
  if (blockedError) throw blockedError
}

function isLoopback(endpoint) {
  try {
    const url = new URL(endpoint)
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function ensureNoProxy(endpoint) {
  if (!isLoopback(endpoint)) return
  const loopback = 'localhost,127.0.0.1,[::1]'
  const current = process.env.NO_PROXY || process.env.no_proxy || ''
  const next = current ? `${current},${loopback}` : loopback
  process.env.NO_PROXY = next
  process.env.no_proxy = next
}

async function readStdin() {
  const chunks = []
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function resolvePage(browser, activePageUrl, createIfMissing = true) {
  const contexts = browser.contexts()
  const pages = contexts.flatMap((context) => context.pages().map((page) => ({ context, page })))

  if (activePageUrl) {
    const exact = pages.find(({ page }) => !page.isClosed() && page.url() === activePageUrl)
    if (exact) return exact
  }

  const firstNavigated = pages.find(({ page }) => !page.isClosed() && page.url() && page.url() !== 'about:blank')
  if (firstNavigated) return firstNavigated

  const first = pages.find(({ page }) => !page.isClosed())
  if (first) return first

  if (!createIfMissing) return null

  const context = contexts[0]
  if (!context) {
    throw new Error('No browser context is available over CDP')
  }
  const page = await context.newPage()
  return { context, page }
}

async function captureSnapshot(page) {
  return page.evaluate((refAttribute) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
    const truncate = (value, limit = 120) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value
    const isVisible = (element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const readLabel = (element) => {
      const ariaLabel = normalize(element.getAttribute('aria-label'))
      if (ariaLabel) return ariaLabel

      const labelledBy = normalize(element.getAttribute('aria-labelledby'))
      if (labelledBy) {
        const labelText = labelledBy
          .split(/\s+/)
          .map((id) => normalize(document.getElementById(id)?.textContent))
          .filter(Boolean)
          .join(' ')
        if (labelText) return truncate(labelText)
      }

      if ('labels' in element && element.labels?.length) {
        const text = Array.from(element.labels)
          .map((label) => normalize(label.textContent))
          .filter(Boolean)
          .join(' ')
        if (text) return truncate(text)
      }

      const id = normalize(element.id)
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`)
        const text = normalize(label?.textContent)
        if (text) return truncate(text)
      }

      return ''
    }

    document.querySelectorAll(`[${refAttribute}]`).forEach((element) => {
      element.removeAttribute(refAttribute)
    })

    const selector = [
      'a',
      'button',
      'input',
      'textarea',
      'select',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="textbox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[contenteditable="true"]',
    ].join(',')

    const refs = []
    const elements = Array.from(document.querySelectorAll(selector))
      .filter((element) => isVisible(element))
      .slice(0, 80)

    for (const [index, element] of elements.entries()) {
      const ref = String(index + 1)
      element.setAttribute(refAttribute, ref)

      const text = truncate(normalize(element.innerText || element.textContent))
      const label = truncate(readLabel(element))
      const placeholder = truncate(normalize(element.getAttribute('placeholder')))
      const role = normalize(element.getAttribute('role'))
      const type = 'type' in element ? normalize(element.type) : ''
      const value = 'value' in element ? truncate(normalize(element.value)) : ''

      refs.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role: role || undefined,
        type: type || undefined,
        label: label || undefined,
        text: text || undefined,
        placeholder: placeholder || undefined,
        value: value || undefined,
      })
    }

    return {
      text: normalize(document.body?.innerText || '').slice(0, 4000),
      refs,
    }
  }, REF_ATTRIBUTE)
}

async function main() {
  const raw = await readStdin()
  const input = raw ? JSON.parse(raw) : {}
  if ((input.action === 'open_tab' && input.url) || input.action === 'navigate') {
    input.url = assertSafeNavigationUrl(input.url)
  }
  if (input.action === 'screenshot') {
    input.path = assertSafeScreenshotPath(input.path)
  }
  ensureNoProxy(input.endpoint)

  const browser = await chromium.connectOverCDP(input.endpoint)
  try {
    switch (input.action) {
      case 'open_tab': {
        const context = browser.contexts()[0]
        if (!context) throw new Error('No browser context is available over CDP')
        const page = await context.newPage()
        if (input.url) {
          await gotoSafely(page, input.url)
        }
        stdout.write(JSON.stringify({
          url: page.url(),
          title: await page.title().catch(() => ''),
        }))
        break
      }
      case 'navigate': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        await gotoSafely(resolved.page, input.url)
        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
        }))
        break
      }
      case 'snapshot': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        const snapshot = await captureSnapshot(resolved.page)
        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
          text: snapshot.text,
          refs: snapshot.refs,
        }))
        break
      }
      case 'act': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        const locator = resolved.page.locator(`[${REF_ATTRIBUTE}="${input.ref}"]`).first()
        if (await locator.count() === 0) {
          throw new Error(`Ref ${input.ref} is not available. Capture a fresh snapshot first.`)
        }

        switch (input.interaction) {
          case 'click':
            await locator.click()
            break
          case 'type':
            if (typeof input.text !== 'string') {
              throw new Error('Act type requires text')
            }
            await locator.fill(input.text)
            break
          case 'select':
            if (typeof input.option !== 'string') {
              throw new Error('Act select requires option')
            }
            try {
              await locator.selectOption({ label: input.option })
            } catch {
              await locator.selectOption({ value: input.option })
            }
            break
          case 'check':
            await locator.check()
            break
          case 'uncheck':
            await locator.uncheck()
            break
          default:
            throw new Error(`Unsupported act interaction: ${input.interaction}`)
        }

        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
        }))
        break
      }
      case 'screenshot': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        await resolved.page.screenshot({ path: input.path, fullPage: true })
        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
          path: input.path,
        }))
        break
      }
      case 'click': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        await resolved.page.locator(input.selector).first().click()
        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
        }))
        break
      }
      case 'type': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        await resolved.page.locator(input.selector).first().fill(input.text)
        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
        }))
        break
      }
      case 'press_key': {
        const resolved = await resolvePage(browser, input.activePageUrl)
        await resolved.page.keyboard.press(input.key)
        stdout.write(JSON.stringify({
          url: resolved.page.url(),
          title: await resolved.page.title().catch(() => ''),
        }))
        break
      }
      case 'close_tab': {
        const target = await resolvePage(browser, input.url || input.activePageUrl, false)
        if (!target) {
          stdout.write(JSON.stringify({ closed: false }))
          break
        }
        await target.page.close()
        const next = await resolvePage(browser, null, false)
        stdout.write(JSON.stringify({
          closed: true,
          url: next?.page.url() ?? null,
          title: next ? await next.page.title().catch(() => '') : null,
        }))
        break
      }
      default:
        throw new Error(`Unsupported browser action: ${input.action}`)
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((err) => {
  stderr.write(err instanceof Error ? err.stack || err.message : String(err))
  exit(1)
})
