// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { type ReactNode, useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { AppSidebar } from './AppSidebar'
import { ChatProvider } from '@/hooks/useChatContext'
import { SettingsDialog, type SettingsTab } from '@/components/settings/SettingsDialog'
import { isTauri, openExternal } from '@/api/transport'
import { PlatformContext } from '@/hooks/usePlatform'
import { useDragRegion } from '@/hooks/useDragRegion'
import { useRemoteConfigStore } from '@/stores/remote-config'

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

  const isWin = platform === 'windows'
  const isMac = platform === 'macos'
  const isDesktop = isTauri

  const platformCtx = { platform, isMac, isWin, isDesktop }

  return (
    <PlatformContext.Provider value={platformCtx}>
      <ChatProvider>
        <div className="h-screen flex flex-col bg-background text-foreground">
          {isMac && <MacTitleBar />}
          <AnnouncementBanner />
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
