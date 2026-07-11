// [XJC] 一人公司试用版：本地经营画像与“今日经营”快照 API。
import { Hono } from 'hono'
import { getTodayBusinessSnapshot } from '../business/dashboard.ts'
import {
  BusinessProfileUpdateSchema,
  getBusinessProfile,
  getBusinessProfileCompletion,
  updateBusinessProfile,
} from '../business/profile.ts'

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

export function createBusinessRoutes(): Hono {
  return app
}
