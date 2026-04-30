import { useState } from 'react'
import { useAppRuntimeStore } from '@/stores/app'
import { redeemInvitationCode, getDeviceList, unbindDevice, type DeviceItem } from '@/api/client'
import { notify } from '@/stores/app-runtime'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Loader2, KeyRound, Monitor, Smartphone, Unplug, Coins, Gift } from 'lucide-react'

export function Activation() {
  const { user, isLoggedIn, creditBalance, fetchUser, fetchCreditBalance } = useAppRuntimeStore()
  const [code, setCode] = useState('')
  const [redeemLoading, setRedeemLoading] = useState(false)
  const [devices, setDevices] = useState<DeviceItem[]>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [unbindTarget, setUnbindTarget] = useState<DeviceItem | null>(null)
  const [unbindLoading, setUnbindLoading] = useState(false)

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
      await redeemInvitationCode(code.trim())
      notify.success('激活成功！积分已到账')
      setCode('')
      await Promise.all([fetchUser(), fetchCreditBalance(), loadDevices()])
    } catch (err: any) {
      notify.error(err.message || '激活失败')
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
    } catch (err: any) {
      notify.error(err.message || '解绑失败')
    } finally {
      setUnbindLoading(false)
    }
  }

  const activated = isLoggedIn && user && (user as any).activated

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
            <div className="flex items-center gap-3 p-4 bg-green-500/10 rounded-lg">
              <Badge variant="default" className="bg-green-500">已激活</Badge>
              <span className="text-sm text-muted-foreground">您的账号已成功激活</span>
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
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无绑定设备，兑换激活码后自动绑定</p>
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
