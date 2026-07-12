// [XJC] 一人公司试用版：本地经营画像与“今日经营”快照 API。
import { Hono } from 'hono'
import { z } from 'zod'
import { getTodayBusinessSnapshot, getWeeklyBusinessReview, renderWeeklyBusinessReview } from '../business/dashboard.ts'
import {
  createDeliverable,
  deleteDeliverable,
  isDeliverableStatus,
  listDeliverables,
  updateDeliverableStatus,
  type DeliverableType,
} from '../business/deliverables.ts'
import {
  BusinessProfileUpdateSchema,
  getBusinessProfile,
  getBusinessProfileCompletion,
  updateBusinessProfile,
} from '../business/profile.ts'

const DELIVERABLE_TYPES = ['report', 'image', 'video', 'document', 'notes', 'other'] as const
const createDeliverableSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.enum(DELIVERABLE_TYPES).optional(),
  summary: z.string().max(2000).optional(),
  filePath: z.string().max(1000).optional(),
})
const deliverableStatusSchema = z.object({
  status: z.enum(['draft', 'adopted', 'revised', 'discarded']),
})

const app = new Hono()

app.get('/business/profile', (c) => {
  const profile = getBusinessProfile()
  return c.json({ ...profile, ...getBusinessProfileCompletion(profile) })
})

app.put('/business/profile', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = BusinessProfileUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({
      error: '经营画像格式无效',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }, 400)
  }
  const profile = updateBusinessProfile(parsed.data)
  return c.json({ ...profile, ...getBusinessProfileCompletion(profile) })
})

app.get('/business/dashboard/today', (c) => {
  return c.json(getTodayBusinessSnapshot())
})

// ── 交付物登记台账 ─────────────────────────────────────────────
app.get('/business/deliverables', (c) => {
  const status = c.req.query('status')
  const type = c.req.query('type')
  const limitRaw = Number(c.req.query('limit'))
  return c.json({
    deliverables: listDeliverables({
      status: isDeliverableStatus(status) ? status : undefined,
      type: (DELIVERABLE_TYPES as readonly string[]).includes(type ?? '') ? (type as DeliverableType) : undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    }),
  })
})

app.post('/business/deliverables', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = createDeliverableSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: '交付物格式无效', issues: parsed.error.issues.map((i) => i.message) }, 400)
  }
  const deliverable = createDeliverable({ ...parsed.data, sourceKind: 'manual' })
  return c.json(deliverable, 201)
})

app.patch('/business/deliverables/:id', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = deliverableStatusSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: '交付物状态无效' }, 400)
  const updated = updateDeliverableStatus(c.req.param('id'), parsed.data.status)
  if (!updated) return c.json({ error: '交付物不存在' }, 404)
  return c.json(updated)
})

app.delete('/business/deliverables/:id', (c) => {
  if (!deleteDeliverable(c.req.param('id'))) return c.json({ error: '交付物不存在' }, 404)
  return c.json({ ok: true })
})

// ── 周经营复盘 ─────────────────────────────────────────────────
app.get('/business/review/weekly', (c) => {
  const review = getWeeklyBusinessReview()
  return c.json({ review, brief: renderWeeklyBusinessReview(review) })
})

export function createBusinessRoutes(): Hono {
  return app
}
