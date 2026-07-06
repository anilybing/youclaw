const backendInput = document.getElementById('backend')
const pairingInput = document.getElementById('pairing')
const connectButton = document.getElementById('connect')
const disconnectButton = document.getElementById('disconnect')
const backendStatusPanel = document.getElementById('backend-status')
const currentTabPanel = document.getElementById('current-tab')
const attachedTabPanel = document.getElementById('attached-tab')
const status = document.getElementById('status')

function normalizeBackendUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

function setStatus(message, isError = false) {
  status.textContent = message
  status.style.color = isError ? '#c03a2b' : '#2f6f44'
}

function setBackendStatus(message, isError = false) {
  backendStatusPanel.textContent = message
  backendStatusPanel.style.color = isError ? '#c03a2b' : '#2f6f44'
}

function humanizeBridgeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (normalized.includes('pairing code expired')) {
    return 'The pairing code expired. Generate a new pairing code in XiaoJuClaw and try again.'
  }
  if (normalized.includes('invalid pairing code')) {
    return 'The pairing code is invalid. Copy the latest code from XiaoJuClaw and try again.'
  }
  if (normalized.includes('invalid browser extension session token') || normalized.includes('browser extension session not found')) {
    return 'This browser bridge session is no longer valid. Generate a new pairing code in XiaoJuClaw to pair again.'
  }
  if (normalized.includes('failed to fetch') || normalized.includes('networkerror')) {
    return 'Cannot reach the XiaoJuClaw backend. Check the backend URL and make sure the app is running.'
  }
  return message
}

function isBridgeSessionError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('invalid browser extension session token')
    || normalized.includes('browser extension session not found')
}

function describeTab(tab) {
  if (!tab) {
    return 'Unavailable'
  }
  const title = tab.title || '(untitled tab)'
  const url = tab.url || '(no URL)'
  return `${title}\n${url}`
}

async function getStoredBridgeState() {
  return chrome.storage.local.get({
    backendUrl: 'http://127.0.0.1:62601',
    pairingCode: '',
    bridgeProfileId: null,
    bridgeSessionToken: null,
    bridgeTabId: null,
  })
}

async function loadDefaults() {
  const stored = await getStoredBridgeState()
  backendInput.value = stored.backendUrl
  pairingInput.value = stored.pairingCode
}

async function saveDefaults() {
  await chrome.storage.local.set({
    backendUrl: normalizeBackendUrl(backendInput.value),
    pairingCode: pairingInput.value.trim(),
  })
}

async function checkBackendHealth(backendUrl) {
  const normalized = normalizeBackendUrl(backendUrl)
  if (!normalized) {
    setBackendStatus('Backend URL is empty.', true)
    return false
  }

  try {
    const res = await fetch(`${normalized}/api/health`)
    if (!res.ok) {
      setBackendStatus(`Backend responded with HTTP ${res.status}.`, true)
      return false
    }
    setBackendStatus('Backend reachable.')
    return true
  } catch (error) {
    setBackendStatus(humanizeBridgeError(error), true)
    return false
  }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) {
    throw new Error('No active tab found')
  }
  return tab
}

async function getAttachedTab(attachedTabId) {
  if (!attachedTabId) return null
  try {
    const tab = await chrome.tabs.get(Number(attachedTabId))
    return tab
  } catch {
    return null
  }
}

async function refreshUi() {
  const [currentTab, stored] = await Promise.all([
    getCurrentTab().catch(() => null),
    getStoredBridgeState(),
  ])

  const activeTabId = currentTab?.id != null ? String(currentTab.id) : null
  const attachedTabId = stored.bridgeTabId ? String(stored.bridgeTabId) : null
  const attachedTab = await getAttachedTab(attachedTabId)
  const hasSession = !!stored.bridgeProfileId && !!stored.bridgeSessionToken
  const hasAttachedTab = hasSession && !!attachedTabId

  currentTabPanel.textContent = describeTab(currentTab)
  attachedTabPanel.textContent = hasAttachedTab
    ? describeTab(attachedTab) + (attachedTabId ? `\n(tab id: ${attachedTabId})` : '')
    : 'No tab connected.'

  disconnectButton.disabled = !hasAttachedTab

  if (!hasSession) {
    connectButton.textContent = 'Connect Current Tab'
    setStatus('No browser bridge is paired yet.')
    return
  }

  if (!hasAttachedTab) {
    connectButton.textContent = 'Connect Current Tab'
    setStatus('No tab is attached right now. Use this button to attach the current tab.')
    return
  }

  if (activeTabId && attachedTabId === activeTabId) {
    connectButton.textContent = 'Reconnect Current Tab'
    setStatus('Current tab is connected to XiaoJuClaw.')
    return
  }

  connectButton.textContent = 'Switch To Current Tab'
  setStatus('Another tab is currently connected. Use this button to switch the bridge to the current tab.', true)
}

async function connectCurrentTab() {
  const stored = await getStoredBridgeState()
  const backendUrl = normalizeBackendUrl(backendInput.value || stored.backendUrl)
  const pairingCode = pairingInput.value.trim()

  const reachable = await checkBackendHealth(backendUrl)
  if (!reachable) {
    throw new Error('Backend is not reachable')
  }

  const tab = await getCurrentTab()
  const browserName = navigator.userAgent.includes('Edg/')
    ? 'Microsoft Edge'
    : navigator.userAgent.includes('Brave')
      ? 'Brave'
      : navigator.userAgent.includes('Chrome')
        ? 'Google Chrome'
        : 'Chromium Browser'
  const browserKind = navigator.userAgent.includes('Edg/')
    ? 'edge'
    : navigator.userAgent.includes('Brave')
      ? 'brave'
      : navigator.userAgent.includes('Chrome')
        ? 'chrome'
        : 'chromium'
  const bodyPayload = {
    browserId: null,
    browserName,
    browserKind,
    tabId: tab.id != null ? String(tab.id) : null,
    tabUrl: tab.url ?? null,
    tabTitle: tab.title ?? null,
    extensionVersion: chrome.runtime.getManifest().version,
  }

  let res
  if (stored.bridgeProfileId && stored.bridgeSessionToken) {
    res = await fetch(`${backendUrl}/api/browser/main-bridge/extension-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: stored.bridgeProfileId,
        sessionToken: stored.bridgeSessionToken,
        ...bodyPayload,
      }),
    })

    if (!res.ok) {
      const failedBody = await res.json().catch(() => null)
      const error = new Error(failedBody?.error || `Attach failed: ${res.status}`)
      if (isBridgeSessionError(error) && pairingCode) {
        await chrome.storage.local.set({
          bridgeProfileId: null,
          bridgeSessionToken: null,
          bridgeTabId: null,
        })
        res = await fetch(`${backendUrl}/api/browser/main-bridge/extension-attach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pairingCode,
            ...bodyPayload,
          }),
        })
      } else {
        throw error
      }
    }
  } else {
    if (!pairingCode) {
      throw new Error('Backend URL and pairing code are required')
    }
    res = await fetch(`${backendUrl}/api/browser/main-bridge/extension-attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingCode,
        ...bodyPayload,
      }),
    })
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(body?.error || `Attach failed: ${res.status}`)
  }

  const response = await chrome.runtime.sendMessage({
    type: 'bridge-attached',
    backendUrl,
    profileId: body?.state?.profileId ?? null,
    sessionToken: body?.sessionToken ?? stored.bridgeSessionToken ?? null,
    tabId: tab.id != null ? String(tab.id) : null,
  })
  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to attach debugger to the current tab')
  }

  return body
}

async function disconnectCurrentTab() {
  const stored = await getStoredBridgeState()
  const backendUrl = normalizeBackendUrl(stored.backendUrl)
  if (!backendUrl || !stored.bridgeProfileId || !stored.bridgeSessionToken) {
    throw new Error('No connected bridge session found')
  }

  const res = await fetch(`${backendUrl}/api/browser/main-bridge/extension-detach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileId: stored.bridgeProfileId,
      sessionToken: stored.bridgeSessionToken,
    }),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(body?.error || `Disconnect failed: ${res.status}`)
  }

  const response = await chrome.runtime.sendMessage({
    type: 'bridge-detached',
    preserveSession: true,
  })
  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to detach debugger from the current tab')
  }
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true
  disconnectButton.disabled = true
  setStatus('Connecting current tab...')
  try {
    await saveDefaults()
    await connectCurrentTab()
    setStatus('Current tab connected to XiaoJuClaw.')
    await refreshUi()
  } catch (error) {
    setStatus(humanizeBridgeError(error), true)
  } finally {
    connectButton.disabled = false
    await refreshUi()
  }
})

disconnectButton.addEventListener('click', async () => {
  connectButton.disabled = true
  disconnectButton.disabled = true
  setStatus('Disconnecting current tab...')
  try {
    await disconnectCurrentTab()
    setStatus('Current tab disconnected from XiaoJuClaw.')
    await refreshUi()
  } catch (error) {
    setStatus(humanizeBridgeError(error), true)
  } finally {
    connectButton.disabled = false
    await refreshUi()
  }
})

loadDefaults()
  .then(async () => {
    await checkBackendHealth(backendInput.value)
    await refreshUi()
  })
  .catch(() => {
    setStatus('Failed to load extension defaults.', true)
    setBackendStatus('Failed to load backend configuration.', true)
  })
