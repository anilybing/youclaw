// [XJC] 虚拟商品发货引擎测试：原子领卡/幂等复发/缺货/模板渲染 + MCP 工具。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import {
  addCards,
  deliverForOrder,
  getStock,
  listSkus,
  upsertSku,
  FulfillmentError,
  FULFILLMENT_OUT_OF_STOCK,
} from '../src/fulfillment/store.ts'
import { createFulfillmentTools } from '../src/agent/fulfillment-mcp.ts'

const SKU = 'qqmusic-vip-year'

afterEach(() => {
  const db = getDatabase()
  db.run("DELETE FROM fulfillment_cards WHERE sku_id LIKE '%test%' OR sku_id = ?", [SKU])
  db.run("DELETE FROM fulfillment_deliveries WHERE sku_id LIKE '%test%' OR sku_id = ?", [SKU])
  db.run("DELETE FROM fulfillment_skus WHERE id LIKE '%test%' OR id = ?", [SKU])
})

describe('fulfillment store', () => {
  test('upsertSku 建/更新，addCards 计库存', () => {
    upsertSku({ id: SKU, title: 'QQ音乐VIP年卡', deliveryTemplate: '兑换码：{secret}\n请在APP内使用' })
    expect(addCards(SKU, ['CARD-A', 'CARD-B', '', '  '])).toEqual({ added: 2, skipped: 0 }) // 空行被过滤
    expect(getStock(SKU)).toEqual({ available: 2, delivered: 0 })

    // 非法 id / 缺标题 / 空卡密
    expect(() => upsertSku({ id: 'BAD ID', title: 'x' })).toThrow(/id/)
    expect(() => addCards('no-such-sku', ['x'])).toThrow(/不存在/)
    expect(() => addCards(SKU, ['', ' '])).toThrow(/有效卡密/)
  })

  test('导入去重：批内重复/已存在/已发出的都跳过——同一码绝不卖两人', () => {
    upsertSku({ id: SKU, title: 'X' })
    expect(addCards(SKU, ['K1', 'K1', 'K2'])).toEqual({ added: 2, skipped: 1 }) // 批内重复
    deliverForOrder(SKU, 'o1') // K1 已发出
    // 同一份文件再粘一次：K1（已发出）、K2（在库）都不能重新入库
    expect(addCards(SKU, ['K1', 'K2', 'K3'])).toEqual({ added: 1, skipped: 2 })
    expect(getStock(SKU)).toEqual({ available: 2, delivered: 1 }) // K2 + K3 可发
  })

  test('order_ref 跨商品撞车：显式报错而不是静默发另一商品的卡', () => {
    upsertSku({ id: SKU, title: 'A' })
    upsertSku({ id: 'other-test-sku', title: 'B' })
    addCards(SKU, ['A1'])
    addCards('other-test-sku', ['B1'])

    deliverForOrder(SKU, 'shared-ref')
    expect(() => deliverForOrder('other-test-sku', 'shared-ref')).toThrow(/已用于商品/)
    // 原商品幂等复发不受影响
    expect(deliverForOrder(SKU, 'shared-ref')).toMatchObject({ secret: 'A1', replay: true })
    expect(getStock('other-test-sku')).toEqual({ available: 1, delivered: 0 }) // B 的库存没被误扣
  })

  test('deliverForOrder：领一张卡、套模板、扣库存', () => {
    upsertSku({ id: SKU, title: 'QQ音乐VIP', deliveryTemplate: '兑换码：{secret}' })
    addCards(SKU, ['CARD-1', 'CARD-2'])

    const r = deliverForOrder(SKU, 'order-1')
    expect(r.replay).toBe(false)
    expect(r.secret).toBe('CARD-1') // 按 id 顺序发
    expect(r.message).toBe('兑换码：CARD-1')
    expect(getStock(SKU)).toEqual({ available: 1, delivered: 1 })
  })

  test('幂等：同 order_ref 复发返回同一张，不消耗第二张', () => {
    upsertSku({ id: SKU, title: 'X' })
    addCards(SKU, ['CARD-1', 'CARD-2'])

    const first = deliverForOrder(SKU, 'order-42')
    const again = deliverForOrder(SKU, 'order-42')
    expect(again.replay).toBe(true)
    expect(again.secret).toBe(first.secret)
    expect(getStock(SKU)).toEqual({ available: 1, delivered: 1 }) // 只扣了一张

    // 不同订单领第二张
    const other = deliverForOrder(SKU, 'order-43')
    expect(other.secret).not.toBe(first.secret)
    expect(getStock(SKU)).toEqual({ available: 0, delivered: 2 })
  })

  test('缺货抛 OUT_OF_STOCK；无模板时直接返回卡密', () => {
    upsertSku({ id: SKU, title: 'X' }) // 无模板
    addCards(SKU, ['ONLY-ONE'])
    const r = deliverForOrder(SKU, 'o1')
    expect(r.message).toBe('ONLY-ONE') // 无模板=原样

    const err = (() => { try { deliverForOrder(SKU, 'o2'); return null } catch (e) { return e as FulfillmentError } })()
    expect(err).toBeInstanceOf(FulfillmentError)
    expect(err?.code).toBe(FULFILLMENT_OUT_OF_STOCK)
  })

  test('缺 order_ref / 不存在 SKU 报错', () => {
    upsertSku({ id: SKU, title: 'X' })
    expect(() => deliverForOrder(SKU, '  ')).toThrow(/order_ref/)
    expect(() => deliverForOrder('ghost-sku', 'o1')).toThrow(/不存在/)
  })

  test('listSkus 返回库存概览', () => {
    upsertSku({ id: SKU, title: 'QQ音乐', agentId: 'xianyu-cs' })
    addCards(SKU, ['A', 'B', 'C'])
    deliverForOrder(SKU, 'o1')
    const list = listSkus()
    const item = list.find((s) => s.id === SKU)!
    expect(item.title).toBe('QQ音乐')
    expect(item.available).toBe(2)
    expect(item.delivered).toBe(1)
  })
})

describe('fulfillment MCP tools', () => {
  const tools = createFulfillmentTools({ agentId: 'xianyu-cs' })
  const byName = (n: string) => tools.find((t) => t.name === n)!

  test('upsert_sku → add_cards → deliver 全链路', async () => {
    await byName('mcp__fulfillment__upsert_sku').execute('t', { id: SKU, title: 'QQ音乐VIP', deliveryTemplate: '码：{secret}' })
    await byName('mcp__fulfillment__add_cards').execute('t', { skuId: SKU, secrets: ['K1', 'K2'] })

    const stockRes = await byName('mcp__fulfillment__list_stock').execute('t', {})
    expect(stockRes.content[0].text).toContain(SKU)

    const delRes = await byName('mcp__fulfillment__deliver').execute('t', { skuId: SKU, orderRef: 'ord-1' })
    const parsed = JSON.parse(delRes.content[0].text)
    expect(parsed.deliver_message).toBe('码：K1')
    expect(parsed.replay).toBe(false)
  })

  test('deliver 缺货抛错（工具层）', async () => {
    await byName('mcp__fulfillment__upsert_sku').execute('t', { id: SKU, title: 'X' })
    await expect(byName('mcp__fulfillment__deliver').execute('t', { skuId: SKU, orderRef: 'o1' })).rejects.toThrow(/库存/)
  })
})
