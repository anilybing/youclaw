import { useEffect, useMemo, useState } from 'react'
import { useAppRuntimeStore } from '@/stores/app'
import { getTemplateList, getTemplateDetail, runTemplate, type TemplateItem, type TemplateDetail } from '@/api/client'
import { getDeviceList } from '@/api/client'
import { notify } from '@/stores/app-runtime'
import { formatApiError } from '@/lib/api-error'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Loader2, Sparkles, Coins, ArrowLeft, Zap, KeyRound, Search, Copy, Check, TrendingUp } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// 为每个分类配置渐变色（取指纹哈希）
const CATEGORY_PALETTES: Array<{ from: string; to: string; ring: string; soft: string }> = [
  { from: 'from-indigo-500', to: 'to-violet-500', ring: 'ring-indigo-500/10', soft: 'bg-indigo-50 dark:bg-indigo-950/30' },
  { from: 'from-sky-500', to: 'to-cyan-500', ring: 'ring-sky-500/10', soft: 'bg-sky-50 dark:bg-sky-950/30' },
  { from: 'from-emerald-500', to: 'to-teal-500', ring: 'ring-emerald-500/10', soft: 'bg-emerald-50 dark:bg-emerald-950/30' },
  { from: 'from-amber-500', to: 'to-orange-500', ring: 'ring-amber-500/10', soft: 'bg-amber-50 dark:bg-amber-950/30' },
  { from: 'from-rose-500', to: 'to-pink-500', ring: 'ring-rose-500/10', soft: 'bg-rose-50 dark:bg-rose-950/30' },
  { from: 'from-fuchsia-500', to: 'to-purple-500', ring: 'ring-fuchsia-500/10', soft: 'bg-fuchsia-50 dark:bg-fuchsia-950/30' },
]

function paletteFor(category: string) {
  let hash = 0
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) | 0
  return CATEGORY_PALETTES[Math.abs(hash) % CATEGORY_PALETTES.length]
}

function templateInitial(name: string) {
  const trimmed = (name || '').trim()
  return trimmed ? trimmed.charAt(0) : '•'
}

export function Templates() {
  const { creditBalance, fetchCreditBalance } = useAppRuntimeStore()
  const navigate = useNavigate()
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deviceLoading, setDeviceLoading] = useState(true)
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [runLoading, setRunLoading] = useState(false)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<string | null>(null)
  const [currentDeviceId, setCurrentDeviceId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [copied, setCopied] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string>('')

  useEffect(() => {
    async function load() {
      try {
        const tplData = await getTemplateList()
        setTemplates(tplData.items)
      } catch {
        notify.error('加载模板失败')
      } finally {
        setLoading(false)
      }
    }

    async function loadDevice() {
      try {
        const devData = await getDeviceList()
        const current = devData.items.find(d => d.isCurrent || d.bindStatus === 'bound')
        if (current) setCurrentDeviceId(current.id)
      } catch {
        setCurrentDeviceId('')
      } finally {
        setDeviceLoading(false)
      }
    }

    load()
    loadDevice()
  }, [])

  async function handleSelectTemplate(templateKey: string) {
    try {
      const listItem = templates.find(t => t.templateKey === templateKey)
      setSelectedCategory(listItem?.category || '')
      const detail = await getTemplateDetail(templateKey)
      setSelectedTemplate(detail)
      const defaults: Record<string, string> = {}
      detail.inputSchema.fields.forEach(f => { defaults[f.key] = '' })
      setInputValues(defaults)
      setResult(null)
      setCopied(false)
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
    for (const field of selectedTemplate.inputSchema.fields) {
      if (field.required && !inputValues[field.key]?.trim()) {
        notify.error(`请填写${field.label}`)
        return
      }
    }
    if ((creditBalance ?? 0) < selectedTemplate.creditCost) {
      notify.error('积分不足，请先兑换激活码')
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
    } catch (err) {
      const formatted = formatApiError(err, '执行失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setRunLoading(false)
    }
  }

  function copyResult() {
    if (!result) return
    navigator.clipboard.writeText(result)
    setCopied(true)
    notify.success('已复制到剪贴板')
    setTimeout(() => setCopied(false), 1800)
  }

  const categories = useMemo(() => [...new Set(templates.map(t => t.category))], [templates])
  const deviceReady = !!currentDeviceId

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return templates.filter(t => {
      if (activeCategory !== 'all' && t.category !== activeCategory) return false
      if (!kw) return true
      return (
        t.templateName.toLowerCase().includes(kw) ||
        t.description?.toLowerCase().includes(kw) ||
        t.category.toLowerCase().includes(kw)
      )
    })
  }, [templates, search, activeCategory])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-7 w-7 animate-spin" />
          <span className="text-sm">加载模板中心…</span>
        </div>
      </div>
    )
  }

  const grouped: Array<{ category: string; items: TemplateItem[] }> = (activeCategory === 'all'
    ? categories.map(c => ({ category: c, items: filtered.filter(t => t.category === c) }))
    : [{ category: activeCategory, items: filtered }]
  ).filter(g => g.items.length > 0)

  return (
    <div className="flex-1 overflow-auto custom-scrollbar">
      {/* Hero Header */}
      <div className="relative overflow-hidden border-b bg-gradient-to-br from-background via-background to-primary/5">
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-gradient-to-br from-primary/20 to-transparent blur-3xl" />
          <div className="absolute -bottom-32 -left-32 w-80 h-80 rounded-full bg-gradient-to-tr from-violet-500/10 to-transparent blur-3xl" />
        </div>
        <div className="relative px-6 md:px-10 py-8 md:py-10">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-3 py-1 text-xs font-medium">
                  <Sparkles className="h-3.5 w-3.5" />
                  AI 模板中心
                </div>
                <Badge variant="outline" className="text-xs font-normal text-muted-foreground">
                  {templates.length} 个可用
                </Badge>
              </div>
              <h1 className="text-[28px] md:text-3xl font-bold tracking-tight leading-tight">
                选择模板，一键生成专业内容
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                覆盖商品文案、卖点提炼、场景策划等常用场景，填入参数即可调用 AI 生成结果。
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-xl border bg-card/70 backdrop-blur px-4 py-3 shadow-sm">
              <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-amber-100 dark:bg-amber-950/40">
                <Coins className="h-4.5 w-4.5 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">当前余额</div>
                <div className="text-xl font-bold tabular-nums leading-tight">{creditBalance ?? 0}<span className="text-xs font-medium text-muted-foreground ml-1">积分</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 md:px-10 py-6 space-y-6">
        {/* Device binding banner */}
        {!deviceReady && !deviceLoading && (
          <div className="rounded-xl border border-amber-200/70 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/20 dark:to-orange-950/20 dark:border-amber-900/50 p-4 shadow-sm">
            <div className="flex items-start md:items-center justify-between gap-4 flex-col md:flex-row">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center">
                  <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">当前账号尚未绑定设备</p>
                  <p className="text-xs text-amber-800/80 dark:text-amber-200/70 mt-0.5 leading-relaxed">兑换激活码后会自动绑定当前设备，之后即可执行所有模板。</p>
                </div>
              </div>
              <Button size="sm" onClick={() => navigate('/activation')} className="self-stretch md:self-auto">
                去激活
              </Button>
            </div>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索模板名称或关键词…"
              className="pl-9 h-10"
            />
          </div>
          {categories.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterChip
                label="全部"
                active={activeCategory === 'all'}
                onClick={() => setActiveCategory('all')}
                count={templates.length}
              />
              {categories.map(cat => (
                <FilterChip
                  key={cat}
                  label={cat}
                  active={activeCategory === cat}
                  onClick={() => setActiveCategory(cat)}
                  count={templates.filter(t => t.category === cat).length}
                />
              ))}
            </div>
          )}
        </div>

        {/* Empty state */}
        {templates.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-16 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <Sparkles className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-base font-medium">暂无可用模板</p>
              <p className="text-sm text-muted-foreground mt-1">模板上线后会自动出现在这里</p>
            </CardContent>
          </Card>
        ) : grouped.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-14 text-center">
              <Search className="h-10 w-10 mx-auto text-muted-foreground/60" />
              <p className="text-sm font-medium mt-3">没有找到匹配的模板</p>
              <p className="text-xs text-muted-foreground mt-1">试试更换关键词或选择其他分类</p>
            </CardContent>
          </Card>
        ) : (
          grouped.map(({ category, items }) => {
            const palette = paletteFor(category)
            return (
              <section key={category}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <span className={`inline-flex h-6 w-1 rounded-full bg-gradient-to-b ${palette.from} ${palette.to}`} />
                    <h2 className="text-base font-semibold tracking-tight">{category}</h2>
                    <span className="text-xs text-muted-foreground font-medium">{items.length} 个模板</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                  {items.map(tpl => {
                    const insufficient = (creditBalance ?? 0) < tpl.creditCost
                    return (
                      <button
                        key={tpl.templateKey}
                        type="button"
                        onClick={() => handleSelectTemplate(tpl.templateKey)}
                        className="group relative text-left rounded-xl border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-8px_rgba(15,23,42,0.14)] hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 overflow-hidden"
                      >
                        {/* Accent corner */}
                        <div className={`absolute top-0 right-0 w-24 h-24 -mr-12 -mt-12 rounded-full bg-gradient-to-br ${palette.from} ${palette.to} opacity-10 group-hover:opacity-20 transition-opacity duration-300`} />

                        <div className="relative flex items-start gap-3">
                          <div className={`flex-shrink-0 w-11 h-11 rounded-lg bg-gradient-to-br ${palette.from} ${palette.to} flex items-center justify-center text-white text-lg font-semibold shadow-sm`}>
                            {templateInitial(tpl.templateName)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="text-sm font-semibold leading-tight tracking-tight truncate">{tpl.templateName}</h3>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed line-clamp-2">
                              {tpl.description || '暂无描述'}
                            </p>
                          </div>
                        </div>

                        <div className="relative flex items-center justify-between mt-4 pt-3 border-t border-border/60">
                          <div className="flex items-center gap-1.5 text-xs">
                            <Coins className={`h-3.5 w-3.5 ${insufficient ? 'text-destructive' : 'text-amber-500'}`} />
                            <span className={`font-semibold tabular-nums ${insufficient ? 'text-destructive' : ''}`}>{tpl.creditCost}</span>
                            <span className="text-muted-foreground">积分</span>
                          </div>
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                            <Zap className="h-3 w-3" />
                            执行
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })
        )}
      </div>

      {/* Detail / Run Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-xl p-0 overflow-hidden gap-0">
          {selectedTemplate && (() => {
            const palette = paletteFor(selectedCategory)
            return (
              <>
                <DialogHeader className={`relative px-6 py-5 bg-gradient-to-br from-muted/40 to-transparent border-b`}>
                  <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${palette.from} ${palette.to}`} />
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 w-11 h-11 rounded-lg bg-gradient-to-br ${palette.from} ${palette.to} flex items-center justify-center text-white text-lg font-semibold shadow-sm`}>
                      {templateInitial(selectedTemplate.templateName)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <DialogTitle className="text-base font-semibold tracking-tight">
                        {selectedTemplate.templateName}
                      </DialogTitle>
                      <DialogDescription className="text-xs mt-1 leading-relaxed">
                        {selectedTemplate.description || '暂无描述'}
                      </DialogDescription>
                    </div>
                  </div>
                </DialogHeader>

                <div className="px-6 py-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
                  {result ? (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          <TrendingUp className="h-3.5 w-3.5" />
                          生成成功
                        </div>
                      </div>
                      <div className="rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed whitespace-pre-wrap max-h-80 overflow-auto custom-scrollbar">
                        {result}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3.5 py-2.5">
                        <div className="flex items-center gap-2 text-xs">
                          <Coins className="h-3.5 w-3.5 text-amber-500" />
                          <span className="text-muted-foreground">本次消耗</span>
                          <span className="font-semibold tabular-nums">{selectedTemplate.creditCost}</span>
                          <span className="text-muted-foreground">积分</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          余额 <span className="font-semibold tabular-nums text-foreground">{creditBalance ?? 0}</span>
                        </div>
                      </div>

                      {selectedTemplate.inputSchema.fields.map(field => (
                        <div key={field.key} className="space-y-1.5">
                          <Label htmlFor={field.key} className="text-xs font-medium">
                            {field.label}
                            {field.required && <span className="text-destructive ml-0.5">*</span>}
                          </Label>
                          {field.type === 'textarea' ? (
                            <Textarea
                              id={field.key}
                              placeholder={field.placeholder}
                              value={inputValues[field.key] || ''}
                              onChange={e => setInputValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                              maxLength={field.maxLength}
                              rows={4}
                              className="resize-y"
                            />
                          ) : field.type === 'select' ? (
                            <select
                              id={field.key}
                              value={inputValues[field.key] || ''}
                              onChange={e => setInputValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-colors"
                            >
                              <option value="">请选择</option>
                              {(field.options || []).map(option => (
                                <option key={option} value={option}>{option}</option>
                              ))}
                            </select>
                          ) : (
                            <Input
                              id={field.key}
                              placeholder={field.placeholder}
                              value={inputValues[field.key] || ''}
                              onChange={e => setInputValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                              maxLength={field.maxLength}
                            />
                          )}
                        </div>
                      ))}

                      {!currentDeviceId && (
                        <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                          <div className="flex items-center gap-2">
                            <KeyRound className="h-3.5 w-3.5" />
                            请先兑换激活码绑定设备
                          </div>
                          <button type="button" className="font-medium underline" onClick={() => navigate('/activation')}>
                            去激活
                          </button>
                        </div>
                      )}

                      {(creditBalance ?? 0) < selectedTemplate.creditCost && (
                        <div className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                          <div className="flex items-center gap-2">
                            <Coins className="h-3.5 w-3.5" />
                            积分不足，当前余额 {creditBalance ?? 0}
                          </div>
                          <button type="button" className="font-medium underline" onClick={() => navigate('/activation')}>
                            兑换激活码
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="px-6 py-4 border-t bg-muted/20">
                  {result ? (
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setResult(null)} className="gap-1.5 flex-1">
                        <ArrowLeft className="h-3.5 w-3.5" />
                        重新填写
                      </Button>
                      <Button onClick={copyResult} className="gap-1.5 flex-1">
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        {copied ? '已复制' : '复制结果'}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      onClick={handleRun}
                      disabled={
                        runLoading ||
                        !currentDeviceId ||
                        (creditBalance ?? 0) < selectedTemplate.creditCost
                      }
                      className="w-full gap-2"
                      size="lg"
                    >
                      {runLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          AI 生成中…
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" />
                          执行模板
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Filter chip
// ----------------------------------------------------------------------------

function FilterChip({
  label,
  active,
  onClick,
  count,
}: {
  label: string
  active: boolean
  onClick: () => void
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      }`}
    >
      <span>{label}</span>
      <span className={`tabular-nums ${active ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>
        {count}
      </span>
    </button>
  )
}
