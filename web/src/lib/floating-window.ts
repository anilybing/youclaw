// [XJC] 悬浮提醒窗控制（桌面端）：动态创建/关闭一个常驻置顶的小窗，
// 用户离开主界面时也能第一时间看到 AI 产出的结果。仅 Tauri 桌面可用。
import { isTauri } from '@/api/transport'

export const FLOATING_WINDOW_LABEL = 'floating'
/** 悬浮窗仅桌面端可用（Web/浏览器无多窗口能力） */
export const isFloatingSupported = isTauri

const FLOATING_WIDTH = 340
const FLOATING_HEIGHT = 460

/** 悬浮窗当前是否已开启 */
export async function isFloatingOpen(): Promise<boolean> {
  if (!isFloatingSupported) return false
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    return (await WebviewWindow.getByLabel(FLOATING_WINDOW_LABEL)) != null
  } catch {
    return false
  }
}

/** 打开悬浮窗（已存在则聚焦并置顶）。返回是否成功开启。 */
export async function openFloatingWindow(): Promise<boolean> {
  if (!isFloatingSupported) return false
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')

  const existing = await WebviewWindow.getByLabel(FLOATING_WINDOW_LABEL)
  if (existing) {
    try {
      await existing.show()
      await existing.setAlwaysOnTop(true)
      await existing.setFocus()
    } catch { /* 忽略聚焦异常 */ }
    return true
  }

  // 用当前窗口地址派生悬浮视图地址，dev/prod 通用（?view=floating 由 main.tsx 分流）
  const url = new URL(window.location.href)
  url.hash = ''
  url.searchParams.set('view', 'floating')
  const relativeUrl = `${url.pathname}${url.search}`

  return await new Promise<boolean>((resolve) => {
    const win = new WebviewWindow(FLOATING_WINDOW_LABEL, {
      url: relativeUrl,
      title: 'XiaoJuClaw',
      width: FLOATING_WIDTH,
      height: FLOATING_HEIGHT,
      minWidth: 260,
      minHeight: 200,
      resizable: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focus: true,
    })
    win.once('tauri://created', () => resolve(true))
    win.once('tauri://error', () => resolve(false))
  })
}

/** 关闭悬浮窗 */
export async function closeFloatingWindow(): Promise<void> {
  if (!isFloatingSupported) return
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existing = await WebviewWindow.getByLabel(FLOATING_WINDOW_LABEL)
  if (existing) {
    try { await existing.close() } catch { /* 已关闭 */ }
  }
}

/** 切换悬浮窗开/关，返回切换后的开启状态 */
export async function toggleFloatingWindow(): Promise<boolean> {
  if (await isFloatingOpen()) {
    await closeFloatingWindow()
    return false
  }
  return openFloatingWindow()
}
