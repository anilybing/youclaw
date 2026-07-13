// [XJC] 卡密库页面（闲鱼虚拟商品自动发货配套）
// 商品+库存水位一览 → 批量导卡密 → 发货台账（订单↔卡密对账，买家扯皮时用）。
// 卡密属敏感数据：只存本机、台账默认打码、点眼睛才显示。布局风格对齐 Knowledge.tsx。
import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Copy, Eye, EyeOff, Loader2, PackagePlus, Plus, Ticket, Trash2, Eraser, ReceiptText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  getFulfillmentSkus,
  createFulfillmentSku,
  addFulfillmentCards,
  clearFulfillmentAvailable,
  deleteFulfillmentSku,
  getFulfillmentDeliveries,
  getFulfillmentDeliverySecret,
  type FulfillmentSkuDTO,
  type FulfillmentDeliveryDTO,
} from '../api/client'
import { formatApiErrorMessage } from '../lib/api-error'
import { useI18n } from '../i18n'
import { useDragRegion } from '@/hooks/useDragRegion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'

type FulfillmentCollectionViewState = 'loading' | 'error' | 'empty' | 'content'
type LoadState = 'loading' | 'ready' | 'error'

function resolveFulfillmentCollectionViewState(
  state: LoadState,
  itemCount: number,
): FulfillmentCollectionViewState {
  if (state === 'loading') return 'loading'
  if (state === 'error') return 'error'
  return itemCount === 0 ? 'empty' : 'content'
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return iso
  return date.toLocaleString()
}


export function Fulfillment() {
  const { t } = useI18n()
  const drag = useDragRegion()

  const [skus, setSkus] = useState<FulfillmentSkuDTO[]>([])
  const [deliveries, setDeliveries] = useState<FulfillmentDeliveryDTO[]>([])
  const [skuLoadState, setSkuLoadState] = useState<LoadState>('loading')
  const [deliveryLoadState, setDeliveryLoadState] = useState<LoadState>('loading')
  const [deliveryFilter, setDeliveryFilter] = useState('')
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  // [XJC] 卡密明文按需从服务端单条取,缓存在此(列表响应默认不含明文)。
  const [secrets, setSecrets] = useState<Map<string, string>>(new Map())

  // 新建商品对话框
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newTemplate, setNewTemplate] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // 导入卡密对话框
  const [importTarget, setImportTarget] = useState<FulfillmentSkuDTO | null>(null)
  const [importText, setImportText] = useState('')
  const [isImporting, setIsImporting] = useState(false)

  // 危险操作确认
  const [clearTarget, setClearTarget] = useState<FulfillmentSkuDTO | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FulfillmentSkuDTO | null>(null)

  const loadSkus = useCallback(async () => {
    setSkuLoadState('loading')
    try {
      const res = await getFulfillmentSkus()
      setSkus(res.skus)
      setSkuLoadState('ready')
    } catch {
      setSkuLoadState('error')
    }
  }, [])

  const loadDeliveries = useCallback(async (skuId: string) => {
    setDeliveryLoadState('loading')
    try {
      const res = await getFulfillmentDeliveries(skuId || undefined, 50)
      setDeliveries(res.deliveries)
      setDeliveryLoadState('ready')
    } catch {
      setDeliveryLoadState('error')
    }
  }, [])

  useEffect(() => {
    void loadSkus()
    void loadDeliveries('')
  }, [loadSkus, loadDeliveries])

  const refreshAll = useCallback(() => {
    void loadSkus()
    void loadDeliveries(deliveryFilter)
  }, [loadSkus, loadDeliveries, deliveryFilter])

  const handleCreate = async () => {
    const title = newTitle.trim()
    if (!title || isCreating) return
    setIsCreating(true)
    try {
      await createFulfillmentSku({ title, deliveryTemplate: newTemplate.trim() || undefined })
      toast.success(t.fulfillment.created)
      setCreateOpen(false)
      setNewTitle('')
      setNewTemplate('')
      void loadSkus()
    } catch (err) {
      toast.error(formatApiErrorMessage(err, t.fulfillment.saveFailed))
    } finally {
      setIsCreating(false)
    }
  }

  const handleImport = async () => {
    if (!importTarget || isImporting) return
    const text = importText.trim()
    if (!text) return
    setIsImporting(true)
    try {
      const res = await addFulfillmentCards(importTarget.id, text)
      const msg = t.fulfillment.imported.replace('{n}', String(res.added))
      toast.success(res.skipped > 0 ? `${msg}${t.fulfillment.importSkipped.replace('{n}', String(res.skipped))}` : msg)
      setImportTarget(null)
      setImportText('')
      void loadSkus()
    } catch (err) {
      toast.error(formatApiErrorMessage(err, t.fulfillment.saveFailed))
    } finally {
      setIsImporting(false)
    }
  }

  const handleClear = async (sku: FulfillmentSkuDTO) => {
    try {
      const res = await clearFulfillmentAvailable(sku.id)
      toast.success(t.fulfillment.cleared.replace('{n}', String(res.cleared)))
      void loadSkus()
    } catch (err) {
      toast.error(formatApiErrorMessage(err))
    }
  }

  const handleDelete = async (sku: FulfillmentSkuDTO) => {
    try {
      await deleteFulfillmentSku(sku.id)
      toast.success(t.fulfillment.deleted)
      refreshAll()
    } catch (err) {
      toast.error(formatApiErrorMessage(err))
    }
  }

  const handleFilterChange = (skuId: string) => {
    setDeliveryFilter(skuId)
    void loadDeliveries(skuId)
  }

  // [XJC] 按需取一次卡密明文并缓存;列表响应不含明文,故对账/复制时才拉取。
  const ensureSecret = useCallback(async (orderRef: string): Promise<string> => {
    const cached = secrets.get(orderRef)
    if (cached !== undefined) return cached
    const res = await getFulfillmentDeliverySecret(orderRef)
    const value = res.secret ?? ''
    setSecrets((prev) => {
      const next = new Map(prev)
      next.set(orderRef, value)
      return next
    })
    return value
  }, [secrets])

  const toggleReveal = async (orderRef: string) => {
    const willReveal = !revealed.has(orderRef)
    if (willReveal) {
      try {
        await ensureSecret(orderRef)
      } catch {
        /* 取码失败时静默不展开 */
        return
      }
    }
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(orderRef)) next.delete(orderRef)
      else next.add(orderRef)
      return next
    })
  }

  const copySecret = async (orderRef: string) => {
    try {
      const secret = await ensureSecret(orderRef)
      await navigator.clipboard.writeText(secret)
      toast.success(t.fulfillment.copied)
    } catch {
      /* clipboard / 取码失败时静默 */
    }
  }

  const stockBadge = (sku: FulfillmentSkuDTO) => {
    if (sku.available === 0) {
      return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{t.fulfillment.outOfStock}</span>
    }
    if (sku.available <= 5) {
      return <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">{t.fulfillment.lowStock} {sku.available}</span>
    }
    return <span className="tabular-nums">{sku.available}</span>
  }

  const skuViewState = resolveFulfillmentCollectionViewState(skuLoadState, skus.length)
  const deliveryViewState = resolveFulfillmentCollectionViewState(deliveryLoadState, deliveries.length)
  const isRefreshing = skuLoadState === 'loading' || deliveryLoadState === 'loading'

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* 标题栏（可拖拽区域） */}
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-[var(--subtle-border)]" {...drag}>
        <div className="flex items-center gap-2">
          <Ticket className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold text-sm">{t.fulfillment.title}</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-xs"
            disabled={isRefreshing}
            onClick={refreshAll}
          >
            {isRefreshing
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            {t.workflows.refresh}
          </Button>
          <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t.fulfillment.newSku}
          </Button>
        </div>
      </div>

      {/* 说明区 */}
      <div className="px-4 py-3 border-b border-[var(--subtle-border)] bg-muted/20">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Ticket className="h-4 w-4 text-muted-foreground" />
          <span>{t.fulfillment.subtitle}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t.fulfillment.hint}</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 商品与库存 */}
        <div className="px-4 py-4">
          {skuViewState === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" data-testid="fulfillment-skus-loading">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.common.loading}
            </div>
          ) : skuViewState === 'error' ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" data-testid="fulfillment-skus-error">
              <AlertTriangle className="h-10 w-10 text-destructive/60" />
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void loadSkus()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t.common.retry}
              </Button>
            </div>
          ) : skuViewState === 'empty' ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <PackagePlus className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">{t.fulfillment.empty}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--subtle-border)] overflow-hidden">
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/20 border-b border-[var(--subtle-border)]">
                <span>{t.fulfillment.colSku}</span>
                <span className="w-16 text-right">{t.fulfillment.colAvailable}</span>
                <span className="w-16 text-right">{t.fulfillment.colDelivered}</span>
                <span className="w-36 text-right">{t.fulfillment.colCreatedAt}</span>
                <span className="w-28" />
              </div>
              {skus.map((sku) => (
                <div
                  key={sku.id}
                  className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center px-3 py-2.5 text-sm border-b border-[var(--subtle-border)] last:border-b-0 hover:bg-[var(--surface-hover)] transition-colors"
                  data-testid="fulfillment-sku-row"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={sku.title}>{sku.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{sku.id}</div>
                  </div>
                  <span className="hidden sm:flex w-16 justify-end text-xs">{stockBadge(sku)}</span>
                  <span className="hidden sm:block w-16 text-right text-xs text-muted-foreground tabular-nums">{sku.delivered}</span>
                  <span className="hidden sm:block w-36 text-right text-xs text-muted-foreground">{formatDate(sku.createdAt)}</span>
                  <div className="flex w-28 items-center justify-end gap-1">
                    <button
                      onClick={() => { setImportTarget(sku); setImportText('') }}
                      className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title={t.fulfillment.importCards}
                      data-testid="fulfillment-import"
                    >
                      <PackagePlus className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setClearTarget(sku)}
                      className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title={t.fulfillment.clearAvailable}
                    >
                      <Eraser className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(sku)}
                      className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
                      title={t.fulfillment.deleteSku}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 发货台账 */}
        <div className="px-4 pb-6">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">{t.fulfillment.deliveriesTitle}</h3>
            </div>
            <select
              value={deliveryFilter}
              onChange={(e) => handleFilterChange(e.target.value)}
              className="h-7 rounded-md border border-[var(--subtle-border)] bg-background px-2 text-xs"
              data-testid="fulfillment-delivery-filter"
            >
              <option value="">{t.fulfillment.filterAll}</option>
              {skus.map((sku) => (
                <option key={sku.id} value={sku.id}>{sku.title}</option>
              ))}
            </select>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">{t.fulfillment.deliveriesHint}</p>
          {deliveryViewState === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground" data-testid="fulfillment-deliveries-loading">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t.common.loading}
            </div>
          ) : deliveryViewState === 'error' ? (
            <div className="flex items-center justify-center gap-2 py-6" data-testid="fulfillment-deliveries-error">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-xs"
                onClick={() => void loadDeliveries(deliveryFilter)}
              >
                <RefreshCw className="h-3 w-3" />
                {t.common.retry}
              </Button>
            </div>
          ) : deliveryViewState === 'empty' ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{t.fulfillment.deliveriesEmpty}</p>
          ) : (
            <div className="rounded-lg border border-[var(--subtle-border)] overflow-hidden">
              <div className="hidden sm:grid grid-cols-[auto_1fr_1fr_1fr_auto] gap-3 items-center px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/20 border-b border-[var(--subtle-border)]">
                <span className="w-32">{t.fulfillment.colTime}</span>
                <span>{t.fulfillment.colSku}</span>
                <span>{t.fulfillment.colOrder}</span>
                <span>{t.fulfillment.colSecret}</span>
                <span className="w-14" />
              </div>
              {deliveries.map((d) => {
                const isRevealed = revealed.has(d.orderRef)
                return (
                  <div
                    key={d.orderRef}
                    className="grid grid-cols-[1fr_auto] sm:grid-cols-[auto_1fr_1fr_1fr_auto] gap-3 items-center px-3 py-2 text-xs border-b border-[var(--subtle-border)] last:border-b-0 hover:bg-[var(--surface-hover)] transition-colors"
                    data-testid="fulfillment-delivery-row"
                  >
                    <span className="hidden sm:block w-32 text-muted-foreground">{formatDate(d.deliveredAt)}</span>
                    <span className="truncate" title={d.skuTitle}>{d.skuTitle}</span>
                    <span className="truncate font-mono" title={d.orderRef}>{d.orderRef}</span>
                    <span className="truncate font-mono" title={isRevealed ? (secrets.get(d.orderRef) ?? '') : undefined}>
                      {isRevealed ? (secrets.get(d.orderRef) ?? '') : '••••••'}
                    </span>
                    <div className="flex w-14 items-center justify-end gap-1">
                      <button
                        onClick={() => toggleReveal(d.orderRef)}
                        className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
                        title={t.fulfillment.revealSecret}
                      >
                        {isRevealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => void copySecret(d.orderRef)}
                        className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
                        title={t.fulfillment.copySecret}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 新建商品 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.fulfillment.newSku}</DialogTitle>
            <DialogDescription>{t.fulfillment.hint}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium">{t.fulfillment.skuTitleLabel}</label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t.fulfillment.skuTitlePlaceholder}
                data-testid="fulfillment-new-title"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">{t.fulfillment.templateLabel}</label>
              <Textarea
                value={newTemplate}
                onChange={(e) => setNewTemplate(e.target.value)}
                placeholder={t.fulfillment.templatePlaceholder}
                rows={3}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t.fulfillment.templateHint}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t.common.cancel}</Button>
            <Button onClick={() => void handleCreate()} disabled={!newTitle.trim() || isCreating}>
              {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t.fulfillment.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导入卡密 */}
      <Dialog open={!!importTarget} onOpenChange={(open) => !open && setImportTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.fulfillment.importTitle}</DialogTitle>
            <DialogDescription>{importTarget?.title ?? ''}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={t.fulfillment.importPlaceholder}
            rows={8}
            className="font-mono text-xs"
            data-testid="fulfillment-import-text"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportTarget(null)}>{t.common.cancel}</Button>
            <Button onClick={() => void handleImport()} disabled={!importText.trim() || isImporting}>
              {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t.fulfillment.importAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清空未发确认 */}
      <AlertDialog open={!!clearTarget} onOpenChange={(open) => !open && setClearTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.fulfillment.clearConfirm}</AlertDialogTitle>
            <AlertDialogDescription>
              {clearTarget?.title ?? ''} — {t.fulfillment.clearConfirmDesc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (clearTarget) void handleClear(clearTarget)
                setClearTarget(null)
              }}
            >
              {t.fulfillment.clearAvailable}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除商品确认 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.fulfillment.deleteConfirm}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.title ?? ''} — {t.fulfillment.deleteConfirmDesc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget)
                setDeleteTarget(null)
              }}
            >
              {t.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
