// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { type ReactNode, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, WifiOff, Wifi } from 'lucide-react'
import { AppSidebar } from './AppSidebar'
import { WindowsTitleBar } from './WindowsTitleBar'
import { ChatProvider } from '@/hooks/useChatContext'
import { SettingsDialog, type SettingsTab } from '@/components/settings/SettingsDialog'
import { isTauri, openExternal } from '@/api/transport'
import { PlatformContext } from '@/hooks/usePlatform'
import { useDragRegion } from '@/hooks/useDragRegion'
import { useRemoteConfigStore } from '@/stores/remote-config'
import { useAppRuntimeStore } from '@/stores/app'

/** 运营公告横幅（远程配置 announcement 下发；可关闭，按文案记忆关闭状态） */
function AnnouncementBanner() {
  const announcement = useRemoteConfigStore((s) => s.announcement)()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('xjc-announcement-dismissed') ?? '')

  if (!announcement || dismissed === announcement.text) return null

  const handleDismiss = () => {
    localStorage.setItem('xjc-announcement-dismissed', announcement.text)
    setDismissed(announcement.text)
  }

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs bg-primary/10 text-foreground border-b border-[var(--subtle-border)]">
      <span className="flex-1 truncate">
        {announcement.text}
        {announcement.link && (
          <button
            type="button"
            className="ml-2 text-primary hover:underline"
            onClick={() => void openExternal(announcement.link)}
          >
            查看详情
          </button>
        )}
      </span>
      <button type="button" onClick={handleDismiss} className="p-0.5 rounded hover:bg-[var(--surface-hover)]" aria-label="关闭公告">
        <X size={12} />
      </button>
    </div>
  )
}

/**
 * 云端连接状态横幅：随可达性监控实时变化。
 *   已登录+可达 → 不显示；已登录+断开 → 「连接断开，自动重试中」；
 *   未登录+断开 → 「离线模式（自动重试）」+去登录；未登录+已恢复 → 「已恢复联网，去登录」。
 */
function CloudStatusBanner() {
  const cloudEnabled = useAppRuntimeStore((s) => s.cloudEnabled)
  const cloudReachable = useAppRuntimeStore((s) => s.cloudReachable)
  const offlineFallback = useAppRuntimeStore((s) => s.offlineFallback)
  const isLoggedIn = useAppRuntimeStore((s) => s.isLoggedIn)
  const navigate = useNavigate()

  if (!cloudEnabled) return null
  if (isLoggedIn && cloudReachable) return null
  // 正常在线未登录不会渲染 Shell（AuthGuard 拦到登录页）；这里兜底避免误显示
  if (!isLoggedIn && !offlineFallback) return null

  let tone = 'bg-amber-500/10'
  let icon = <WifiOff size={12} className="shrink-0 text-amber-600" />
  let text: string
  let showLogin = false

  if (isLoggedIn && !cloudReachable) {
    text = '与云服务器的连接已断开，正在自动重试…期间可继续使用本地功能。'
  } else if (!cloudReachable) {
    text = '离线模式：未连接到云服务器（正在自动重试）。可正常使用本地模型与内置数字员工。'
    showLogin = true
  } else {
    tone = 'bg-emerald-500/10'
    icon = <Wifi size={12} className="shrink-0 text-emerald-600" />
    text = '已恢复与云服务器的连接，登录即可使用云端功能（激活、线上数字员工等）。'
    showLogin = true
  }

  return (
    <div className={`flex items-center gap-2 px-4 py-1.5 text-xs ${tone} text-foreground border-b border-[var(--subtle-border)]`}>
      {icon}
      <span className="flex-1 truncate">{text}</span>
      {showLogin && (
        <button
          type="button"
          className="shrink-0 text-primary hover:underline"
          onClick={() => navigate('/login')}
        >
          去登录
        </button>
      )}
    </div>
  )
}

function MacTitleBar() {
  const drag = useDragRegion()
  return (
    <div
      className="h-[30px] shrink-0 flex items-center justify-center bg-muted/30 border-b border-[var(--subtle-border)]"
      {...drag}
    >
      <span className="text-xs font-semibold text-foreground/60">XiaoJuClaw</span>
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>()
  const [platform, setPlatform] = useState('')

  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string>('get_platform').then(setPlatform)
    })
  }, [])

  // 更新哨兵 toast 的「去更新」/其它模块请求打开设置：统一走 xjc:open-settings 事件。
  useEffect(() => {
    const onOpenSettings = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab as SettingsTab | undefined
      setSettingsTab(tab)
      setSettingsOpen(true)
    }
    window.addEventListener('xjc:open-settings', onOpenSettings)
    return () => window.removeEventListener('xjc:open-settings', onOpenSettings)
  }, [])

  const isWin = platform === 'windows'
  const isMac = platform === 'macos'
  const isDesktop = isTauri

  const platformCtx = { platform, isMac, isWin, isDesktop }

  return (
    <PlatformContext.Provider value={platformCtx}>
      <ChatProvider>
        <div className="h-screen flex flex-col bg-background text-foreground">
          {isMac && <MacTitleBar />}
          {/* Windows 标题栏组件自守卫（isTauri + Win 平台同步判定），
              不用异步的 isWin 门控以避免 get_platform 返回前缺一帧标题栏 */}
          <WindowsTitleBar />
          <AnnouncementBanner />
          <CloudStatusBanner />
          <div className="flex-1 flex overflow-hidden">
            <AppSidebar onOpenSettings={(tab) => { setSettingsTab(tab as SettingsTab); setSettingsOpen(true) }} />
            <main className="flex-1 overflow-hidden flex flex-col">
              {children}
            </main>
          </div>
        </div>
        {settingsOpen && (
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialTab={settingsTab}
          />
        )}
      </ChatProvider>
    </PlatformContext.Provider>
  )
}
