// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { useUpdateStore } from '@/stores/update'
import appConfig from '../../../app.config.ts'

// 连续失败到此阈值后放出「逃生入口」：未到阈值仍强制更新，不破坏强更语义。
const FAIL_THRESHOLD = 3
// 官网地址走 app.config 单一来源，禁止硬编码域名。
const SITE_URL = appConfig.siteBase

/**
 * 强制更新弹窗：MVP 发布勾选「强制升级」时全屏接管，不可关闭 / 不可跳过。
 *   - 便携版：点「立即更新」原地调 portable_update_apply（下载→校验→替换→自动重启）。
 *   - 安装版：走 Tauri updater downloadAndInstall，完成后重启。
 * 失败可重试。为避免在用户端反复失败时被 modal 永久锁死（网络差 / 服务器不可达 /
 * 便携构建被误判为 installer 却无 updater 端点必抛错），连续失败到阈值后放出一条
 * 干净退出的逃生口，并展示官网人工升级指引；仍不提供「跳过本次更新」入口。
 */
export function ForceUpdateDialog() {
  const { t } = useI18n()
  const available = useUpdateStore((s) => s.available)
  const forceUpdate = useUpdateStore((s) => s.forceUpdate)
  const channel = useUpdateStore((s) => s.channel)
  const version = useUpdateStore((s) => s.version)
  const notes = useUpdateStore((s) => s.notes)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [failCount, setFailCount] = useState(0)
  // 安装版通道却拿不到 updater 端点（便携/离线构建被误判为 installer）：首败即转人工指引。
  const [manualOnly, setManualOnly] = useState(false)
  const [copied, setCopied] = useState(false)

  const open = available && forceUpdate
  const showEscape = manualOnly || failCount >= FAIL_THRESHOLD

  const applyPortable = async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen<{ phase: string; percent: number }>('portable-update-progress', (event) => {
      if (event.payload.phase === 'applying') {
        setProgress(100)
        setMessage(t.settings.updatingRestart)
      } else {
        setProgress(event.payload.percent)
        setMessage(`${t.settings.downloading}... ${event.payload.percent}%`)
      }
    })
    try {
      // 成功后 Rust 侧退出进程并由脚本重启，本调用通常不会返回。
      await invoke('portable_update_apply')
    } finally {
      unlisten()
    }
  }

  const applyInstaller = async () => {
    const { check } = await import('@tauri-apps/plugin-updater')
    const upd = await check()
    if (!upd) throw new Error(t.settings.upToDate)
    let downloaded = 0
    let contentLength = 0
    await upd.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        contentLength = event.data.contentLength ?? 0
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        const pct = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0
        setProgress(pct)
        setMessage(`${t.settings.downloading}... ${pct}%`)
      } else if (event.event === 'Finished') {
        setProgress(100)
        setMessage(t.settings.updatingRestart)
      }
    })
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  }

  // 复查编译期通道：store 说 installer 但实际是便携/离线构建 → updater 端点不可用，
  // 重试无意义，直接转人工升级指引。复查失败则不据此判定，交给通用 failCount 逃生口兜底。
  const probeInstallerUnavailable = async (errMsg: string): Promise<boolean> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const compiled = await invoke<string>('get_update_channel')
      if (compiled !== 'installer') return true
    } catch {
      // 复查不可用：仅在错误明确指向「无端点/未配置」时才判定为不可自动更新。
      return /no endpoint|endpoints? (are )?not|not configured|无端点|未配置/i.test(errMsg)
    }
    return false
  }

  const handleApply = async () => {
    setBusy(true)
    setMessage(`${t.settings.downloading}... 0%`)
    setProgress(0)
    try {
      if (channel === 'portable') {
        await applyPortable()
      } else {
        await applyInstaller()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessage(`${t.settings.updateError}: ${msg}`)
      setBusy(false)
      setFailCount((n) => n + 1)
      // 安装版通道的特判：只在尚未判定时复查一次，命中即首败放行逃生口。
      if (channel === 'installer' && !manualOnly) {
        void probeInstallerUnavailable(msg).then((unavailable) => {
          if (unavailable) setManualOnly(true)
        })
      }
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(SITE_URL)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 忽略剪贴板错误：URL 已可手动选中复制。
    }
  }

  // 逃生口：干净退出应用，让用户去用离线包 / 换网络后重开，而不是被 modal 永久锁死。
  const handleExit = async () => {
    try {
      const { exit } = await import('@tauri-apps/plugin-process')
      await exit(0)
    } catch {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().close()
      } catch {
        // 退出兜底同样失败时无能为力，保持弹窗。
      }
    }
  }

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="w-[90vw] max-w-md" onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t.settings.forceUpdateTitle} v{version}
          </AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">
            {notes || t.settings.forceUpdateDesc}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          {busy && <Progress value={progress} />}
          <p className="text-sm text-muted-foreground min-h-[1.2em]">{message}</p>

          {showEscape && (
            <div className="rounded-xl border border-border/50 bg-muted/40 p-3 space-y-2">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {manualOnly ? t.settings.forceUpdateManualHint : t.settings.forceUpdateStuckHint}
              </p>
              <div className="flex items-center gap-2 rounded-lg bg-background/60 px-2.5 py-1.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t.settings.forceUpdateSiteLabel}
                </span>
                <code className="flex-1 select-all break-all text-xs text-foreground">{SITE_URL}</code>
                <button
                  type="button"
                  onClick={handleCopy}
                  title={t.common.copy}
                  aria-label={t.common.copy}
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted-foreground/10"
                >
                  {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          )}
        </div>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button className="w-full rounded-xl" onClick={handleApply} disabled={busy}>
            {t.settings.updateNow}
          </Button>
          {showEscape && (
            <Button
              variant="outline"
              className="w-full rounded-xl"
              onClick={handleExit}
              disabled={busy}
            >
              {t.settings.forceUpdateExitApp}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
