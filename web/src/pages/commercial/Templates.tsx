import { useEffect, useState } from 'react'
import { useAppRuntimeStore } from '@/stores/app'
import { getTemplateList, getTemplateDetail, runTemplate, type TemplateItem, type TemplateDetail } from '@/api/client'
import { getDeviceList, type DeviceItem } from '@/api/client'
import { notify } from '@/stores/app-runtime'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Loader2, Sparkles, Coins, ArrowLeft, Zap } from 'lucide-react'

export function Templates() {
  const { creditBalance, fetchCreditBalance } = useAppRuntimeStore()
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [runLoading, setRunLoading] = useState(false)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceItem[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string>('')

  useEffect(() => {
    async function load() {
      try {
        const [tplData, devData] = await Promise.all([
          getTemplateList(),
          getDeviceList(),
        ])
        setTemplates(tplData.items)
        setDevices(devData.items)
        const current = devData.items.find(d => d.isCurrent || d.bindStatus === 'bound')
        if (current) setCurrentDeviceId(current.id)
      } catch {
        notify.error('加载模板失败')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  async function handleSelectTemplate(templateKey: string) {
    try {
      const detail = await getTemplateDetail(templateKey)
      setSelectedTemplate(detail)
      const defaults: Record<string, string> = {}
      detail.inputSchema.fields.forEach(f => { defaults[f.key] = '' })
      setInputValues(defaults)
      setResult(null)
      setDetailOpen(true)
    } catch {
      notify.error('获取模板详情失败')
    }
  }

  async function handleRun() {
    if (!selectedTemplate || !currentDeviceId) {
      notify.error('请先绑定设备')
      return
    }
    setRunLoading(true)
    try {
      const res = await runTemplate({
        templateKey: selectedTemplate.templateKey,
        inputPayload: inputValues,
        deviceId: currentDeviceId,
      })
      setResult(res.outputContent)
      await fetchCreditBalance()
      notify.success('执行成功')
    } catch (err: any) {
      notify.error(err.message || '执行失败')
    } finally {
      setRunLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const categories = [...new Set(templates.map(t => t.category))]

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">模板中心</h1>
          <p className="text-sm text-muted-foreground mt-1">选择模板，快速生成专业内容</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Coins className="h-4 w-4 text-amber-500" />
          <span className="font-medium">{creditBalance ?? 0} 积分</span>
        </div>
      </div>

      {categories.map(category => (
        <div key={category}>
          <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {category}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.filter(t => t.category === category).map(tpl => (
              <Card
                key={tpl.templateKey}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => handleSelectTemplate(tpl.templateKey)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{tpl.templateName}</CardTitle>
                    <Badge variant="secondary" className="text-xs">
                      <Coins className="h-3 w-3 mr-1" />
                      {tpl.creditCost}
                    </Badge>
                  </div>
                  <CardDescription className="text-xs">{tpl.description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      ))}

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              {selectedTemplate?.templateName}
            </DialogTitle>
            <DialogDescription>{selectedTemplate?.description}</DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4 text-sm whitespace-pre-wrap max-h-80 overflow-auto">
                {result}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setResult(null)} className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  重新填写
                </Button>
                <Button variant="outline" onClick={() => {
                  navigator.clipboard.writeText(result)
                  notify.success('已复制到剪贴板')
                }}>
                  复制结果
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Coins className="h-4 w-4 text-amber-500" />
                消耗 {selectedTemplate?.creditCost} 积分
              </div>
              {selectedTemplate?.inputSchema.fields.map(field => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={field.key} className="text-sm">
                    {field.label}
                    {field.required && <span className="text-destructive ml-1">*</span>}
                  </Label>
                  <Input
                    id={field.key}
                    placeholder={field.placeholder}
                    value={inputValues[field.key] || ''}
                    onChange={e => setInputValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    maxLength={field.maxLength}
                  />
                </div>
              ))}
              <Button
                onClick={handleRun}
                disabled={runLoading || !currentDeviceId}
                className="w-full gap-2"
              >
                {runLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    执行中...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    执行模板
                  </>
                )}
              </Button>
              {!currentDeviceId && (
                <p className="text-xs text-destructive">请先兑换激活码绑定设备</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
