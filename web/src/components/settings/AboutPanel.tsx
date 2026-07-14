// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { isTauri, openExternal } from "@/api/transport"
import { getSettings, updateSettings } from "@/api/client"
import { useI18n } from "@/i18n"
import { Globe, Cog } from "lucide-react"
import appConfig from "../../../../app.config.ts"
import { useUpdateStore } from "@/stores/update"
import { useAppRuntimeStore } from "@/stores/app-runtime"
import {
  applyInstallerUpdate,
  applyPortableUpdate,
  detectUpdate,
  getUpdateChannel,
  getUpdateRuntimeDiagnostics,
  getUpdateStartupStatus,
  type UpdateReleaseChannel,
  type UpdateRuntimeDiagnostics,
  type UpdateStartupStatus,
} from "@/lib/update-check"

type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "up-to-date" | "error"

interface UpdateState {
  status: UpdateStatus
  message: string
  progress: number
  newVersion?: string
}

export function AboutPanel() {
  const { t } = useI18n()
  const cloudEnabled = useAppRuntimeStore((state) => state.cloudEnabled)
  const [version, setVersion] = useState("")
  // "portable" = 免安装/U盘版，走双 exe 就地替换；"installer" = 安装版，走 Tauri updater；
  // "disabled" = 离线版，编译期禁用联网更新；诊断信息仍可查看。
  const [channel, setChannel] = useState<"portable" | "installer" | "disabled" | "">("")
  const [update, setUpdate] = useState<UpdateState>({
    status: "idle",
    message: "",
    progress: 0,
  })
  const [releaseChannel, setReleaseChannel] = useState<UpdateReleaseChannel>("stable")
  const [savingChannel, setSavingChannel] = useState(false)
  const [diagnostics, setDiagnostics] = useState<UpdateRuntimeDiagnostics | null>(null)
  const [startupStatus, setStartupStatus] = useState<UpdateStartupStatus | null>(null)
  const setUpdateAvailable = useUpdateStore((s) => s.setAvailable)
  const clearUpdate = useUpdateStore((s) => s.clear)
  const storeAvailable = useUpdateStore((s) => s.available)
  const storeChannel = useUpdateStore((s) => s.channel)
  const storeVersion = useUpdateStore((s) => s.version)
  const storeNotes = useUpdateStore((s) => s.notes)

  useEffect(() => {
    if (!isTauri) return

    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_version").then((v) => setVersion("v" + v))
    })
    void getUpdateChannel().then(setChannel)
    void getSettings()
      .then((settings) => setReleaseChannel(settings.update?.channel === "beta" ? "beta" : "stable"))
      .catch(() => {})
    void getUpdateRuntimeDiagnostics().then(setDiagnostics).catch(() => {})
    void getUpdateStartupStatus().then(setStartupStatus).catch(() => {})
  }, [])

  // 从启动检测的角标/toast 点进来时直接预置「立即更新」。
  useEffect(() => {
    if (!isTauri) return
    if (storeAvailable && storeChannel && storeVersion) {
      setUpdate({
        status: "available",
        message: storeNotes || `v${storeVersion}`,
        progress: 0,
        newVersion: storeVersion,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCheck = async () => {
    if (!isTauri || !cloudEnabled || channel === "disabled") return
    setUpdate({ status: "checking", message: t.settings.checkingUpdates, progress: 0 })

    try {
      const result = await detectUpdate(cloudEnabled, false)
      if (result.available) {
        setUpdate({
          status: "available",
          message: result.notes || `v${result.version}`,
          progress: 0,
          newVersion: result.version,
        })
        setUpdateAvailable({
          version: result.version,
          notes: result.notes,
          channel: result.channel,
          forceUpdate: result.forceUpdate,
          releaseId: result.releaseId,
          releaseChannel: result.releaseChannel,
          cohort: result.cohort,
          signatureVerification: result.signatureVerification,
        })
      } else {
        clearUpdate()
        setUpdate({ status: "up-to-date", message: t.settings.upToDate, progress: 0 })
        setTimeout(() => {
          setUpdate({ status: "idle", message: "", progress: 0 })
        }, 3000)
      }
    } catch (err) {
      setUpdate({
        status: "error",
        message: `${t.settings.updateError}: ${err instanceof Error ? err.message : String(err)}`,
        progress: 0,
      })
    } finally {
      void getUpdateRuntimeDiagnostics().then(setDiagnostics).catch(() => {})
    }
  }

  const handleApply = async () => {
    setUpdate((prev) => ({
      ...prev,
      status: "downloading",
      message: `${t.settings.downloading}... 0%`,
      progress: 0,
    }))
    try {
      const onProgress = (event: { phase: string; percent: number }) => {
        if (event.phase === "applying") {
          setUpdate((prev) => ({
            ...prev,
            status: "ready",
            message: t.settings.updatingRestart,
            progress: 100,
          }))
        } else {
          setUpdate((prev) => ({
            ...prev,
            status: "downloading",
            message: `${t.settings.downloading}... ${event.percent}%`,
            progress: event.percent,
          }))
        }
      }
      if (channel === "portable") {
        // Success spawns the external swap process and exits; normally does not return.
        await applyPortableUpdate(onProgress)
      } else {
        await applyInstallerUpdate(onProgress)
        setUpdate((prev) => ({
          ...prev,
          status: "ready",
          message: t.settings.readyToInstall,
          progress: 100,
        }))
      }
    } catch (err) {
      setUpdate({
        status: "error",
        message: `${t.settings.updateError}: ${err instanceof Error ? err.message : String(err)}`,
        progress: 0,
      })
    } finally {
      void getUpdateRuntimeDiagnostics().then(setDiagnostics).catch(() => {})
    }
  }

  const handleReleaseChannelChange = async (next: UpdateReleaseChannel) => {
    if (next === releaseChannel) return
    const previous = releaseChannel
    setReleaseChannel(next)
    setSavingChannel(true)
    try {
      await updateSettings({ update: { channel: next } })
      clearUpdate()
      setUpdate({ status: "idle", message: "", progress: 0 })
      const latest = await getUpdateRuntimeDiagnostics()
      setDiagnostics(latest)
    } catch {
      setReleaseChannel(previous)
    } finally {
      setSavingChannel(false)
    }
  }

  const handleRelaunch = async () => {
    if (!isTauri) return
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
    } catch {
      return
    }
  }

  const isPortable = channel === "portable"
  const isChecking = update.status === "checking"
  const updateAvailable = update.status === "available"
  const showInstall = !isPortable && update.status === "ready"
  const busy = update.status === "checking" || update.status === "downloading" || (isPortable && update.status === "ready")
  const showCheckBtn = !busy && !updateAvailable && !showInstall
  const showProgress =
    update.status === "downloading" ||
    (isPortable && update.status === "ready") ||
    (!isPortable && update.status === "ready")

  return (
    <div className="flex flex-col items-center py-12 space-y-8">
      {/* App Logo */}
      <div className="w-20 h-20 bg-gradient-to-br from-primary to-[var(--brand-strong)] rounded-3xl flex items-center justify-center shadow-[var(--shadow-raised)]">
        <Cog size={40} className="text-primary-foreground" />
      </div>

      {/* App Info */}
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold">{t.settings.appName}</h2>
        <p className="text-sm text-muted-foreground">
          {isTauri ? version : t.settings.webVersion}
        </p>
        <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">
          Your personal AI assistant — fast, private, and incredibly helpful.
        </p>
      </div>

      {isTauri && (
        <div className="w-full max-w-md space-y-4">
          {startupStatus?.previousFailure && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
              <p className="font-medium text-destructive">{t.settings.previousUpdateFailed}</p>
              <p className="mt-1 text-muted-foreground">{t.settings.previousUpdateFailedDesc}</p>
            </div>
          )}

          <div className="rounded-xl border px-4 py-3 space-y-2">
            <label className="text-sm font-medium" htmlFor="update-release-channel">
              {t.settings.updateChannel}
            </label>
            <select
              id="update-release-channel"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={releaseChannel}
              disabled={savingChannel || !cloudEnabled || channel === "disabled"}
              onChange={(event) => void handleReleaseChannelChange(event.target.value as UpdateReleaseChannel)}
            >
              <option value="stable">{t.settings.updateChannelStable}</option>
              <option value="beta">{t.settings.updateChannelBeta}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t.settings.updateChannelHint}</p>
          </div>

          {cloudEnabled && channel !== "disabled" ? (
            <div>
              {showCheckBtn && (
                <Button
                  className="w-full rounded-xl"
                  onClick={handleCheck}
                  disabled={isChecking || !channel}
                >
                  {t.settings.checkForUpdates}
                </Button>
              )}
              {updateAvailable && (
                <Button className="w-full rounded-xl" onClick={handleApply}>
                  {t.settings.updateNow}
                  {update.newVersion ? ` · v${update.newVersion}` : ""}
                </Button>
              )}
              {showInstall && (
                <Button className="w-full rounded-xl" onClick={handleRelaunch}>
                  {t.settings.restartAndUpdate}
                </Button>
              )}
              {showProgress && <Progress className="mt-3" value={update.progress} />}
              <p className="mt-3 text-sm text-muted-foreground min-h-[1.2em] text-center">
                {update.message}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center">{t.settings.updateDisabledHint}</p>
          )}

          {diagnostics && (
            <div className="rounded-xl border px-4 py-3 text-xs space-y-1">
              <p className="text-sm font-medium mb-2">{t.settings.updateDiagnostics}</p>
              <p>{t.settings.updateDiagnosticType}: {diagnostics.updateType}</p>
              <p>{t.settings.updateDiagnosticChannel}: {diagnostics.releaseChannel}</p>
              <p>{t.settings.updateDiagnosticCommit}: {diagnostics.commit || "—"}</p>
              <p>{t.settings.updateDiagnosticProvenance}: {diagnostics.provenanceStatus}</p>
              <p>{t.settings.updateDiagnosticSignature}: {diagnostics.signatureVerification}</p>
              {diagnostics.signatureKeyId && (
                <p>{t.settings.updateDiagnosticKey}: {diagnostics.signatureKeyId}</p>
              )}
            </div>
          )}
        </div>
      )}

      {!isTauri && (
        <p className="text-sm text-muted-foreground">{t.settings.webModeHint}</p>
      )}

      {/* Social links */}
      <div className="flex gap-3">
        <Button variant="outline" size="sm" className="gap-2 rounded-xl" onClick={() => openExternal(appConfig.siteBase)}>
          <Globe size={14} />
          Website
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground uppercase tracking-widest pt-4">
        &copy; 2026 XiaoJuClaw AI. All rights reserved.
      </p>
    </div>
  )
}
