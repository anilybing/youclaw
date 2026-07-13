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

  return (
    <div className="h-screen w-screen flex flex-col bg-gradient-to-br from-background to-muted/30">
      {/* 无边框窗口下登录页也需要可拖拽/关闭（组件自守卫，仅 Windows 桌面渲染） */}
      <WindowsTitleBar />
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left hero area - large screens only */}
        <section
          className="hidden lg:flex flex-1 flex-col p-12 relative border-r border-border/50 bg-gradient-to-br from-background via-primary/5 to-background"
        >
          {/* Decorative elements */}
          <div className="absolute top-20 right-10 w-32 h-32 bg-primary/10 rounded-full blur-3xl" />
          <div className="absolute bottom-20 left-10 w-48 h-48 bg-muted/40 rounded-full blur-3xl" />

          <header className="mb-auto relative z-10">
            <h2 className="text-3xl font-bold tracking-tight text-foreground">
              {t.login.heroTitle}
            </h2>
            <p className="mt-2 text-muted-foreground max-w-sm">
              {t.login.heroDesc}
            </p>
          </header>

          {/* Feature cards */}
          <div className="flex-grow flex items-center justify-center py-10 relative z-10">
            <div className="relative w-full max-w-sm">
              <div className="animate-[float_6s_ease-in-out_infinite]">
                <div className="bg-card p-5 rounded-2xl shadow-lg border border-border/50 flex items-center gap-4 mb-5 translate-x-12">
                  <div className="bg-primary/10 p-3 rounded-xl text-primary shrink-0">
                    <Calendar className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm text-foreground">{t.login.featureSchedule}</p>
                    <p className="text-xs text-muted-foreground">{t.login.featureScheduleDesc}</p>
                  </div>
                </div>

                <div className="bg-card p-5 rounded-2xl shadow-lg border border-border/50 flex items-center gap-4 mb-5 -translate-x-4">
                  <div className="bg-blue-500/10 p-3 rounded-xl text-blue-500 shrink-0">
                    <MessageSquare className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm text-foreground">{t.login.featureChat}</p>
                    <p className="text-xs text-muted-foreground">{t.login.featureChatDesc}</p>
                  </div>
                </div>

                <div className="bg-card p-5 rounded-2xl shadow-lg border border-border/50 flex items-center gap-4 translate-x-8">
                  <div className="bg-green-500/10 p-3 rounded-xl text-green-500 shrink-0">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-semibold text-sm text-foreground">{t.login.featureIntegration}</p>
                    <p className="text-xs text-muted-foreground">{t.login.featureIntegrationDesc}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <footer className="mt-auto flex gap-6 text-xs font-medium text-muted-foreground relative z-10">
            <span>&copy; 2026 XiaoJuClaw</span>
          </footer>
        </section>

        {/* Right: mobile + password login. The panel scrolls on small Windows viewports. */}
        <section className="w-full lg:w-[420px] overflow-y-auto bg-card">
          <div className="min-h-full w-full max-w-sm mx-auto flex flex-col justify-center gap-5 px-5 py-4 md:px-8 md:py-6">
            <header className="w-full text-center">
              <div className="inline-block transition-transform hover:scale-105 duration-300">
                <img
                  src={logoUrl}
                  alt="XiaoJuClaw Logo"
                  className="w-20 h-20 p-2 mx-auto rounded-2xl shadow-lg border border-border/50 bg-white"
                />
              </div>
              <h1 className="mt-3 text-2xl font-bold text-foreground tracking-tight">XiaoJuClaw</h1>
              <p className="text-muted-foreground text-sm mt-1">{t.login.subtitle}</p>
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
                    className="pl-9"
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
                    className="pl-9"
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
                className="w-full gap-2 py-6 text-sm font-semibold rounded-xl active:scale-[0.98] transition-all duration-200"
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
                <span className="flex-grow border-t border-border/60" />
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

            <footer className="flex items-center justify-center gap-3 border-t border-border/50 pt-4">
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
          @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
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
