// [XJC] 虚拟商品发货 MCP 工具（闲鱼客服员工用）：让 agent 在对话中查库存、发货。
// 发货是原子+幂等的（见 fulfillment/store.ts）；缺货显式报错，绝不糊弄。
// 只做线上虚拟商品（卡密/账号/兑换码），不处理物理物流。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import {
  addCards,
  deliverForOrder,
  listSkus,
  upsertSku,
  FulfillmentError,
} from '../fulfillment/store.ts'
import { getLogger } from '../logger/index.ts'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; details: Record<string, never> }
function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} }
}
function fail(err: unknown, fallback: string): never {
  if (err instanceof FulfillmentError) throw new Error(err.message)
  getLogger().error({ error: String(err), category: 'fulfillment' }, fallback)
  throw new Error(fallback)
}

const ListStockParams = Type.Object({})

const UpsertSkuParams = Type.Object({
  id: Type.String({ description: 'Stable SKU id (lowercase letters/digits/_/-, e.g. "qqmusic-vip-year").' }),
  title: Type.String({ description: 'Human title shown in listings, e.g. "QQ音乐VIP年卡".' }),
  deliveryTemplate: Type.Optional(Type.String({ description: 'Message template sent to the buyer. Use {secret} where the card/account should be inserted, e.g. "您的QQ音乐VIP兑换码：{secret}\\n充值方法：打开QQ音乐APP…". Omit to send the raw card only.' })),
})

const AddCardsParams = Type.Object({
  skuId: Type.String({ description: 'The SKU id to add stock to.' }),
  secrets: Type.Array(Type.String(), { description: 'List of card codes / account credentials / redemption keys — one entry per unit of stock.' }),
})

const DeliverParams = Type.Object({
  skuId: Type.String({ description: 'The SKU the buyer purchased.' }),
  orderRef: Type.String({ description: 'Unique order identifier (idempotency key). Use the Xianyu order number if available; otherwise a stable string like "buyer昵称+商品+日期". The SAME orderRef never consumes a second card.' }),
})

export function createFulfillmentTools(params: { agentId: string }): ToolDefinition[] {
  const { agentId } = params
  return [
    {
      name: 'mcp__fulfillment__list_stock',
      label: 'mcp__fulfillment__list_stock',
      description: 'List all virtual-goods SKUs and their available/delivered stock counts. Use before delivering or when the user asks about inventory.',
      parameters: ListStockParams,
      async execute() {
        try {
          const skus = listSkus()
          if (skus.length === 0) return ok('尚未配置任何虚拟商品。先用 mcp__fulfillment__upsert_sku 建商品，再用 mcp__fulfillment__add_cards 导入卡密。')
          return ok(JSON.stringify(skus.map((s) => ({ id: s.id, title: s.title, available: s.available, delivered: s.delivered })), null, 2))
        } catch (err) { fail(err, '查询库存失败') }
      },
    },
    {
      name: 'mcp__fulfillment__upsert_sku',
      label: 'mcp__fulfillment__upsert_sku',
      description: 'Create or update a virtual-goods SKU (title + delivery message template). Call once per product. Does NOT add stock — use add_cards for that.',
      parameters: UpsertSkuParams,
      async execute(_id, args: { id: string; title: string; deliveryTemplate?: string }) {
        try {
          const sku = upsertSku({ id: args.id, title: args.title, agentId, deliveryTemplate: args.deliveryTemplate })
          return ok(`商品已保存：${sku.title}（id: ${sku.id}）。接下来用 mcp__fulfillment__add_cards 导入卡密。`)
        } catch (err) { fail(err, '保存商品失败') }
      },
    },
    {
      name: 'mcp__fulfillment__add_cards',
      label: 'mcp__fulfillment__add_cards',
      description: 'Import stock (card codes / accounts / redemption keys) into a SKU, one entry per unit. Each will be delivered to exactly one buyer.',
      parameters: AddCardsParams,
      async execute(_id, args: { skuId: string; secrets: string[] }) {
        try {
          const r = addCards(args.skuId, Array.isArray(args.secrets) ? args.secrets : [])
          const skippedNote = r.skipped > 0 ? `，跳过 ${r.skipped} 条重复（含已存在/已发出的，防同一码卖两人）` : ''
          return ok(`已为「${args.skuId}」导入 ${r.added} 条卡密${skippedNote}。`)
        } catch (err) { fail(err, '导入卡密失败') }
      },
    },
    {
      name: 'mcp__fulfillment__deliver',
      label: 'mcp__fulfillment__deliver',
      description:
        'Deliver one virtual good for a paid order: atomically claims an available card and returns the message to send to the buyer. '
        + 'IDEMPOTENT: calling again with the same orderRef returns the SAME card (never double-consumes). '
        + 'If out of stock, it errors clearly — do NOT invent a fake card; tell the user stock is empty. '
        + 'Only call after the buyer has actually paid.',
      parameters: DeliverParams,
      async execute(_id, args: { skuId: string; orderRef: string }) {
        try {
          const result = deliverForOrder(args.skuId, args.orderRef)
          return ok(JSON.stringify({
            deliver_message: result.message,
            replay: result.replay,
            note: result.replay
              ? '此订单此前已发过货，返回同一张卡（未消耗新库存）。把 deliver_message 发给买家即可。'
              : '已发货并扣减库存。把 deliver_message 原样发给买家（渠道会话用 mcp__message__send_to_current_chat）。',
          }, null, 2))
        } catch (err) { fail(err, '发货失败') }
      },
    },
  ]
}
