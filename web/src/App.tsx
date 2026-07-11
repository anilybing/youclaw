// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { Shell } from './components/layout/Shell'
import { Chat } from './pages/Chat'
import { Agents } from './pages/Agents'
import { Memory } from './pages/Memory'
import { Knowledge } from './pages/Knowledge'
import { Fulfillment } from './pages/Fulfillment'
import { Workflows } from './pages/Workflows'
import { Tasks } from './pages/Tasks'
import { Logs } from './pages/Logs'
import { UserGuide } from './pages/UserGuide'
import { Skills } from './pages/Skills'
import { Login } from './pages/Login'
import { EnvSetup } from './pages/EnvSetup'
import { Templates } from './pages/commercial/Templates'
import { Activation } from './pages/commercial/Activation'
import { Profile } from './pages/commercial/Profile'
import { Workbench } from './pages/commercial/Workbench'
import { TodayOperations } from './pages/commercial/TodayOperations'
import { PortConflictDialog } from './components/PortConflictDialog'
import { AppToaster } from './components/AppToaster'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { UpdateWatcher } from './components/UpdateWatcher'
import { ForceUpdateDialog } from './components/ForceUpdateDialog'
import { SidecarErrorOverlay } from './components/SidecarErrorOverlay'
import { FloatingBridge } from './components/FloatingBridge'
import { useTheme } from './hooks/useTheme'
import { useAppRuntimeStore } from './stores/app'
import { getTauriInvoke, isTauri, sidecarOrigin, updateCachedBaseUrl } from './api/transport'
import { saveAuthToken } from './api/client'
import { getErrorMessage, logAuthClientEvent, maskToken, sanitizeDeepLink } from './lib/auth-debug'

function AuthGuard() {
  const isLoggedIn = useAppRuntimeStore((s) => s.isLoggedIn)
  const cloudEnabled = useAppRuntimeStore((s) => s.cloudEnabled)
  const offlineFallback = useAppRuntimeStore((s) => s.offlineFallback)
  // 离线模式无需登录；线上版连不上远程服务器时也降级放行（offlineFallback），
  // 避免把用户挡在登录页外无法使用。
  if (!cloudEnabled || isLoggedIn || offlineFallback) return <Shell><Outlet /></Shell>
  return <Navigate to="/login" replace />
}

// Tauri devUrl uses http protocol, so BrowserRouter works directly
export default function App() {
  useTheme()
  const isLoggedIn = useAppRuntimeStore((s) => s.isLoggedIn)
  const cloudEnabled = useAppRuntimeStore((s) => s.cloudEnabled)
  const offlineFallback = useAppRuntimeStore((s) => s.offlineFallback)
  const envReady = useAppRuntimeStore((s) => s.envReady)
  const envChecked = useAppRuntimeStore((s) => s.envChecked)
  const envDependencies = useAppRuntimeStore((s) => s.envDependencies)
  const fetchUser = useAppRuntimeStore((s) => s.fetchUser)
  const fetchCreditBalance = useAppRuntimeStore((s) => s.fetchCreditBalance)
  const canPass = !cloudEnabled || isLoggedIn || offlineFallback
  const [portConflict, setPortConflict] = useState(false)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  // 后端（sidecar）不可用：'error' = 启动/健康检查失败；'terminated' = 进程崩溃退出。
  const [sidecarError, setSidecarError] = useState<'error' | 'terminated' | null>(null)

  // Persistently listen for sidecar-event (Tauri mode)
  useEffect(() => {
    if (!isTauri) return
    let cleanup: (() => void) | null = null

    const applyReady = (message: string) => {
      const match = message.match(/port\s+(\d+)/)
      if (match) {
        updateCachedBaseUrl(sidecarOrigin(match[1]))
      }
      // Re-hydrate if initial hydrate failed (e.g. backend wasn't ready yet)
      const { modelReady, hydrate } = useAppRuntimeStore.getState()
      if (!modelReady) {
        hydrate()
      }
    }

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ status: string; message: string }>('sidecar-event', (event) => {
        const { status, message } = event.payload
        if (status === 'ready') {
          setSidecarError(null)
          applyReady(message)
        } else if (status === 'port-conflict') {
          setPortConflict(true)
        } else if (status === 'error' || status === 'terminated') {
          // 后端启动失败（健康检查 60 次失败）或运行中崩溃：拉起全屏引导层。
          setSidecarError(status)
        }
      }).then(fn => { cleanup = fn })
    })

    // 消除竞态：监听器挂载前 Rust 可能已 emit（如启动即失败）。主动查一次当前状态。
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<{ status: string; message: string }>('get_sidecar_status')
        .then((s) => {
          if (s.status === 'ready') {
            setSidecarError(null)
            applyReady(s.message)
          } else if (s.status === 'port-conflict') {
            setPortConflict(true)
          } else if (s.status === 'error') {
            setSidecarError('error')
          }
          // 'pending' 等待后续 ready 事件；'terminated' 仅经运行期事件路径上报。
        })
        .catch(() => {})
    })

    return () => { cleanup?.() }
  }, [])

  useEffect(() => {
    if (!isTauri) return
    let cleanup: (() => void) | null = null

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('close-requested', () => {
        setCloseDialogOpen(true)
      }).then((fn) => {
        cleanup = fn
      })
    })

    return () => {
      cleanup?.()
    }
  }, [])

  useEffect(() => {
    if (!isTauri) return

    let unlisten: (() => void) | null = null
    const inFlightUrls = new Set<string>()

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const normalizeDeepLink = (rawUrl: string) => {
      const start = rawUrl.indexOf('XiaoJuClaw://')
      if (start === -1) return null
      const normalized = rawUrl
        .slice(start)
        .trim()
        .replace(/^['"]+/, '')
        .replace(/['"]+$/, '')
      return normalized.startsWith('XiaoJuClaw://') ? normalized : null
    }

    const persistAuthTokenWithRetry = async (token: string) => {
      let lastError: unknown = null
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          await saveAuthToken(token)
          if (attempt > 0) {
            void logAuthClientEvent('info', 'Persisted auth token after retry', {
              attempt: attempt + 1,
              tokenLength: token.length,
              tokenPreview: maskToken(token),
            })
          }
          return
        } catch (err) {
          lastError = err
          await delay(500)
        }
      }
      void logAuthClientEvent('error', 'Failed to persist auth token after retries', {
        attempts: 60,
        error: getErrorMessage(lastError),
        tokenLength: token.length,
        tokenPreview: maskToken(token),
      })
      throw lastError ?? new Error('Failed to persist auth token from deep link')
    }

    const handleDeepLink = async (rawUrl: string) => {
      const normalizedUrl = normalizeDeepLink(rawUrl)
      const sanitizedUrl = sanitizeDeepLink(rawUrl)

      void logAuthClientEvent('info', 'Deep link received in frontend', {
        rawUrl: sanitizedUrl,
        normalizedUrl: sanitizeDeepLink(normalizedUrl),
      })

      if (!normalizedUrl || inFlightUrls.has(normalizedUrl)) return
      inFlightUrls.add(normalizedUrl)

      let url: URL
      try {
        url = new URL(normalizedUrl)
      } catch (err) {
        void logAuthClientEvent('warn', 'Failed to parse deep link URL in frontend', {
          rawUrl: sanitizedUrl,
          error: getErrorMessage(err),
        })
        inFlightUrls.delete(normalizedUrl)
        return
      }

      if (url.protocol !== 'XiaoJuClaw:') {
        void logAuthClientEvent('warn', 'Ignoring deep link with unexpected protocol', {
          rawUrl: sanitizedUrl,
          protocol: url.protocol,
        })
        inFlightUrls.delete(normalizedUrl)
        return
      }

      const rawRoute = `${url.hostname}${url.pathname}`
      const route = rawRoute.replace(/^\/+/, '')
      const token = url.searchParams.get('token')

      void logAuthClientEvent('info', 'Deep link parsed in frontend', {
        route,
        rawUrl: sanitizedUrl,
        hasToken: !!token,
        tokenLength: token?.length ?? 0,
        tokenPreview: maskToken(token),
      })

      if (route === 'auth/callback') {
        if (!token) {
          void logAuthClientEvent('warn', 'Auth callback deep link missing token', {
            route,
            rawUrl: sanitizedUrl,
          })
          inFlightUrls.delete(normalizedUrl)
          return
        }
        try {
          await persistAuthTokenWithRetry(token)
          await logAuthClientEvent('info', 'Auth token persisted from deep link', {
            route,
            rawUrl: sanitizedUrl,
            tokenLength: token.length,
            tokenPreview: maskToken(token),
          })
          await fetchUser()
          await logAuthClientEvent('info', 'Frontend completed auth user refresh after deep link', {
            route,
          })
          await fetchCreditBalance()
        } catch (err) {
          await logAuthClientEvent('error', 'Failed to complete auth deep-link flow', {
            route,
            rawUrl: sanitizedUrl,
            hasToken: !!token,
            tokenLength: token.length,
            tokenPreview: maskToken(token),
            error: getErrorMessage(err),
          })
          console.error('Failed to persist auth token from deep link:', err)
        } finally {
          inFlightUrls.delete(normalizedUrl)
        }
        return
      }

      if (route === 'pay/callback' && url.searchParams.get('status') === 'success') {
        void fetchCreditBalance()
      }

      inFlightUrls.delete(normalizedUrl)
    }

    const invoke = getTauriInvoke()

    const setDeepLinkFrontendReady = async (ready: boolean) => {
      try {
        await invoke('set_deep_link_frontend_ready', { ready })
        void logAuthClientEvent('info', 'Updated deep-link frontend readiness', {
          ready,
        })
      } catch (err) {
        void logAuthClientEvent('error', 'Failed to update deep-link frontend readiness', {
          ready,
          error: getErrorMessage(err),
        })
        console.error(`Failed to set deep-link frontend readiness to ${ready}:`, err)
      }
    }

    const loadPendingDeepLinks = async () => {
      try {
        const urls = await invoke('take_pending_deep_links') as string[]
        await logAuthClientEvent('info', 'Loaded pending deep links', {
          count: urls?.length ?? 0,
          urls: (urls ?? []).map((url) => sanitizeDeepLink(url)),
        })
        for (const url of urls ?? []) {
          await handleDeepLink(url)
        }
      } catch (err) {
        await logAuthClientEvent('error', 'Failed to load pending deep links', {
          error: getErrorMessage(err),
        })
        console.error('Failed to load pending deep links:', err)
      }
    }

    let disposed = false

    const initializeDeepLinks = async () => {
      try {
        await logAuthClientEvent('info', 'Initializing deep-link bridge in frontend')
        const { listen } = await import('@tauri-apps/api/event')
        const stopListening = await listen<string>('deep-link-received', (event) => {
          void handleDeepLink(event.payload)
        })

        if (disposed) {
          stopListening()
          return
        }

        unlisten = stopListening
        await setDeepLinkFrontendReady(true)
        await loadPendingDeepLinks()
      } catch (err) {
        await logAuthClientEvent('error', 'Failed to initialize deep-link bridge', {
          error: getErrorMessage(err),
        })
        console.error('Failed to initialize deep-link bridge:', err)
      }
    }

    void initializeDeepLinks()
    // Intentionally avoid replaying plugin `getCurrent()` URLs here.
    // In Tauri, that value can survive a webview refresh and re-deliver the
    // last `XiaoJuClaw://auth/callback?...` URL, which would silently restore a
    // logged-out session after the user reloads the page.

    return () => {
      disposed = true
      void setDeepLinkFrontendReady(false)
      unlisten?.()
    }
  }, [fetchCreditBalance, fetchUser])

  // Block all pages until required environment dependencies are available
  if (envChecked && !envReady) {
    return <EnvSetup dependencies={envDependencies} />
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* 登录后默认落地“今日经营”（一人公司经营主入口）。
            注意用 isLoggedIn 而非 canPass：离线降级用户未真正登录，仍应能进入登录页，
            以便远程服务器恢复后主动登录使用云功能。 */}
        <Route path="/login" element={isLoggedIn ? <Navigate to="/today" replace /> : <Login />} />
        <Route
          path="/guide"
          element={canPass ? <Shell><UserGuide /></Shell> : <UserGuide standalone />}
        />
        <Route element={<AuthGuard />}>
          <Route path="/" element={<Navigate to="/today" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/today" element={<TodayOperations />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/cron" element={<Tasks />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/fulfillment" element={<Fulfillment />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/activation" element={<Activation />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/workbench" element={<Workbench />} />
        </Route>
        <Route path="*" element={<Navigate to={canPass ? "/today" : "/login"} replace />} />
      </Routes>
      <AppToaster />
      {isTauri && <FloatingBridge />}
      {isTauri && <UpdateWatcher />}
      {isTauri && <ForceUpdateDialog />}
      {isTauri && <SidecarErrorOverlay status={sidecarError} onRecovered={() => setSidecarError(null)} />}
      {isTauri && <PortConflictDialog open={portConflict} onResolved={() => setPortConflict(false)} />}
      {isTauri && <CloseConfirmDialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen} />}
    </BrowserRouter>
  )
}
