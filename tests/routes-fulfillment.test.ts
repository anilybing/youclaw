// [XJC] 卡密库管理路由测试：CRUD/导入/台账/清空/删除 + id 派生。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { createFulfillmentRoutes } from '../src/routes/fulfillment.ts'
import { deliverForOrder, getStock } from '../src/fulfillment/store.ts'

const app = createFulfillmentRoutes()

function post(path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

afterEach(() => {
  const db = getDatabase()
  db.run("DELETE FROM fulfillment_cards WHERE sku_id LIKE 'rt-%' OR sku_id LIKE 'qq-music%' OR sku_id LIKE 'sku-%'")
  db.run("DELETE FROM fulfillment_deliveries WHERE sku_id LIKE 'rt-%' OR sku_id LIKE 'qq-music%' OR sku_id LIKE 'sku-%'")
  db.run("DELETE FROM fulfillment_skus WHERE id LIKE 'rt-%' OR id LIKE 'qq-music%' OR id LIKE 'sku-%'")
})

describe('fulfillment routes', () => {
  test('POST /skus 建商品：ASCII 标题派生 slug id', async () => {
    const res = await post('/fulfillment/skus', { title: 'QQ Music VIP', deliveryTemplate: '码：{secret}' })
    expect(res.status).toBe(200)
    const { sku } = await res.json() as { sku: { id: string; title: string } }
    expect(sku.id).toBe('qq-music-vip')
    expect(sku.title).toBe('QQ Music VIP')
  })

  test('POST /skus 中文标题回落随机 id；缺标题 400', async () => {
    const res = await post('/fulfillment/skus', { title: 'QQ音乐年卡' })
    const { sku } = await res.json() as { sku: { id: string } }
    expect(sku.id).toMatch(/^sku-[a-z0-9]+$/)

    const bad = await post('/fulfillment/skus', { deliveryTemplate: 'x' })
    expect(bad.status).toBe(400)
  })

  test('POST /skus/:id/cards 文本导入（一行一张）+ GET /skus 概览', async () => {
    await post('/fulfillment/skus', { id: 'rt-a', title: 'A' })
    const res = await post('/fulfillment/skus/rt-a/cards', { text: 'K1\nK2\n\nK3\n' })
    expect(await res.json()).toEqual({ added: 3, skipped: 0 })

    const list = await app.request('/fulfillment/skus')
    const { skus } = await list.json() as { skus: Array<{ id: string; available: number }> }
    expect(skus.find((s) => s.id === 'rt-a')?.available).toBe(3)
  })

  test('POST /skus 派生 id 已被占用 → 回落随机 id，不覆盖旧商品', async () => {
    const first = await post('/fulfillment/skus', { title: 'Steam Key', deliveryTemplate: '旧模板' })
    const firstSku = (await first.json() as { sku: { id: string; deliveryTemplate: string } }).sku
    expect(firstSku.id).toBe('steam-key')

    const second = await post('/fulfillment/skus', { title: 'Steam Key', deliveryTemplate: '新模板' })
    const secondSku = (await second.json() as { sku: { id: string } }).sku
    expect(secondSku.id).toMatch(/^sku-[a-z0-9]+$/) // 不是 steam-key

    // 旧商品未被动过
    const list = await app.request('/fulfillment/skus')
    const { skus } = await list.json() as { skus: Array<{ id: string; deliveryTemplate: string | null }> }
    expect(skus.find((s) => s.id === 'steam-key')?.deliveryTemplate).toBe('旧模板')
    // 清理本用例的两个 SKU（steam-key 不在 afterEach 模式内）
    await app.request('/fulfillment/skus/steam-key', { method: 'DELETE' })
    await app.request(`/fulfillment/skus/${secondSku.id}`, { method: 'DELETE' })
  })

  test('GET /deliveries 台账含订单/卡密/标题，可按 skuId 过滤', async () => {
    await post('/fulfillment/skus', { id: 'rt-b', title: '商品B' })
    await post('/fulfillment/skus/rt-b/cards', { secrets: ['S1', 'S2'] })
    deliverForOrder('rt-b', 'order-x')

    const res = await app.request('/fulfillment/deliveries?skuId=rt-b')
    const { deliveries } = await res.json() as { deliveries: Array<{ orderRef: string; secret: string; skuTitle: string }> }
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ orderRef: 'order-x', secret: 'S1', skuTitle: '商品B' })

    const other = await app.request('/fulfillment/deliveries?skuId=rt-none')
    expect((await other.json() as { deliveries: unknown[] }).deliveries).toHaveLength(0)
  })

  test('POST /skus/:id/clear-available 只清未发，台账保留', async () => {
    await post('/fulfillment/skus', { id: 'rt-c', title: 'C' })
    await post('/fulfillment/skus/rt-c/cards', { secrets: ['C1', 'C2', 'C3'] })
    deliverForOrder('rt-c', 'o1')

    const res = await post('/fulfillment/skus/rt-c/clear-available')
    expect(await res.json()).toEqual({ cleared: 2 })
    expect(getStock('rt-c')).toEqual({ available: 0, delivered: 1 })

    const ledger = await app.request('/fulfillment/deliveries?skuId=rt-c')
    expect((await ledger.json() as { deliveries: unknown[] }).deliveries).toHaveLength(1)
  })

  test('DELETE /skus/:id 级联删卡密与台账；不存在 404', async () => {
    await post('/fulfillment/skus', { id: 'rt-d', title: 'D' })
    await post('/fulfillment/skus/rt-d/cards', { secrets: ['D1'] })
    deliverForOrder('rt-d', 'o1')

    const res = await app.request('/fulfillment/skus/rt-d', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const db = getDatabase()
    expect(db.query("SELECT COUNT(*) AS n FROM fulfillment_cards WHERE sku_id = 'rt-d'").get()).toEqual({ n: 0 })
    expect(db.query("SELECT COUNT(*) AS n FROM fulfillment_deliveries WHERE sku_id = 'rt-d'").get()).toEqual({ n: 0 })

    const missing = await app.request('/fulfillment/skus/rt-d', { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })

  test('导入到不存在的 SKU 返回 400（FulfillmentError 映射）', async () => {
    const res = await post('/fulfillment/skus/rt-ghost/cards', { secrets: ['x'] })
    expect(res.status).toBe(400)
    const body = await res.json() as { errorCode?: string }
    expect(body.errorCode).toBe('FULFILLMENT_INVALID_INPUT')
  })
})
