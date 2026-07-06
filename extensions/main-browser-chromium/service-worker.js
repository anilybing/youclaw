let pollTimer = null

const DEBUGGER_PROTOCOL_VERSION = '1.3'
const SNAPSHOT_REF_ATTRIBUTE = 'data-XiaoJuClaw-ref'
const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'edge://',
  'brave://',
  'vivaldi://',
  'arc://',
  'about:',
  'chrome-extension://',
  'devtools://',
  'view-source:',
]

function normalizeBackendUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function includesAny(message, patterns) {
  return patterns.some((pattern) => message.includes(pattern))
}

function isRestrictedDebuggerUrl(url) {
  const normalized = String(url || '').trim().toLowerCase()
  if (!normalized || normalized === 'about:blank') {
    return false
  }
  return RESTRICTED_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function isAlreadyAttachedError(error) {
  const message = toErrorMessage(error).toLowerCase()
  return includesAny(message, [
    'already attached',
    'another debugger is already attached',
  ])
}

function isDebuggerSessionMissingError(error) {
  const message = toErrorMessage(error).toLowerCase()
  return includesAny(message, [
    'not attached',
    'no target with given id',
    'cannot access a chrome:// url',
  ])
}

function isIgnorableDetachError(error) {
  const message = toErrorMessage(error).toLowerCase()
  return includesAny(message, [
    'not attached',
    'no target with given id',
    'tab not found',
    'no tab with id',
  ])
}

function parseTabId(tabId) {
  const parsed = Number(tabId)
  return Number.isFinite(parsed) ? parsed : null
}

function debuggeeForTab(tabId) {
  const numericTabId = parseTabId(tabId)
  if (numericTabId == null) {
    throw new Error('No target tab available')
  }
  return { tabId: numericTabId }
}

async function getBridgeState() {
  const stored = await chrome.storage.local.get({
    backendUrl: 'http://127.0.0.1:62601',
    bridgeProfileId: null,
    bridgeSessionToken: null,
    bridgeTabId: null,
  })
  return {
    backendUrl: normalizeBackendUrl(stored.backendUrl),
    profileId: stored.bridgeProfileId,
    sessionToken: stored.bridgeSessionToken,
    tabId: stored.bridgeTabId,
  }
}

async function setBridgeTabId(tabId) {
  await chrome.storage.local.set({
    bridgeTabId: tabId != null ? String(tabId) : null,
  })
}

async function getTabById(tabId) {
  const numericTabId = parseTabId(tabId)
  if (numericTabId == null) return null
  try {
    return await chrome.tabs.get(numericTabId)
  } catch {
    return null
  }
}

function assertDebuggableTab(tab) {
  if (!tab || tab.id == null) {
    throw new Error('No target tab available')
  }
  const url = String(tab.url || '')
  if (isRestrictedDebuggerUrl(url)) {
    throw new Error(`This tab cannot be controlled through the debugger bridge: ${url}`)
  }
}

async function detachDebugger(tabId) {
  const numericTabId = parseTabId(tabId)
  if (numericTabId == null) return
  try {
    await chrome.debugger.detach({ tabId: numericTabId })
  } catch (error) {
    if (!isIgnorableDetachError(error)) {
      throw error
    }
  }
}

async function sendDebuggerCommandRaw(tabId, method, params = {}) {
  return chrome.debugger.sendCommand(debuggeeForTab(tabId), method, params)
}

async function ensureDebuggerAttached(tabId) {
  const tab = await getTabById(tabId)
  assertDebuggableTab(tab)

  try {
    await chrome.debugger.attach(debuggeeForTab(tab.id), DEBUGGER_PROTOCOL_VERSION)
  } catch (error) {
    if (!isAlreadyAttachedError(error)) {
      throw error
    }
  }

  await sendDebuggerCommandRaw(tab.id, 'Runtime.enable').catch(() => {})
  await sendDebuggerCommandRaw(tab.id, 'Page.enable').catch(() => {})

  return tab
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  const numericTabId = parseTabId(tabId)
  if (numericTabId == null) {
    throw new Error('No target tab available')
  }

  await ensureDebuggerAttached(numericTabId)

  try {
    return await sendDebuggerCommandRaw(numericTabId, method, params)
  } catch (error) {
    if (!isDebuggerSessionMissingError(error)) {
      throw error
    }
    await ensureDebuggerAttached(numericTabId)
    return sendDebuggerCommandRaw(numericTabId, method, params)
  }
}

async function switchBridgeTab(nextTabId) {
  const numericTabId = parseTabId(nextTabId)
  if (numericTabId == null) {
    throw new Error('No target tab available')
  }

  const state = await getBridgeState()
  if (state.tabId != null && String(state.tabId) !== String(numericTabId)) {
    await detachDebugger(state.tabId).catch(() => {})
  }

  await ensureDebuggerAttached(numericTabId)
  await setBridgeTabId(numericTabId)
  return numericTabId
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const numericTabId = parseTabId(tabId)
  if (numericTabId == null) {
    throw new Error('No target tab available')
  }

  const existing = await getTabById(numericTabId)
  if (!existing) {
    throw new Error('No target tab available')
  }
  if (existing.status === 'complete') {
    return existing
  }

  return new Promise((resolve, reject) => {
    let settled = false

    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      chrome.tabs.onRemoved.removeListener(onRemoved)
      callback()
    }

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== numericTabId) return
      if (changeInfo.status === 'complete') {
        finish(() => resolve(tab))
      }
    }

    const onRemoved = (removedTabId) => {
      if (removedTabId !== numericTabId) return
      finish(() => reject(new Error('Target tab was closed before navigation completed')))
    }

    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for tab ${numericTabId} to finish loading`)))
    }, timeoutMs)

    chrome.tabs.onUpdated.addListener(onUpdated)
    chrome.tabs.onRemoved.addListener(onRemoved)
  })
}

function buildEvaluationExpression(fn, args) {
  return `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`
}

function unwrapEvaluationResult(response) {
  if (response?.exceptionDetails) {
    const message =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      response.result?.description ||
      'Runtime evaluation failed'
    throw new Error(message)
  }

  if (Object.prototype.hasOwnProperty.call(response?.result || {}, 'value')) {
    return response.result.value
  }

  if (response?.result?.unserializableValue != null) {
    return response.result.unserializableValue
  }

  return null
}

async function evaluateInTab(tabId, fn, args = []) {
  const response = await sendDebuggerCommand(tabId, 'Runtime.evaluate', {
    expression: buildEvaluationExpression(fn, args),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  })
  return unwrapEvaluationResult(response)
}

async function getPageMetadata(tabId) {
  return evaluateInTab(tabId, (runtimeTabId) => ({
    tabId: String(runtimeTabId),
    url: location.href,
    title: document.title,
  }), [String(tabId)])
}

async function dispatchClickAt(tabId, point) {
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  })
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  await sendDebuggerCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
}

async function syncBridgeSession(patch = {}) {
  const { backendUrl, profileId, sessionToken, tabId } = await getBridgeState()
  if (!backendUrl || !profileId || !sessionToken) return

  const payload = {
    profileId,
    sessionToken,
    tabId,
    ...patch,
  }

  await fetch(`${backendUrl}/api/browser/main-bridge/extension-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function executeCommand(command) {
  const tabId = command.payload?.tabId ? Number(command.payload.tabId) : undefined

  switch (command.action) {
    case 'open_tab': {
      const created = await chrome.tabs.create({ url: command.payload?.url || 'about:blank' })
      if (created.id == null) {
        throw new Error('Failed to create a new tab')
      }

      await switchBridgeTab(created.id)
      const readyTab = await waitForTabComplete(created.id).catch(() => created)

      return {
        tabId: String(created.id),
        url: readyTab?.url ?? created.url ?? '',
        title: readyTab?.title ?? created.title ?? '',
      }
    }
    case 'navigate': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for navigate')

      await ensureDebuggerAttached(targetTabId)
      const updated = await chrome.tabs.update(targetTabId, { url: command.payload?.url || 'about:blank' })
      const readyTab = updated.id != null
        ? await waitForTabComplete(updated.id).catch(() => updated)
        : updated

      return {
        tabId: updated.id != null ? String(updated.id) : null,
        url: readyTab?.url ?? updated.url ?? '',
        title: readyTab?.title ?? updated.title ?? '',
      }
    }
    case 'snapshot': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for snapshot')

      return evaluateInTab(targetTabId, (runtimeTabId, refAttribute) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim()
        const truncate = (value, limit = 160) => value.length > limit ? `${value.slice(0, limit - 3)}...` : value
        const isVisible = (element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }
        const describeLabel = (element) => {
          const ariaLabel = element.getAttribute('aria-label')
          if (ariaLabel) return normalize(ariaLabel)
          const labelledBy = element.getAttribute('aria-labelledby')
          if (labelledBy) {
            const text = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || '')
              .join(' ')
            if (text) return normalize(text)
          }
          if (element.id) {
            const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
            if (label?.textContent) return normalize(label.textContent)
          }
          const parentLabel = element.closest('label')
          return normalize(parentLabel?.textContent || '')
        }

        document.querySelectorAll(`[${refAttribute}]`).forEach((element) => element.removeAttribute(refAttribute))
        const selector = [
          'a',
          'button',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[role="textbox"]',
          '[contenteditable="true"]',
        ].join(',')

        const refs = []
        const elements = Array.from(document.querySelectorAll(selector))
          .filter((element) => isVisible(element))
          .slice(0, 80)

        for (const [index, element] of elements.entries()) {
          const ref = String(index + 1)
          element.setAttribute(refAttribute, ref)
          refs.push({
            ref,
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role') || undefined,
            type: element.getAttribute('type') || undefined,
            label: truncate(describeLabel(element)) || undefined,
            text: truncate(normalize(element.innerText || element.textContent)) || undefined,
            placeholder: truncate(normalize(element.getAttribute('placeholder'))) || undefined,
            value: truncate(normalize('value' in element ? element.value : '')) || undefined,
          })
        }

        return {
          tabId: String(runtimeTabId),
          url: location.href,
          title: document.title,
          text: normalize(document.body?.innerText || '').slice(0, 4000),
          refs,
        }
      }, [String(targetTabId), SNAPSHOT_REF_ATTRIBUTE])
    }
    case 'act': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for act')

      if (command.payload?.interaction === 'click') {
        const point = await evaluateInTab(targetTabId, (payload, refAttribute) => {
          const element = document.querySelector(`[${refAttribute}="${payload.ref}"]`)
          if (!element) {
            throw new Error(`Ref ${payload.ref} is not available. Capture a fresh snapshot first.`)
          }
          const rect = element.getBoundingClientRect()
          if (!rect.width || !rect.height) {
            throw new Error(`Ref ${payload.ref} is not visible anymore. Capture a fresh snapshot first.`)
          }
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          }
        }, [command.payload, SNAPSHOT_REF_ATTRIBUTE])

        await sendDebuggerCommand(targetTabId, 'Page.bringToFront').catch(() => {})
        await dispatchClickAt(targetTabId, point)
        return getPageMetadata(targetTabId)
      }

      return evaluateInTab(targetTabId, (payload, refAttribute, runtimeTabId) => {
        const element = document.querySelector(`[${refAttribute}="${payload.ref}"]`)
        if (!element) {
          throw new Error(`Ref ${payload.ref} is not available. Capture a fresh snapshot first.`)
        }

        const setValue = (target, value) => {
          const prototype = target.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
          if (descriptor?.set) {
            descriptor.set.call(target, value)
            return
          }
          target.value = value
        }

        switch (payload.interaction) {
          case 'type':
            if ('value' in element) {
              element.focus()
              setValue(element, payload.text || '')
              element.dispatchEvent(new Event('input', { bubbles: true }))
              element.dispatchEvent(new Event('change', { bubbles: true }))
              break
            }
            if (element.isContentEditable) {
              element.focus()
              element.textContent = payload.text || ''
              element.dispatchEvent(new Event('input', { bubbles: true }))
              break
            }
            throw new Error(`Ref ${payload.ref} does not support typing`)
          case 'select': {
            if (!(element instanceof HTMLSelectElement)) {
              throw new Error(`Ref ${payload.ref} is not a select element`)
            }
            const requested = String(payload.option || '')
            const matched = Array.from(element.options).find((option) =>
              option.label === requested || option.value === requested,
            )
            if (!matched) {
              throw new Error(`Option not found for ref ${payload.ref}: ${requested}`)
            }
            element.value = matched.value
            element.dispatchEvent(new Event('input', { bubbles: true }))
            element.dispatchEvent(new Event('change', { bubbles: true }))
            break
          }
          case 'check':
            if (!('checked' in element)) {
              throw new Error(`Ref ${payload.ref} cannot be checked`)
            }
            element.checked = true
            element.dispatchEvent(new Event('input', { bubbles: true }))
            element.dispatchEvent(new Event('change', { bubbles: true }))
            break
          case 'uncheck':
            if (!('checked' in element)) {
              throw new Error(`Ref ${payload.ref} cannot be unchecked`)
            }
            element.checked = false
            element.dispatchEvent(new Event('input', { bubbles: true }))
            element.dispatchEvent(new Event('change', { bubbles: true }))
            break
          default:
            throw new Error(`Unsupported interaction: ${payload.interaction}`)
        }

        return {
          tabId: String(runtimeTabId),
          url: location.href,
          title: document.title,
        }
      }, [command.payload, SNAPSHOT_REF_ATTRIBUTE, String(targetTabId)])
    }
    case 'click': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for click')

      const point = await evaluateInTab(targetTabId, (selector) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`Selector not found: ${selector}`)
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) {
          throw new Error(`Selector is not visible: ${selector}`)
        }
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        }
      }, [command.payload?.selector])

      await sendDebuggerCommand(targetTabId, 'Page.bringToFront').catch(() => {})
      await dispatchClickAt(targetTabId, point)
      return getPageMetadata(targetTabId)
    }
    case 'type': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for type')

      return evaluateInTab(targetTabId, (selector, text, runtimeTabId) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`Selector not found: ${selector}`)

        const setValue = (target, value) => {
          const prototype = target.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
          if (descriptor?.set) {
            descriptor.set.call(target, value)
            return
          }
          target.value = value
        }

        element.focus()
        if ('value' in element) {
          setValue(element, text || '')
          element.dispatchEvent(new Event('input', { bubbles: true }))
          element.dispatchEvent(new Event('change', { bubbles: true }))
        } else if (element.isContentEditable) {
          element.textContent = text || ''
          element.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          throw new Error(`Selector does not support typing: ${selector}`)
        }

        return {
          tabId: String(runtimeTabId),
          url: location.href,
          title: document.title,
        }
      }, [command.payload?.selector, command.payload?.text, String(targetTabId)])
    }
    case 'press_key': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for press_key')

      return evaluateInTab(targetTabId, (keySpec, runtimeTabId) => {
        const parts = String(keySpec || '')
          .split('+')
          .map((part) => part.trim())
          .filter(Boolean)
        if (parts.length === 0) {
          throw new Error('Key is required')
        }

        const mainKey = parts[parts.length - 1]
        const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()))
        const eventInit = {
          key: mainKey,
          bubbles: true,
          altKey: modifiers.has('alt') || modifiers.has('option'),
          ctrlKey: modifiers.has('control') || modifiers.has('ctrl'),
          metaKey: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
          shiftKey: modifiers.has('shift'),
        }

        const target = document.activeElement || document.body || document.documentElement
        for (const type of ['keydown', 'keyup']) {
          target.dispatchEvent(new KeyboardEvent(type, eventInit))
          document.dispatchEvent(new KeyboardEvent(type, eventInit))
        }

        return {
          tabId: String(runtimeTabId),
          url: location.href,
          title: document.title,
        }
      }, [command.payload?.key, String(targetTabId)])
    }
    case 'close_tab': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for close_tab')

      await chrome.tabs.remove(targetTabId)
      await setBridgeTabId(null)
      await detachDebugger(targetTabId).catch(() => {})
      return { closed: true, tabId: null, url: null, title: null }
    }
    case 'screenshot': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const targetTabId = tabId ?? activeTab?.id
      if (!targetTabId) throw new Error('No target tab available for screenshot')

      await sendDebuggerCommand(targetTabId, 'Page.bringToFront').catch(() => {})
      const captured = await sendDebuggerCommand(targetTabId, 'Page.captureScreenshot', {
        format: 'png',
      })
      const metadata = await getPageMetadata(targetTabId)

      return {
        tabId: metadata?.tabId ?? String(targetTabId),
        dataUrl: captured?.data ? `data:image/png;base64,${captured.data}` : null,
        url: metadata?.url ?? '',
        title: metadata?.title ?? '',
      }
    }
    default:
      throw new Error(`Unsupported browser extension command: ${command.action}`)
  }
}

async function reportCommandResult(backendUrl, profileId, commandId, payload) {
  await fetch(`${backendUrl}/api/browser/main-bridge/extension-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileId,
      commandId,
      ...payload,
    }),
  })
}

async function pollBridgeOnce() {
  const { backendUrl, profileId } = await getBridgeState()
  if (!backendUrl || !profileId) {
    return
  }

  const res = await fetch(`${backendUrl}/api/browser/main-bridge/extension-poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  })
  const body = await res.json().catch(() => null)
  const command = body?.command
  if (!command) return

  try {
    const result = await executeCommand(command)
    await reportCommandResult(backendUrl, profileId, command.id, {
      ok: true,
      result,
    })
  } catch (error) {
    await reportCommandResult(backendUrl, profileId, command.id, {
      ok: false,
      error: toErrorMessage(error),
    })
  }
}

function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void pollBridgeOnce()
  }, 2000)
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('XiaoJuClaw Main Browser Bridge installed')
  ensurePolling()
})

chrome.runtime.onStartup.addListener(() => {
  ensurePolling()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge-attached') {
    Promise.resolve().then(async () => {
      if (message.tabId != null) {
        await switchBridgeTab(message.tabId)
      }
      await chrome.storage.local.set({
        backendUrl: normalizeBackendUrl(message.backendUrl),
        bridgeProfileId: message.profileId ?? null,
        bridgeSessionToken: message.sessionToken ?? null,
        bridgeTabId: message.tabId ?? null,
      })
      await syncBridgeSession({
        tabId: message.tabId ?? null,
      })
      ensurePolling()
      sendResponse({ ok: true })
    }).catch((error) => {
      sendResponse({ ok: false, error: toErrorMessage(error) })
    })
    return true
  }

  if (message?.type === 'bridge-detached') {
    getBridgeState().then(async (state) => {
      if (state.tabId != null) {
        await detachDebugger(state.tabId).catch(() => {})
      }
      await chrome.storage.local.set(
        message?.preserveSession
          ? {
              bridgeTabId: null,
            }
          : {
              bridgeProfileId: null,
              bridgeSessionToken: null,
              bridgeTabId: null,
            },
      )
      sendResponse({ ok: true })
    }).catch((error) => {
      sendResponse({ ok: false, error: toErrorMessage(error) })
    })
    return true
  }

  return false
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete') {
    return
  }

  void getBridgeState().then((state) => {
    if (!state.profileId || !state.tabId) return
    if (String(tabId) !== String(state.tabId)) return

    void syncBridgeSession({
      tabId: String(tabId),
      tabUrl: tab.url ?? null,
      tabTitle: tab.title ?? null,
    })
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void getBridgeState().then((state) => {
    if (!state.profileId || !state.tabId) return
    if (String(tabId) !== String(state.tabId)) return

    void setBridgeTabId(null).then(() =>
      syncBridgeSession({
        tabId: null,
        tabUrl: null,
        tabTitle: null,
      }),
    )
  })
})

chrome.debugger.onDetach.addListener((source) => {
  void getBridgeState().then((state) => {
    if (!state.tabId || String(source.tabId) !== String(state.tabId)) return
    console.warn('XiaoJuClaw debugger detached from the bridge tab', source.tabId)
  })
})
