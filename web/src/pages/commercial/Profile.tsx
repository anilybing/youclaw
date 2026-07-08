import { useState } from 'react'
import { useAppRuntimeStore } from '@/stores/app'
import { notify } from '@/stores/app-runtime'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Coins, Monitor, User, Mail, Phone, ShieldCheck, KeyRound, Sparkles, LifeBuoy, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { exportDiagnosticBundle } from '@/lib/diagnostic'
import { formatApiError } from '@/lib/api-error'
import { UserAiKeyCard } from '@/components/commercial/UserAiKeyCard'

export function Profile() {
  const { user, isLoggedIn, creditBalance, cloudEnabled } = useAppRuntimeStore()
  const navigate = useNavigate()
  const mvpUser = user as typeof user & { activated?: boolean; mobile?: string }
  const [exportingDiag, setExportingDiag] = useState(false)

  async function handleExportDiagnostic() {
    setExportingDiag(true)
    try {
      const { filename } = await exportDiagnosticBundle({
        activated: mvpUser.activated ?? null,
        creditBalance: creditBalance ?? null,
      })
      notify.success('诊断包已导出', { description: filename })
    } catch (err) {
      const formatted = formatApiError(err, '导出诊断包失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setExportingDiag(false)
    }
  }

  if (!isLoggedIn || !user) {
    // 离线模式没有登录能力（/login 会被重定向），提示「请先登录」会误导用户。
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">{cloudEnabled ? '请先登录' : '离线版不提供账号功能'}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">个人中心</h1>
        <p className="text-sm text-muted-foreground mt-1">账号信息与状态</p>
      </div>

      {/* User Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <User className="h-5 w-5 text-primary" />
            账号信息
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-primary-foreground font-bold text-lg">
              {user.name?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div>
              <p className="font-semibold">{user.name}</p>
              <div className="flex items-center gap-2 mt-1">
                {mvpUser.activated ? (
                  <Badge variant="default" className="bg-green-500 text-xs gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    已激活
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <KeyRound className="h-3 w-3" />
                    未激活
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
            {mvpUser.mobile && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{mvpUser.mobile}</span>
              </div>
            )}
            {user.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span>{user.email}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Credit */}
      <Card className={(creditBalance ?? 0) <= 0 ? 'border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/30' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Coins className="h-5 w-5 text-amber-500" />
            积分余额
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{creditBalance ?? 0}</div>
          <p className="text-xs text-muted-foreground mt-1">使用模板或聊天将消耗积分，可通过激活码充值</p>
          {(creditBalance ?? 0) <= 0 && (
            <Button size="sm" className="mt-3 gap-2" onClick={() => navigate('/activation')}>
              <KeyRound className="h-4 w-4" />
              兑换激活码
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Monitor className="h-5 w-5" />
            快捷入口
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Button variant="outline" className="justify-start gap-2" onClick={() => navigate('/activation')}>
            <KeyRound className="h-4 w-4" />
            激活与设备
          </Button>
          <Button variant="outline" className="justify-start gap-2" onClick={() => navigate('/templates')}>
            <Sparkles className="h-4 w-4" />
            模板中心
          </Button>
          <Button variant="outline" className="justify-start gap-2" onClick={() => navigate('/')}>
            <Monitor className="h-4 w-4" />
            返回聊天
          </Button>
        </CardContent>
      </Card>

      {/* AI Mode + User-Key */}
      <UserAiKeyCard />

      {/* Diagnostic Export */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <LifeBuoy className="h-5 w-5 text-blue-500" />
            售后诊断
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            遇到问题时可一键导出诊断包，包含版本号、API 地址、设备路径、最近错误日志等，发送给客服可加速排查。诊断包不会包含您的 AI Key、激活码明文或登录凭据。
          </p>
          <Button onClick={handleExportDiagnostic} disabled={exportingDiag} className="gap-2">
            {exportingDiag ? <Loader2 className="h-4 w-4 animate-spin" /> : <LifeBuoy className="h-4 w-4" />}
            {exportingDiag ? '正在收集...' : '导出诊断包'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
