// [XJC] 虚拟商品发货引擎（闲鱼客服员工核心真能力）
//
// 场景：闲鱼卖 QQ音乐VIP/卡密/账号等虚拟商品，买家付款后需即时把卡密/账号发给买家。
// 本模块管「卡密库存」并提供**原子 + 幂等**的发货：
//   - 原子领取：一张卡只会被发出一次（并发/重试下不超发）；
//   - 幂等：同一订单重复发货返回同一张卡（消息重发/agent 重试不消耗第二张）；
//   - 缺货显式报错（OUT_OF_STOCK），绝不"发个空的"糊弄买家。
// 只做**线上虚拟商品**——不碰物理物流（打包交快递是真人动作，见 doc/抖店浏览器自动化路线分析.md）。
//
// 注意：本引擎与平台无关（纯本地 SQLite），闲鱼订单感知/消息下发是另一层（需真机客户端集成）。

import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'

export const FULFILLMENT_OUT_OF_STOCK = 'FULFILLMENT_OUT_OF_STOCK'
export const FULFILLMENT_INVALID_INPUT = 'FULFILLMENT_INVALID_INPUT'

export class FulfillmentError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'FulfillmentError'
  }
}

export interface FulfillmentSku {
  id: string
  agentId: string | null
  title: string
  deliveryTemplate: string | null
  createdAt: string
}

export interface DeliveryResult {
  /** 发给买家的完整文案（已套用模板） */
  message: string
  /** 本次实际发出的卡密原文 */
  secret: string
  /** true=幂等命中（此订单此前已发过同一张，未消耗新库存） */
  replay: boolean
}

const SKU_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SECRET_MAX = 2000
const TEMPLATE_MAX = 2000
const TITLE_MAX = 200
const IMPORT_BATCH_MAX = 5000
const SECRET_PLACEHOLDER = '{secret}'

function nowIso(): string {
  return new Date().toISOString()
}

/** 建/更新 SKU（虚拟商品条目：一句话标题 + 发货文案模板，{secret} 占位卡密） */
export function upsertSku(input: { id: string; title: string; agentId?: string | null; deliveryTemplate?: string | null }): FulfillmentSku {
  const id = input.id.trim().toLowerCase()
  if (!SKU_ID_RE.test(id)) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, 'SKU id 需为小写字母/数字/下划线/连字符（1-64 位）')
  const title = input.title.trim().slice(0, TITLE_MAX)
  if (!title) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, 'SKU 需要标题')
  const template = input.deliveryTemplate?.trim().slice(0, TEMPLATE_MAX) || null
  const agentId = input.agentId?.trim() || null
  const createdAt = nowIso()
  getDatabase().run(
    `INSERT INTO fulfillment_skus (id, agent_id, title, delivery_template, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, delivery_template = excluded.delivery_template, agent_id = excluded.agent_id`,
    [id, agentId, title, template, createdAt],
  )
  return getSku(id)!
}

export function getSku(id: string): FulfillmentSku | null {
  const row = getDatabase()
    .query('SELECT id, agent_id, title, delivery_template, created_at FROM fulfillment_skus WHERE id = ?')
    .get(id.trim().toLowerCase()) as { id: string; agent_id: string | null; title: string; delivery_template: string | null; created_at: string } | null
  if (!row) return null
  return { id: row.id, agentId: row.agent_id, title: row.title, deliveryTemplate: row.delivery_template, createdAt: row.created_at }
}

export interface ImportResult {
  added: number
  /** 批内重复 + 该 SKU 已存在（含已发出）的条数——重复导入同一批文件的典型场景 */
  skipped: number
}

/**
 * 批量导入卡密（一行一张，去空行）。
 * 同 SKU 去重：批内重复与库里已存在的（**含已发出的**）一律跳过——
 * 卖家把同一份卡密文件粘两次是高频误操作，若不去重，同一个码会卖给两个买家（第二个买家拿到已被兑换的码，必然纠纷）。
 */
export function addCards(skuId: string, secrets: string[]): ImportResult {
  const sku = getSku(skuId)
  if (!sku) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, `SKU「${skuId}」不存在，请先创建`)
  const clean = secrets.map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= SECRET_MAX)
  if (clean.length === 0) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, '没有有效卡密可导入')
  if (clean.length > IMPORT_BATCH_MAX) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, `单次最多导入 ${IMPORT_BATCH_MAX} 条（收到 ${clean.length} 条）`)

  const db = getDatabase()
  const createdAt = nowIso()
  const result = db.transaction((): ImportResult => {
    const existing = new Set(
      (db.query('SELECT secret FROM fulfillment_cards WHERE sku_id = ?').all(sku.id) as Array<{ secret: string }>).map((r) => r.secret),
    )
    let added = 0
    let skipped = 0
    for (const secret of clean) {
      if (existing.has(secret)) { skipped++; continue }
      existing.add(secret)
      db.run('INSERT INTO fulfillment_cards (sku_id, secret, status, created_at) VALUES (?, ?, ?, ?)', [sku.id, secret, 'available', createdAt])
      added++
    }
    return { added, skipped }
  })()
  getLogger().info({ skuId: sku.id, added: result.added, skipped: result.skipped, category: 'fulfillment' }, 'Cards imported')
  return result
}

/** 某 SKU 的可用/已发库存计数 */
export function getStock(skuId: string): { available: number; delivered: number } {
  const row = getDatabase()
    .query(`SELECT
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
      FROM fulfillment_cards WHERE sku_id = ?`)
    .get(skuId.trim().toLowerCase()) as { available: number | null; delivered: number | null } | null
  return { available: Number(row?.available ?? 0), delivered: Number(row?.delivered ?? 0) }
}

export interface SkuOverview extends FulfillmentSku {
  available: number
  delivered: number
}

/**
 * 列出全部 SKU + 库存（管理/工具展示用）。
 * 库存是用户本机的单一卡密库，对所有员工全局可见（agent_id 仅记录创建者，不做隔离——
 * deliverForOrder 本就不校验归属，隔离视图只会造成"明明导入了却看不到"的困惑）。
 */
export function listSkus(): SkuOverview[] {
  const rows = getDatabase()
    .query('SELECT id, agent_id, title, delivery_template, created_at FROM fulfillment_skus ORDER BY created_at DESC LIMIT 200')
    .all() as Array<{ id: string; agent_id: string | null; title: string; delivery_template: string | null; created_at: string }>
  return rows.map((r) => {
    const stock = getStock(r.id)
    return { id: r.id, agentId: r.agent_id, title: r.title, deliveryTemplate: r.delivery_template, createdAt: r.created_at, ...stock }
  })
}

export interface DeliveryRecord {
  orderRef: string
  skuId: string
  skuTitle: string
  secret: string
  deliveredAt: string
}

/** 发货台账（买家"没收到码"扯皮时对账用）：按时间倒序，可按 SKU 过滤 */
export function listDeliveries(opts: { skuId?: string; limit?: number } = {}): DeliveryRecord[] {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200)
  const skuId = opts.skuId?.trim().toLowerCase()
  const db = getDatabase()
  const base = `SELECT d.order_ref, d.sku_id, d.delivered_at, c.secret, COALESCE(s.title, d.sku_id) AS sku_title
    FROM fulfillment_deliveries d
    LEFT JOIN fulfillment_cards c ON c.id = d.card_id
    LEFT JOIN fulfillment_skus s ON s.id = d.sku_id`
  const rows = (skuId
    ? db.query(`${base} WHERE d.sku_id = ? ORDER BY d.delivered_at DESC LIMIT ?`).all(skuId, limit)
    : db.query(`${base} ORDER BY d.delivered_at DESC LIMIT ?`).all(limit)
  ) as Array<{ order_ref: string; sku_id: string; delivered_at: string; secret: string | null; sku_title: string }>
  return rows.map((r) => ({ orderRef: r.order_ref, skuId: r.sku_id, skuTitle: r.sku_title, secret: r.secret ?? '', deliveredAt: r.delivered_at }))
}

/** 清空某 SKU 的未发库存（导错卡密时纠正用；已发卡与台账保留不动），返回清掉的张数 */
export function clearAvailableCards(skuId: string): number {
  const sku = getSku(skuId)
  if (!sku) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, `SKU「${skuId}」不存在`)
  const result = getDatabase().run("DELETE FROM fulfillment_cards WHERE sku_id = ? AND status = 'available'", [sku.id])
  const cleared = Number(result?.changes ?? 0)
  getLogger().info({ skuId: sku.id, cleared, category: 'fulfillment' }, 'Available cards cleared')
  return cleared
}

/** 删除 SKU（连同全部卡密与发货台账，事务原子；不可恢复，确认交给 UI 层） */
export function deleteSku(skuId: string): boolean {
  const sku = getSku(skuId)
  if (!sku) return false
  const db = getDatabase()
  db.transaction(() => {
    db.run('DELETE FROM fulfillment_deliveries WHERE sku_id = ?', [sku.id])
    db.run('DELETE FROM fulfillment_cards WHERE sku_id = ?', [sku.id])
    db.run('DELETE FROM fulfillment_skus WHERE id = ?', [sku.id])
  })()
  getLogger().info({ skuId: sku.id, category: 'fulfillment' }, 'SKU deleted')
  return true
}

function renderDelivery(template: string | null, secret: string): string {
  if (!template) return secret
  return template.includes(SECRET_PLACEHOLDER) ? template.split(SECRET_PLACEHOLDER).join(secret) : `${template}\n${secret}`
}

/**
 * 为一个订单发货：原子领取一张可用卡 + 幂等（同 order_ref 复发返回同一张）。
 * order_ref = 闲鱼订单号（真机集成时传入；未接入前 agent 可用"买家+商品+时间"唯一串代替）。
 */
export function deliverForOrder(skuId: string, orderRef: string): DeliveryResult {
  const sku = getSku(skuId)
  if (!sku) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, `SKU「${skuId}」不存在`)
  const ref = orderRef.trim()
  if (!ref) throw new FulfillmentError(FULFILLMENT_INVALID_INPUT, '缺少订单标识 order_ref（幂等键，防重复发货）')

  const db = getDatabase()
  // 事务内：先查幂等 → 领卡 → 记发货。sidecar 单进程，事务保证原子。
  const claim = db.transaction((): { secret: string; replay: boolean } => {
    const existing = db.query('SELECT card_id, sku_id FROM fulfillment_deliveries WHERE order_ref = ?').get(ref) as { card_id: number; sku_id: string } | null
    if (existing) {
      // 幂等命中必须是同一商品：order_ref 撞车（如"买家+日期"式引用被两个商品复用）时
      // 静默返回另一商品的卡 = 发错货，必须显式报错让上层换一个唯一引用。
      if (existing.sku_id !== sku.id) {
        throw new FulfillmentError(
          FULFILLMENT_INVALID_INPUT,
          `订单「${ref}」此前已用于商品「${existing.sku_id}」的发货，不能再给「${sku.id}」发货；请换一个唯一的订单标识`,
        )
      }
      const card = db.query('SELECT secret FROM fulfillment_cards WHERE id = ?').get(existing.card_id) as { secret: string } | null
      return { secret: card?.secret ?? '', replay: true }
    }
    const card = db.query("SELECT id, secret FROM fulfillment_cards WHERE sku_id = ? AND status = 'available' ORDER BY id LIMIT 1").get(sku.id) as { id: number; secret: string } | null
    if (!card) throw new FulfillmentError(FULFILLMENT_OUT_OF_STOCK, `「${sku.title}」库存已空，请先补充卡密再发货`)
    const at = nowIso()
    db.run("UPDATE fulfillment_cards SET status = 'delivered', order_ref = ?, delivered_at = ? WHERE id = ?", [ref, at, card.id])
    db.run('INSERT INTO fulfillment_deliveries (order_ref, sku_id, card_id, delivered_at) VALUES (?, ?, ?, ?)', [ref, sku.id, card.id, at])
    return { secret: card.secret, replay: false }
  })

  const result = claim()
  getLogger().info({ skuId: sku.id, orderRef: ref, replay: result.replay, category: 'fulfillment' }, 'Order fulfilled')
  return { message: renderDelivery(sku.deliveryTemplate, result.secret), secret: result.secret, replay: result.replay }
}
