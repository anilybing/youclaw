// [XJC-PATCH] added for XiaoJuClaw — sidecar 崩溃/启动失败的前端引导（详见 doc/侵入点清单.md）
import { useState } from 'react'
import { AlertTriangle, Loader2, Mail, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { isTauri, waitForBackendReady } from '@/api/transport'
import { WindowsTitleBar } from '@/components/layout/WindowsTitleBar'
import logoUrl from '@/assets/logo.png'
import appConfig from '../../../app.config.ts'

const SUPPORT_EMAIL = appConfig.supportEmail

interface SidecarErrorOverlayProps {
  /** null 时不渲染；'error' = 健康检查失败未能启动；'terminated' = sidecar 进程崩溃退出。 */
  status: 'error' | 'terminated' | null
  onRecovered: () => void
}

/**
 * 后端（sidecar）启动失败 / 崩溃时的全屏引导覆盖层：
 *   - Rust 侧 sidecar-event（error / terminated）由 App.tsx 置态后渲染本层。
 *   - 「重启后端」调 invoke('restart_sidecar')，成功后 Rust 会 emit ready，由 App.tsx 清除本层。
 *   - 「退出应用」提供干净出路，避免用户面对全接口失败的空壳无从操作。
 * 仅 Tauri 桌面端渲染；样式对齐 StartupError / EnvSetup 的全屏页语系。
 */
export function SidecarErrorOverlay({ status, onRecovered }: SidecarErrorOverlayProps) {
  const { t } = useI18n()
  const [restarting, setRestarting] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!isTauri || !status) return null

  const handleRestart = async () => {
    setRestarting(true)
    setFailed(false)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('restart_sidecar')
      // Rust command success already implies its health window passed; query + HTTP
      // probing is a second guard against stale IPC state before hiding the overlay.
      if (await waitForBackendReady()) {
        onRecovered()
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      setRestarting(false)
    }
  }

  const handleExit = async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process')
      await exit(0)
    } catch {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().close()
      } catch {
        // 退出兜底同样失败时无能为力。
      }
    }
  }

  const description = status === 'terminated' ? t.sidecar.descTerminated : t.sidecar.descError

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gradient-to-br from-background to-muted/30">
      {/* 无边框窗口下覆盖层遮住原标题栏，需自带标题栏以保留拖拽/最小化/关闭（组件自守卫）。 */}
      <WindowsTitleBar />
      <div className="flex-1 flex items-center justify-center overflow-auto p-8">
        <div className="w-full max-w-lg space-y-8">
          {/* Logo & Title */}
          <div className="text-center">
            <div className="inline-block">
              <img
                src={logoUrl}
                alt="XiaoJuClaw Logo"
                className="w-20 h-20 p-2 mx-auto rounded-2xl shadow-lg border border-border/50 bg-white"
              />
            </div>
            <h1 className="mt-5 text-2xl font-bold text-foreground tracking-tight">XiaoJuClaw</h1>
          </div>

          {/* Error Card */}
          <div className="bg-card rounded-2xl shadow-lg border border-border/50 p-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="bg-destructive/10 p-2.5 rounded-xl text-destructive shrink-0 mt-0.5">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">{t.sidecar.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{description}</p>
              </div>
            </div>

            {/* Restart backend */}
            <Button
              size="lg"
              onClick={handleRestart}
              disabled={restarting}
              className="w-full gap-2 py-6 text-sm font-semibold rounded-xl shadow-lg shadow-primary/20 active:scale-[0.98] transition-all duration-200"
            >
              {restarting ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  {t.sidecar.restarting}
                </>
              ) : (
                <>
                  <RefreshCw size={18} />
                  {t.sidecar.restart}
                </>
              )}
            </Button>

            {failed && (
              <p className="text-sm text-destructive text-center">{t.sidecar.restartFailed}</p>
            )}

            {/* Exit app */}
            <Button
              variant="outline"
              size="lg"
              onClick={handleExit}
              disabled={restarting}
              className="w-full rounded-xl active:scale-[0.98] transition-all duration-200"
            >
              {t.sidecar.exit}
            </Button>

            {/* Contact Info */}
            <div className="pt-3 border-t border-border/50 space-y-2">
              <p className="text-xs text-muted-foreground text-center">{t.sidecar.contactHint}</p>
              <div className="flex items-center justify-center gap-4">
                <a
                  href={`mailto:${SUPPORT_EMAIL}`}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Mail size={14} />
                  <span>{SUPPORT_EMAIL}</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
