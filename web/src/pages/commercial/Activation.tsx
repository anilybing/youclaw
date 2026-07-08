import { useEffect, useState } from 'react'
import { useAppRuntimeStore } from '@/stores/app'
import { redeemInvitationCode, getDeviceList, unbindDevice, type DeviceItem } from '@/api/client'
import { notify } from '@/stores/app-runtime'
import { formatApiError } from '@/lib/api-error'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Loader2, KeyRound, Monitor, Smartphone, Unplug, Coins, Gift, ShieldCheck } from 'lucide-react'

export function Activation() {
  const { user, isLoggedIn, creditBalance, fetchUser, fetchCreditBalance, cloudEnabled } = useAppRuntimeStore()
  const [code, setCode] = useState('')
  const [redeemLoading, setRedeemLoading] = useState(false)
  const [devices, setDevices] = useState<DeviceItem[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [unbindTarget, setUnbindTarget] = useState<DeviceItem | null>(null)
  const [unbindLoading, setUnbindLoading] = useState(false)
  const [lastRedeem, setLastRedeem] = useState<{ planName?: string; creditGranted?: number; deviceLimit?: number } | null>(null)

  useEffect(() => {
    loadDevices()
  }, [])

  async function loadDevices() {
    setDevicesLoading(true)
    try {
      const data = await getDeviceList()
      setDevices(data.items)
    } catch {
      // Not bound yet, ignore
    } finally {
      setDevicesLoading(false)
    }
  }

  async function handleRedeem() {
    if (!code.trim()) {
      notify.error('请输入激活码')
      return
    }
    setRedeemLoading(true)
    try {
      const result = await redeemInvitationCode(code.trim())
      setLastRedeem(result)
      notify.success(`激活成功，到账 ${result.creditGranted ?? 0} 积分`)
      setCode('')
      await Promise.all([fetchUser(), fetchCreditBalance(), loadDevices()])
    } catch (err) {
      const formatted = formatApiError(err, '激活失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setRedeemLoading(false)
    }
  }

  async function handleUnbind() {
    if (!unbindTarget) return
    setUnbindLoading(true)
    try {
      await unbindDevice(unbindTarget.id)
      notify.success('设备已解绑')
      setUnbindTarget(null)
      await loadDevices()
    } catch (err) {
      const formatted = formatApiError(err, '解绑失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setUnbindLoading(false)
    }
  }

  const activated = isLoggedIn && Boolean((user as { activated?: boolean } | null)?.activated)

  // 离线模式（云服务未配置）：激活码/设备绑定均依赖云端，给友好提示而非可交互
  // 却必然失败的兑换表单（本页入口在侧边栏已隐藏，这里兜底直接输入 URL 的情况）。
  if (!cloudEnabled) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto" />
          <p className="text-sm font-medium">离线版无需激活</p>
          <p className="text-xs text-muted-foreground">当前版本不依赖云端服务，激活码与设备管理不可用</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">激活与设备</h1>
        <p className="text-sm text-muted-foreground mt-1">兑换激活码，管理绑定设备</p>
      </div>

      {/* Activation Code Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-5 w-5 text-primary" />
            激活码兑换
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {activated ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 bg-green-500/10 rounded-lg">
                <Badge variant="default" className="bg-green-500 gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  已激活
                </Badge>
                <span className="text-sm text-muted-foreground">您的账号已成功激活，可直接使用模板和聊天服务</span>
              </div>
              {lastRedeem && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">套餐</p>
                    <p className="text-sm font-medium mt-1">{lastRedeem.planName || 'MVP 套餐'}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">到账积分</p>
                    <p className="text-sm font-medium mt-1">{lastRedeem.creditGranted ?? 0}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">设备上限</p>
                    <p className="text-sm font-medium mt-1">{lastRedeem.deviceLimit ?? 1} 台</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="activation-code">激活码</Label>
                <div className="flex gap-2">
                  <Input
                    id="activation-code"
                    placeholder="请输入激活码，如 MVP-2026-0001"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    className="flex-1"
                  />
                  <Button onClick={handleRedeem} disabled={redeemLoading} className="gap-2">
                    {redeemLoading ? (
                      <><Loader2 className="h-4 w-4 animate-spin" />兑换中</>
                    ) : (
                      <><Gift className="h-4 w-4" />兑换</>
                    )}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                激活码在 U 盘包装内，兑换后将自动绑定当前设备并充值积分
              </p>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                未激活账号无法执行模板。若激活码遗失，请联系销售获取补发码。
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Credit Balance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Coins className="h-5 w-5 text-amber-500" />
            积分余额
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{creditBalance ?? 0}</div>
          <p className="text-xs text-muted-foreground mt-1">每次使用模板或聊天将消耗积分</p>
        </CardContent>
      </Card>

      {/* Device Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Monitor className="h-5 w-5" />
              设备管理
            </CardTitle>
            <Button variant="outline" size="sm" onClick={loadDevices} disabled={devicesLoading}>
              {devicesLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : '刷新'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {devicesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载设备...
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <Monitor className="h-8 w-8 text-muted-foreground mx-auto" />
              <p className="text-sm font-medium mt-3">暂无绑定设备</p>
              <p className="text-xs text-muted-foreground mt-1">兑换激活码后会自动绑定当前设备</p>
            </div>
          ) : (
            <div className="space-y-3">
              {devices.map(device => (
                <div key={device.id} className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    {device.osName === 'Windows' ? (
                      <Monitor className="h-5 w-5 text-muted-foreground" />
                    ) : (
                      <Smartphone className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{device.deviceName}</p>
                      <p className="text-xs text-muted-foreground">{device.osName} · {device.bindStatus === 'bound' ? '已绑定' : device.bindStatus}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {device.isCurrent && <Badge variant="secondary" className="text-xs">当前</Badge>}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setUnbindTarget(device)}
                      className="text-destructive hover:text-destructive gap-1"
                    >
                      <Unplug className="h-3 w-3" />
                      解绑
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Unbind Confirmation */}
      <AlertDialog open={!!unbindTarget} onOpenChange={(open) => { if (!open) setUnbindTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认解绑设备</AlertDialogTitle>
            <AlertDialogDescription>
              确定要解绑设备「{unbindTarget?.deviceName}」吗？解绑后该设备将无法使用服务。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUnbind}
              disabled={unbindLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {unbindLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : '确认解绑'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
