// [XJC] 卡密库（虚拟商品发货）管理路由 —— 配套 web「卡密库」页面：
//   GET    /fulfillment/skus                     — 商品 + 库存概览
//   POST   /fulfillment/skus                     — 建/更新商品（无 id 自动派生）
//   POST   /fulfillment/skus/:id/cards           — 批量导入卡密
//   POST   /fulfillment/skus/:id/clear-available — 清空未发库存（导错纠正；台账不动）
//   DELETE /fulfillment/skus/:id                 — 删除商品（连卡密与台账）
//   GET    /fulfillment/deliveries?skuId=&limit= — 发货台账（对账）
// 卡密含账号/密钥属敏感数据，只存本机 SQLite，绝不上云。引擎见 src/fulfillment/store.ts。

import { Hono } from 'hono'
import {
  addCards,
  clearAvailableCards,
  deleteSku,
  getSku,
  listDeliveries,
  listSkus,
  upsertSku,
  FulfillmentError,
} from '../fulfillment/store.ts'
import { getLogger } from '../logger/index.ts'

/**
 * 从标题派生 SKU id：纯 ASCII 标题转小写短横线 slug；
 * 含中文等非 ASCII 一律用随机 id——只取 ASCII 残片（如「QQ音乐年卡」→"qq"）极易撞车。
 * 派生 slug 已被占用时也回落随机 id：UI「新建商品」语义是新建，
 * 静默 upsert 会把同名旧商品的模板/标题悄悄改掉（显式传 id 的 MCP 路径才是更新语义）。
 */
function deriveSkuId(title: string): string {
  if (!/[^\x20-\x7E]/.test(title)) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    if (/^[a-z0-9][a-z0-9-]*$/.test(slug) && slug.length >= 2 && !getSku(slug)) return slug
  }
  return `sku-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function handleError(err: unknown, fallback: string) {
  if (err instanceof FulfillmentError) {
    return { status: 400 as const, body: { error: err.message, errorCode: err.code } }
  }
  getLogger().error({ error: String(err), category: 'fulfillment' }, fallback)
  return { status: 500 as const, body: { error: fallback } }
}

export function createFulfillmentRoutes() {
  const app = new Hono()

  app.get('/fulfillment/skus', (c) => {
    return c.json({ skus: listSkus() })
  })

  app.post('/fulfillment/skus', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { id?: string; title?: string; deliveryTemplate?: string }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title) return c.json({ error: '需要商品标题' }, 400)
      const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : deriveSkuId(title)
      const sku = upsertSku({
        id,
        title,
        deliveryTemplate: typeof body.deliveryTemplate === 'string' ? body.deliveryTemplate : undefined,
      })
      return c.json({ sku })
    } catch (err) {
      const { status, body } = handleError(err, '保存商品失败')
      return c.json(body, status)
    }
  })

  app.post('/fulfillment/skus/:id/cards', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { secrets?: unknown; text?: unknown }
      // 支持数组或整段文本（一行一张），UI 用 text 更省事
      const secrets = Array.isArray(body.secrets)
        ? body.secrets.filter((s): s is string => typeof s === 'string')
        : typeof body.text === 'string' ? body.text.split(/\r?\n/) : []
      const result = addCards(c.req.param('id'), secrets)
      return c.json(result)
    } catch (err) {
      const { status, body } = handleError(err, '导入卡密失败')
      return c.json(body, status)
    }
  })

  app.post('/fulfillment/skus/:id/clear-available', (c) => {
    try {
      return c.json({ cleared: clearAvailableCards(c.req.param('id')) })
    } catch (err) {
      const { status, body } = handleError(err, '清空库存失败')
      return c.json(body, status)
    }
  })

  app.delete('/fulfillment/skus/:id', (c) => {
    const ok = deleteSku(c.req.param('id'))
    if (!ok) return c.json({ error: '商品不存在' }, 404)
    return c.json({ ok: true })
  })

  app.get('/fulfillment/deliveries', (c) => {
    const skuId = c.req.query('skuId') || undefined
    const limit = Number(c.req.query('limit')) || 50
    return c.json({ deliveries: listDeliveries({ skuId, limit }) })
  })

  return app
}
