// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useI18n } from "@/i18n"
import { useAppRuntimeStore } from "@/stores/app"
import {
  mvpLogin,
  requestLoginOtp,
  syncRemoteStaff,
  type LoginOtpChallenge,
} from "@/api/client"
import { ApiError } from "@/lib/api-error"
import { useWorkbenchCardsStore } from "@/stores/workbench-cards"
import {
  ArrowLeft,
  Calendar,
  KeyRound,
  Loader2,
  LogIn,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { isTauri } from "@/api/transport"
import { WindowsTitleBar } from "@/components/layout/WindowsTitleBar"
import { SettingsDialog, type SettingsTab } from "@/components/settings/SettingsDialog"
import { notify } from "@/stores/app-runtime"
import logoUrl from "@/assets/logo.png"

const LOGIN_SETTINGS_TABS: SettingsTab[] = ["general", "models", "environment", "about"]
const OTP_RESEND_COOLDOWN_MS = 60_000

type LoginMethod = "mobile" | "email"
type LoginStep = "identity" | "otp"

export function Login() {
  const { t } = useI18n()
  const { authLoading, fetchUser, fetchCreditBalance, enterOfflineFallback } = useAppRuntimeStore()
  const navigate = useNavigate()
  const [version, setVersion] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("mobile")
  const [loginStep, setLoginStep] = useState<LoginStep>("identity")
  const [mobile, setMobile] = useState("")
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [otpCode, setOtpCode] = useState("")
  const [otpChallenge, setOtpChallenge] = useState<LoginOtpChallenge | null>(null)
  const [otpExpiresAt, setOtpExpiresAt] = useState(0)
  const [otpResendAt, setOtpResendAt] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const [otpRequestInProgress, setOtpRequestInProgress] = useState(false)
  const [loginInProgress, setLoginInProgress] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_version").then((v) => setVersion("v" + v))
    })
  }, [])

  useEffect(() => {
    if (loginStep !== "otp") return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [loginStep])

  function identityParams(): { mobile?: string; email?: string } | null {
    if (loginMethod === "mobile") {
      const value = mobile.trim()
      if (!value) {
        notify.error(t.login.mobileRequired)
        return null
      }
      return { mobile: value }
    }
    const value = email.trim()
    if (!value) {
      notify.error(t.login.emailRequired)
      return null
    }
    return { email: value }
  }

  function isCloudUnreachable(err: unknown): boolean {
    if (!(err instanceof ApiError)) return false
    if (err.status === 0 || err.errorCode === "NETWORK_ERROR") return true
    if (err.errorCode === "CLOUD_UNREACHABLE") return true
    // A structured cloud business error (OTP disabled, delivery failure, kill
    // switch, etc.) proves the server responded and should be shown in place.
    return err.status >= 500 && !err.errorCode
  }

  function loginErrorMessage(err: unknown): string {
    if (!(err instanceof ApiError)) {
      return err instanceof Error ? err.message : t.login.loginUnavailable
    }
    const messages: Record<string, string> = {
      OTP_RATE_LIMITED: t.login.otpRateLimited,
      OTP_DELIVERY_FAILED: t.login.otpDeliveryFailed,
      OTP_INVALID: t.login.otpInvalid,
      OTP_INPUT_INVALID: t.login.otpRequired,
      OTP_IDENTITY_MISMATCH: t.login.otpInvalid,
      OTP_REPLAYED: t.login.otpExpiredError,
      OTP_EXPIRED: t.login.otpExpiredError,
      OTP_ATTEMPTS_EXCEEDED: t.login.otpAttemptsExceeded,
      OTP_DISABLED: t.login.otpServiceDisabled,
      LOGIN_KILL_SWITCH_ON: t.login.loginUnavailable,
      REGISTER_KILL_SWITCH_ON: t.login.loginUnavailable,
      USER_DISABLED: t.login.userDisabled,
      CLOUD_NOT_CONFIGURED: t.login.loginUnavailable,
      OTP_RESPONSE_INVALID: t.login.loginUnavailable,
      LOGIN_RESPONSE_INVALID: t.login.loginUnavailable,
    }
    return messages[err.errorCode] || err.message || t.login.loginUnavailable
  }

  function enterOfflineAfterFailure() {
    notify.info(t.login.offlineEntered, { description: t.login.offlineEnteredDesc })
    goOffline()
  }

  async function handleRequestOtp() {
    const identity = identityParams()
    if (!identity) return
    setOtpRequestInProgress(true)
    try {
      const challenge = await requestLoginOtp(identity)
      const now = Date.now()
      setOtpChallenge(challenge)
      setOtpCode("")
      setOtpExpiresAt(now + Math.max(1, Number(challenge.expiresIn) || 300) * 1_000)
      setOtpResendAt(now + OTP_RESEND_COOLDOWN_MS)
      setClock(now)
      setLoginStep("otp")
    } catch (err) {
      if (isCloudUnreachable(err)) {
        enterOfflineAfterFailure()
        return
      }
      notify.error(loginErrorMessage(err))
    } finally {
      setOtpRequestInProgress(false)
    }
  }

  async function handleLogin() {
    const identity = identityParams()
    if (!identity) return
    if (!otpChallenge || !/^\d{6}$/.test(otpCode)) {
      notify.error(t.login.otpRequired)
      return
    }
    setLoginInProgress(true)
    try {
      await mvpLogin({
        ...identity,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        otpChallengeId: otpChallenge.otpChallengeId,
        otpCode,
      })
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
      if (
        err instanceof ApiError
        && ["OTP_EXPIRED", "OTP_REPLAYED", "OTP_ATTEMPTS_EXCEEDED"].includes(err.errorCode)
      ) {
        setOtpExpiresAt(0)
      }
      notify.error(loginErrorMessage(err))
    } finally {
      setLoginInProgress(false)
    }
  }

  function changeIdentity() {
    setLoginStep("identity")
    setOtpChallenge(null)
    setOtpCode("")
    setOtpExpiresAt(0)
    setOtpResendAt(0)
  }

  function goOffline() {
    enterOfflineFallback()
    navigate("/today", { replace: true })
  }

  const isLoading = authLoading || loginInProgress || otpRequestInProgress
  const otpSecondsRemaining = Math.max(0, Math.ceil((otpExpiresAt - clock) / 1_000))
  const resendSecondsRemaining = Math.max(0, Math.ceil((otpResendAt - clock) / 1_000))

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

        {/* Right: two-step OTP login. The panel scrolls on small Windows viewports. */}
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
              data-testid="otp-login-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (loginStep === "identity") void handleRequestOtp()
                else void handleLogin()
              }}
            >
              {loginStep === "identity" ? (
                <div data-testid="login-identity-step" className="space-y-4">
                  <Tabs
                    value={loginMethod}
                    onValueChange={(value: string) => setLoginMethod(value as LoginMethod)}
                  >
                    <TabsList className="w-full">
                      <TabsTrigger value="mobile" className="flex-1 gap-1.5">
                        <Phone className="h-3.5 w-3.5" />
                        {t.login.mobileTab}
                      </TabsTrigger>
                      <TabsTrigger value="email" className="flex-1 gap-1.5">
                        <Mail className="h-3.5 w-3.5" />
                        {t.login.emailTab}
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="mobile" className="mt-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="mobile">{t.login.mobileLabel}</Label>
                        <Input
                          id="mobile"
                          type="tel"
                          autoComplete="tel"
                          placeholder={t.login.mobilePlaceholder}
                          value={mobile}
                          disabled={isLoading}
                          onChange={(event) => setMobile(event.target.value)}
                        />
                      </div>
                    </TabsContent>

                    <TabsContent value="email" className="mt-4">
                      <div className="space-y-1.5">
                        <Label htmlFor="email">{t.login.emailLabel}</Label>
                        <Input
                          id="email"
                          type="email"
                          autoComplete="email"
                          placeholder={t.login.emailPlaceholder}
                          value={email}
                          disabled={isLoading}
                          onChange={(event) => setEmail(event.target.value)}
                        />
                      </div>
                    </TabsContent>
                  </Tabs>

                  <div className="space-y-1.5">
                    <Label htmlFor="displayName">{t.login.displayNameLabel}</Label>
                    <Input
                      id="displayName"
                      autoComplete="name"
                      placeholder={t.login.displayNamePlaceholder}
                      value={displayName}
                      disabled={isLoading}
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </div>

                  <Button
                    type="submit"
                    size="lg"
                    disabled={isLoading}
                    className="w-full gap-2 py-6 text-sm font-semibold rounded-xl active:scale-[0.98] transition-all duration-200"
                  >
                    {otpRequestInProgress ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        {t.login.requestingCode}
                      </>
                    ) : (
                      <>
                        <KeyRound size={18} />
                        {t.login.requestCode}
                      </>
                    )}
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    {t.login.firstLoginHint}
                  </p>
                </div>
              ) : (
                <div data-testid="login-otp-step" className="space-y-4">
                  <div className="rounded-xl border bg-muted/30 p-3 text-sm">
                    <p className="text-muted-foreground">{t.login.otpSentTo}</p>
                    <p className="mt-1 font-semibold">{otpChallenge?.maskedIdentity}</p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="otpCode">{t.login.otpLabel}</Label>
                    <Input
                      id="otpCode"
                      data-testid="otp-code-input"
                      autoFocus
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder={t.login.otpPlaceholder}
                      value={otpCode}
                      disabled={isLoading}
                      onChange={(event) => {
                        setOtpCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                      }}
                    />
                  </div>

                  <p
                    className={otpSecondsRemaining > 0 ? "text-xs text-muted-foreground" : "text-xs text-destructive"}
                    role="status"
                    aria-live="polite"
                  >
                    {otpSecondsRemaining > 0
                      ? `${t.login.otpExpiresIn} ${otpSecondsRemaining}${t.login.seconds}`
                      : t.login.otpExpired}
                  </p>

                  <Button
                    type="submit"
                    size="lg"
                    disabled={isLoading || otpCode.length !== 6 || otpSecondsRemaining === 0}
                    className="w-full gap-2 py-6 text-sm font-semibold rounded-xl active:scale-[0.98] transition-all duration-200"
                  >
                    {loginInProgress || authLoading ? (
                      <>
                        <Loader2 size={18} className="animate-spin" />
                        {t.login.verifying}
                      </>
                    ) : (
                      <>
                        <LogIn size={18} />
                        {t.login.verifyLogin}
                      </>
                    )}
                  </Button>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5 rounded-xl"
                      disabled={isLoading}
                      onClick={changeIdentity}
                    >
                      <ArrowLeft size={14} />
                      {t.login.changeIdentity}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5 rounded-xl"
                      disabled={isLoading || resendSecondsRemaining > 0}
                      onClick={() => void handleRequestOtp()}
                    >
                      {otpRequestInProgress ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      {resendSecondsRemaining > 0
                        ? `${t.login.resendIn} ${resendSecondsRemaining}${t.login.seconds}`
                        : t.login.resendCode}
                    </Button>
                  </div>

                  <p className="text-center text-xs text-muted-foreground">
                    {t.login.otpPrivacyHint}
                  </p>
                </div>
              )}
            </form>

            <div className="text-center">
              <button
                type="button"
                onClick={goOffline}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline transition-colors"
              >
                {t.login.offlineUse}
              </button>
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
