// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useI18n } from "@/i18n"
import { useAppRuntimeStore } from "@/stores/app"
import { mvpLogin, syncRemoteStaff } from "@/api/client"
import { ApiError } from "@/lib/api-error"
import { useWorkbenchCardsStore } from "@/stores/workbench-cards"
import {
  BookOpenCheck,
  Calendar,
  Loader2,
  Lock,
  LogIn,
  MessageSquare,
  Phone,
  Settings2,
  ShieldCheck,
  UserRound,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isTauri } from "@/api/transport"
import { WindowsTitleBar } from "@/components/layout/WindowsTitleBar"
import { SettingsDialog, type SettingsTab } from "@/components/settings/SettingsDialog"
import { notify } from "@/stores/app-runtime"
import logoUrl from "@/assets/logo.png"

const LOGIN_SETTINGS_TABS: SettingsTab[] = ["general", "models", "environment", "about"]

export function Login() {
  const { t } = useI18n()
  const { authLoading, fetchUser, fetchCreditBalance, enterOfflineFallback } = useAppRuntimeStore()
  const navigate = useNavigate()
  const [version, setVersion] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobile, setMobile] = useState("")
  const [password, setPassword] = useState("")
  const [loginInProgress, setLoginInProgress] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_version").then((v) => setVersion("v" + v))
    })
  }, [])

  function isCloudUnreachable(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false
    if (err.status === 0 || err.errorCode === "NETWORK_ERROR") return true
    if (err.errorCode === "CLOUD_UNREACHABLE") return true
    // A structured cloud business error (kill switch, invalid credentials, etc.)
    // proves the server responded and should be shown in place.
    return err.status >= 500 && !err.errorCode
  }

  function loginErrorMessage(err: unknown): string {
    if (!(err instanceof ApiError)) {
      return err instanceof Error ? err.message : t.login.loginUnavailable
    }
    const messages: Record<string, string> = {
      LOGIN_INPUT_INVALID: err.message || t.login.passwordRequired,
      LOGIN_FAILED: t.login.loginFailed,
      LOGIN_KILL_SWITCH_ON: t.login.loginUnavailable,
      REGISTER_KILL_SWITCH_ON: t.login.loginUnavailable,
      USER_DISABLED: t.login.userDisabled,
      CLOUD_NOT_CONFIGURED: t.login.loginUnavailable,
      LOGIN_RESPONSE_INVALID: t.login.loginUnavailable,
    }
    return messages[err.errorCode] || err.message || t.login.loginUnavailable
  }

  function goOffline() {
    enterOfflineFallback()
    navigate("/today", { replace: true })
  }

  function enterOfflineAfterFailure() {
    notify.info(t.login.offlineEntered, { description: t.login.offlineEnteredDesc })
    goOffline()
  }

  async function handleLogin() {
    const value = mobile.trim()
    if (!value) {
      notify.error(t.login.mobileRequired)
      return
    }
    if (!password || password.length < 6) {
      notify.error(t.login.passwordRequired)
      return
    }
    setLoginInProgress(true)
    try {
      await mvpLogin({ mobile: value, password })
      await fetchUser()
      await fetchCreditBalance()
      notify.success(t.login.loginSuccess)
      // 登录后拉取服务端下发的能力（数字员工 + 工作台卡），首登即可用，无需重启
      void syncRemoteStaff().catch(() => {})
      void useWorkbenchCardsStore.getState().fetchCards()
    } catch (err) {
      // 连不上远程服务器（网络失败 / 代理层 5xx）：不困在登录页，直接降级为离线可用。
      if (isCloudUnreachable(err)) {
        enterOfflineAfterFailure()
        return
      }
      notify.error(loginErrorMessage(err))
    } finally {
      setLoginInProgress(false)
    }
  }

  const isLoading = authLoading || loginInProgress

  const features = [
    {
      icon: Calendar,
      title: t.login.featureSchedule,
      desc: t.login.featureScheduleDesc,
      chip: "bg-primary/12 text-primary",
    },
    {
      icon: MessageSquare,
      title: t.login.featureChat,
      desc: t.login.featureChatDesc,
      chip: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
    },
    {
      icon: ShieldCheck,
      title: t.login.featureIntegration,
      desc: t.login.featureIntegrationDesc,
      chip: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    },
  ]

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--background)]">
      {/* 无边框窗口下登录页也需要可拖拽/关闭（组件自守卫，仅 Windows 桌面渲染） */}
      <WindowsTitleBar />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left hero area - large screens only */}
        <section className="relative hidden lg:flex flex-1 flex-col overflow-hidden border-r border-[var(--subtle-border)] px-14 py-12">
          {/* Ambient sunrise — the one place we spend real color, tied to the
              tangerine brand so the empty space reads as atmosphere, not filler. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div
              className="absolute inset-0"
              style={{ background: "linear-gradient(158deg, color-mix(in oklab, var(--brand) 11%, var(--background)), var(--background) 52%)" }}
            />
            <div
              className="absolute -left-28 -top-28 h-[540px] w-[540px] rounded-full blur-3xl opacity-70"
              style={{ background: "radial-gradient(circle, var(--brand-glow), transparent 68%)" }}
            />
            <div
              className="absolute right-[-12%] top-1/3 h-[420px] w-[420px] rounded-full blur-3xl opacity-60"
              style={{ background: "radial-gradient(circle, var(--ambient-cool), transparent 70%)" }}
            />
          </div>

          <header className="relative z-10">
            <div className="flex items-center gap-2.5">
              <img src={logoUrl} alt="" draggable={false} className="h-9 w-9 rounded-xl shadow-[var(--shadow-soft)]" />
              <span className="text-base font-semibold tracking-tight text-foreground">XiaoJuClaw</span>
            </div>
            <h2 className="mt-12 max-w-md text-[2.6rem] font-bold leading-[1.08] tracking-tight text-foreground">
              {t.login.heroTitle}
            </h2>
            <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
              {t.login.heroDesc}
            </p>
          </header>

          {/* Feature cards */}
          <div className="relative z-10 my-auto flex justify-center py-10">
            <div className="w-full max-w-sm space-y-3.5 motion-safe:animate-[login-drift_8s_ease-in-out_infinite]">
              {features.map((feature) => (
                <div key={feature.title} className="surface-card flex items-center gap-4 p-4">
                  <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${feature.chip}`}>
                    <feature.icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{feature.title}</p>
                    <p className="text-xs text-muted-foreground">{feature.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <footer className="relative z-10 text-xs font-medium text-muted-foreground">
            <span>&copy; 2026 XiaoJuClaw</span>
          </footer>
        </section>

        {/* Right: mobile + password login. The panel scrolls on small Windows viewports. */}
        <section className="w-full overflow-y-auto border-l border-[var(--subtle-border)] bg-[var(--card)] lg:w-[440px]">
          <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 px-6 py-8 md:px-9">
            <header className="w-full text-center">
              <div className="relative inline-grid place-items-center">
                <span
                  aria-hidden
                  className="absolute inset-0 -z-10 rounded-[1.5rem] blur-xl opacity-70"
                  style={{ background: "radial-gradient(circle, var(--brand-glow), transparent 70%)" }}
                />
                <img
                  src={logoUrl}
                  alt="XiaoJuClaw Logo"
                  draggable={false}
                  className="h-[72px] w-[72px] rounded-[1.3rem] border border-[var(--subtle-border)] bg-white p-2 shadow-[var(--shadow-raised)] transition-transform duration-300 hover:scale-105"
                />
              </div>
              <h1 className="mt-4 text-2xl font-bold tracking-tight">
                <span className="text-gradient-brand">XiaoJuClaw</span>
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{t.login.subtitle}</p>
            </header>

            <form
              className="w-full space-y-4"
              data-testid="password-login-form"
              onSubmit={(event) => {
                event.preventDefault()
                void handleLogin()
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="mobile">{t.login.mobileLabel}</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="mobile"
                    type="tel"
                    autoComplete="username"
                    className="h-11 pl-9"
                    placeholder={t.login.mobilePlaceholder}
                    value={mobile}
                    disabled={isLoading}
                    onChange={(event) => setMobile(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">{t.login.passwordLabel}</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    className="h-11 pl-9"
                    placeholder={t.login.passwordPlaceholder}
                    value={password}
                    disabled={isLoading}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
              </div>

              <Button
                type="submit"
                size="lg"
                disabled={isLoading}
                className="w-full gap-2 py-6 text-sm font-semibold rounded-xl shadow-[var(--shadow-soft)] active:scale-[0.98] transition-all duration-200"
              >
                {loginInProgress || authLoading ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {t.login.loggingIn}
                  </>
                ) : (
                  <>
                    <LogIn size={18} />
                    {t.login.loginButton}
                  </>
                )}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                {t.login.firstLoginHint}
              </p>
            </form>

            {/* 游客登录（复用离线模式）：无账号也能直接试用本地能力 */}
            <div className="space-y-2">
              <div className="relative flex items-center py-1">
                <span className="flex-grow border-t border-[var(--subtle-border)]" />
              </div>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={isLoading}
                onClick={goOffline}
                data-testid="guest-login-button"
                className="w-full gap-2 py-6 text-sm font-semibold rounded-xl active:scale-[0.98] transition-all duration-200"
              >
                <UserRound size={18} />
                {t.login.guestLogin}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                {t.login.guestLoginDesc}
              </p>
            </div>

            <footer className="flex items-center justify-center gap-3 border-t border-[var(--subtle-border)] pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2 rounded-xl"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={14} />
                {t.settings.title}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2 rounded-xl"
                onClick={() => navigate("/guide")}
              >
                <BookOpenCheck size={14} />
                {t.nav.userGuide}
              </Button>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                {isTauri ? version : t.settings.webVersion}
              </span>
            </footer>
          </div>
        </section>

        <style>{`
          @keyframes login-drift {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-12px); }
          }
        `}</style>
      </div>
      {settingsOpen && (
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialTab="general"
          allowedTabs={LOGIN_SETTINGS_TABS}
        />
      )}
    </div>
  )
}
