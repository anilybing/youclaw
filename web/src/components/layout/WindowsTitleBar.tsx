// [XJC-PATCH] Windows 自定义标题栏：decorations=false 后由前端承担品牌展示、窗口拖拽与最小化/最大化/关闭。
import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { isTauri } from '@/api/transport'
import logoUrl from '@/assets/logo.png'

// 平台在运行期不会变化，模块级同步判定（WebView2 的 navigator.platform 为 "Win32"）。
// 组件自守卫：Login/EnvSetup/StartupError 等 Shell（PlatformContext）之外的全屏页面
// 也能直接挂载，Web 模式与非 Windows 平台渲染为 null。
const IS_WINDOWS_DESKTOP =
  isTauri &&
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().startsWith('WIN')

const BTN_BASE =
  'inline-flex h-full w-[46px] shrink-0 items-center justify-center transition-colors duration-150 text-foreground/60 hover:text-foreground'

function callWindow(method: 'minimize' | 'toggleMaximize' | 'close') {
  // 关闭必须走 close()（而非 destroy）：Rust 侧 CloseRequested 会 prevent 并
  // emit close-requested，由 CloseConfirmDialog 决定最小化到托盘还是退出。
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
    getCurrentWindow()[method](),
  )
}

/**
 * Windows custom title bar (36px): brand at left, drag region in the middle
 * (native drag + double-click maximize via data-tauri-drag-region), window
 * controls at right. Maximize button flips to "restore" while maximized.
 */
export function WindowsTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!IS_WINDOWS_DESKTOP) return
    let disposed = false
    let unlisten: (() => void) | undefined

    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      const refresh = async () => {
        try {
          const value = await win.isMaximized()
          if (!disposed) setIsMaximized(value)
        } catch {
          // best-effort：查询失败时保持现状
        }
      }
      await refresh()
      try {
        // 最大化/还原（含双击拖拽区、Win+方向键）都会触发 resize，借此刷新按钮状态
        const stop = await win.onResized(() => void refresh())
        if (disposed) stop()
        else unlisten = stop
      } catch {
        // 监听失败时退化为仅初始查询
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  if (!IS_WINDOWS_DESKTOP) return null

  return (
    <div
      data-tauri-drag-region
      className="h-9 shrink-0 flex items-stretch select-none bg-background border-b border-[var(--subtle-border)]"
    >
      {/* data-tauri-drag-region 只对事件 target 本身生效（不冒泡到子元素），
          因此品牌图标/文字需逐个标注才能整条可拖拽 */}
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3">
        <img
          data-tauri-drag-region
          src={logoUrl}
          alt=""
          draggable={false}
          className="h-4 w-4 rounded-[3px]"
        />
        <span
          data-tauri-drag-region
          className="text-xs font-medium text-foreground/70 whitespace-nowrap"
        >
          XiaoJuClaw
        </span>
      </div>
      <div data-tauri-drag-region className="flex-1 min-w-0" />
      <div className="flex h-full items-stretch">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => callWindow('minimize')}
          className={`${BTN_BASE} hover:bg-[var(--surface-hover)]`}
          aria-label="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => callWindow('toggleMaximize')}
          className={`${BTN_BASE} hover:bg-[var(--surface-hover)]`}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => callWindow('close')}
          className={`${BTN_BASE} hover:bg-[#e81123] hover:text-white`}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
