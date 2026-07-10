// [XJC] 进化引擎状态路由（开关本身走 PATCH /api/settings 的 evolution.enabled）
//   GET /api/evolution/status — 开关/python 可用性/发育阶段/记录统计（设置页展示）

import { Hono } from 'hono'
import { getEvolutionService } from '../evolution/service.ts'

export function createEvolutionRoutes() {
  const app = new Hono()

  app.get('/evolution/status', async (c) => {
    return c.json(await getEvolutionService().getStatus())
  })

  return app
}
