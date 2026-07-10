// [XJC] 悬浮提醒窗视图（?view=floating 时由 main.tsx 分流渲染）。
// 常驻置顶的小窗：实时显示 AI 产出的结果，点击回到主窗对应对话。
import { useCallback, useEffect, useState } from 'react'
import { Bell, Check, Pin, PinOff, X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { useFloatingResults, type FloatingResult } from './useFloatingResults'
import { FLOATING_WINDOW_LABEL } from '@/lib/floating-window'

function snippet(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function FloatingApp() {
  const { t } = useI18n()
  const { results, connected, unreadCount, markAllRead, clearAll } = useFloatingResults()
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    document.title = t.floating.title
  }, [t])

  const closeSelf = useCallback(async () => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const self = await WebviewWindow.getByLabel(FLOATING_WINDOW_LABEL)
      await self?.close()
    } catch { /* 忽略 */ }
  }, [])

  const togglePin = useCallback(async () => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const self = await WebviewWindow.getByLabel(FLOATING_WINDOW_LABEL)
      const next = !pinned
      await self?.setAlwaysOnTop(next)
      setPinned(next)
    } catch { /* 忽略 */ }
  }, [pinned])

  const openInMain = useCallback(async (result: FloatingResult) => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const { emitTo } = await import('@tauri-apps/api/event')
      const main = await WebviewWindow.getByLabel('main')
      if (main) {
        try { await main.unminimize() } catch { /* 可能未最小化 */ }
        await main.show()
        await main.setFocus()
      }
      await emitTo('main', 'xjc:floating-open-chat', { chatId: result.chatId, agentId: result.agentId })
    } catch { /* 忽略 */ }
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden select-none">
      {/* 标题栏（可拖拽） */}
      <div
        data-tauri-drag-region
        className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--subtle-border)] bg-muted/40"
      >
        <Bell size={13} className="shrink-0 text-primary" />
        <span data-tauri-drag-region className="flex-1 truncate text-xs font-semibold">
          {t.floating.title}
          {unreadCount > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] tabular-nums">
              {unreadCount}
            </span>
          )}
        </span>
        <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}`} title={connected ? t.floating.connected : t.floating.reconnecting} />
        <button type="button" onClick={togglePin} title={pinned ? t.floating.unpin : t.floating.pin} className="p-1 rounded hover:bg-[var(--surface-hover)] text-muted-foreground hover:text-foreground">
          {pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button type="button" onClick={() => void closeSelf()} title={t.common.close} className="p-1 rounded hover:bg-[var(--surface-hover)] text-muted-foreground hover:text-foreground">
          <X size={14} />
        </button>
      </div>

      {/* 操作条 */}
      <div className="h-7 shrink-0 flex items-center justify-between px-3 text-[11px] text-muted-foreground">
        <span>{t.floating.subtitle}</span>
        {results.length > 0 && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={markAllRead} className="hover:text-foreground inline-flex items-center gap-0.5">
              <Check size={11} /> {t.floating.markRead}
            </button>
            <button type="button" onClick={clearAll} className="hover:text-foreground">{t.floating.clear}</button>
          </div>
        )}
      </div>

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
        {results.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4 gap-2">
            <Bell size={22} className="text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">{t.floating.empty}</p>
          </div>
        ) : (
          results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => void openInMain(r)}
              className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${
                r.read
                  ? 'border-[var(--subtle-border)] bg-transparent hover:bg-[var(--surface-hover)]'
                  : 'border-primary/30 bg-primary/5 hover:bg-primary/10'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                {!r.read && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-primary" />}
                <span className="flex-1 truncate text-xs font-medium">{r.agentName}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{timeLabel(r.time)}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-foreground/75 line-clamp-3 break-words">{snippet(r.text)}</p>
              <p className="mt-1 text-[10px] text-primary/70">{t.floating.openChat} →</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
