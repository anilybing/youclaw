import { useAppRuntimeStore } from '@/stores/app'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Coins, Monitor, User, Mail, Phone, ShieldCheck } from 'lucide-react'

export function Profile() {
  const { user, isLoggedIn, creditBalance } = useAppRuntimeStore()
  const mvpUser = user as any

  if (!isLoggedIn || !user) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground">请先登录</p>
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
                {mvpUser.activated && (
                  <Badge variant="default" className="bg-green-500 text-xs gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    已激活
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Coins className="h-5 w-5 text-amber-500" />
            积分余额
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{creditBalance ?? 0}</div>
          <p className="text-xs text-muted-foreground mt-1">使用模板或聊天将消耗积分，可通过激活码充值</p>
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
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>• 前往「激活与设备」页面兑换激活码或管理设备</p>
          <p>• 前往「模板中心」选择模板快速生成内容</p>
          <p>• 在聊天页面可直接与 AI 自由对话</p>
        </CardContent>
      </Card>
    </div>
  )
}
