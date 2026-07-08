// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useI18n } from "@/i18n"
import { useAppRuntimeStore } from "@/stores/app"
import { mvpLogin, syncRemoteStaff } from "@/api/client"
import { ApiError } from "@/lib/api-error"
import { useWorkbenchCardsStore } from "@/stores/workbench-cards"
import { LogIn, Loader2, Calendar, MessageSquare, ShieldCheck, Settings2, Phone, Mail } from "lucide-react"
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

export function Login() {
  const { t } = useI18n()
  const { authLoading, fetchUser, fetchCreditBalance, enterOfflineFallback } = useAppRuntimeStore()
  const navigate = useNavigate()
  const [version, setVersion] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loginMethod, setLoginMethod] = useState<"mobile" | "email">("mobile")
  const [mobile, setMobile] = useState("")
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [loginInProgress, setLoginInProgress] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string>("get_version").then((v) => setVersion("v" + v))
    })
  }, [])

  async function handleLogin() {
    setLoginInProgress(true)
    try {
      const params: { mobile?: string; email?: string; displayName?: string } = {}
      if (loginMethod === "mobile") {
        if (!mobile.trim()) {
          notify.error("请输入手机号")
          return
        }
        params.mobile = mobile.trim()
      } else {
        if (!email.trim()) {
          notify.error("请输入邮箱")
          return
        }
        params.email = email.trim()
      }
      if (displayName.trim()) {
        params.displayName = displayName.trim()
      }

      await mvpLogin(params)
      await fetchUser()
      await fetchCreditBalance()
      notify.success("登录成功")
      // 登录后拉取服务端下发的能力（数字员工 + 工作台卡），首登即可用，无需重启
      void syncRemoteStaff().catch(() => {})
      void useWorkbenchCardsStore.getState().fetchCards()
    } catch (err) {
      // 连不上远程服务器（网络失败 / 代理层 5xx）：不困在登录页，直接降级为离线可用。
      const unreachable = err instanceof ApiError && (err.status === 0 || err.status >= 500 || err.errorCode === 'NETWORK_ERROR')
      if (unreachable) {
        notify.info("暂时无法连接服务器，已进入离线模式", { description: "可用本地模型与内置数字员工；联网后可在登录页登录以使用云端功能" })
        goOffline()
        return
      }
      notify.error(err instanceof Error ? err.message : "登录失败")
    } finally {
      setLoginInProgress(false)
    }
  }

  function goOffline() {
    enterOfflineFallback()
    navigate("/workbench", { replace: true })
  }

  const isLoading = authLoading || loginInProgress

  return (
    <div className="h-screen w-screen flex flex-col bg-gradient-to-br from-background to-muted/30">
      {/* 无边框窗口下登录页也需要可拖拽/关闭（组件自守卫，仅 Windows 桌面渲染） */}
      <WindowsTitleBar />
      <div className="flex-1 flex overflow-hidden">
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

        {/* Right: Login area */}
        <section className="w-full lg:w-[420px] flex flex-col items-center justify-between p-8 md:p-12 bg-card">
          <div className="w-full text-center mt-8">
            <div className="inline-block transition-transform hover:scale-105 duration-300">
              <img
                src={logoUrl}
                alt="XiaoJuClaw Logo"
                className="w-28 h-28 p-3 mx-auto rounded-3xl shadow-lg border border-border/50 bg-white"
              />
            </div>
            <h1 className="mt-6 text-2xl font-bold text-foreground tracking-tight">XiaoJuClaw</h1>
            <p className="text-muted-foreground text-sm mt-1">{t.login.subtitle}</p>
          </div>

          <div className="w-full max-w-sm space-y-6">
            <Tabs value={loginMethod} onValueChange={(v: string) => setLoginMethod(v as "mobile" | "email")}>
              <TabsList className="w-full">
                <TabsTrigger value="mobile" className="flex-1 gap-1.5">
                  <Phone className="h-3.5 w-3.5" />
                  手机号
                </TabsTrigger>
                <TabsTrigger value="email" className="flex-1 gap-1.5">
                  <Mail className="h-3.5 w-3.5" />
                  邮箱
                </TabsTrigger>
              </TabsList>

              <TabsContent value="mobile" className="space-y-4 mt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="mobile">手机号</Label>
                  <Input
                    id="mobile"
                    placeholder="请输入手机号"
                    value={mobile}
                    onChange={(e) => setMobile(e.target.value)}
                  />
                </div>
              </TabsContent>

              <TabsContent value="email" className="space-y-4 mt-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">邮箱</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="请输入邮箱地址"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </TabsContent>
            </Tabs>

            <div className="space-y-1.5">
              <Label htmlFor="displayName">昵称（选填）</Label>
              <Input
                id="displayName"
                placeholder="给自己取个名字"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>

            <Button
              size="lg"
              onClick={handleLogin}
              disabled={isLoading}
              className="w-full gap-2 py-6 text-sm font-semibold rounded-xl shadow-lg shadow-primary/20 active:scale-[0.98] transition-all duration-200"
            >
              {isLoading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  {t.account.loggingIn}
                </>
              ) : (
                <>
                  <LogIn size={18} />
                  登录 / 注册
                </>
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              首次登录将自动创建账号
            </p>

            <div className="text-center">
              <button
                type="button"
                onClick={goOffline}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline transition-colors"
              >
                连不上服务器？离线使用（本地模型 + 内置数字员工）
              </button>
            </div>

            <div className="pt-6 border-t border-border/50 text-center">
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
            </div>
          </div>

          <div className="w-full text-center">
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
              {isTauri ? version : t.settings.webVersion}
            </span>
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
