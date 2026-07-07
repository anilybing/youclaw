// [XJC-PATCH] T-G6 本地文档摄取一期：配置 API（走既有 kv_state 设置存储，见 src/ingest/settings.ts）
import { Hono } from 'hono'
import { getIngestSettings, updateIngestSettings, type IngestSettings } from '../ingest/settings.ts'
import { pruneIngestStateToFolders } from '../ingest/folder-ingest.ts'
import { ensureIngestTask } from '../ingest/ingest-scheduler.ts'

const app = new Hono()

// GET /ingest/config — 当前摄取配置（开关 + 目录白名单）
app.get('/ingest/config', (c) => {
  return c.json(getIngestSettings())
})

// POST /ingest/config — 部分更新（只取 body 里出现的字段）
app.post('/ingest/config', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid request body' }, 400)
  }

  const partial: Partial<IngestSettings> = {}

  if ('ingestEnabled' in body) {
    if (typeof body.ingestEnabled !== 'boolean') {
      return c.json({ error: 'ingestEnabled must be a boolean' }, 400)
    }
    partial.ingestEnabled = body.ingestEnabled
  }

  if ('ingestFolders' in body) {
    if (!Array.isArray(body.ingestFolders) || body.ingestFolders.some((f) => typeof f !== 'string')) {
      return c.json({ error: 'ingestFolders must be an array of strings' }, 400)
    }
    partial.ingestFolders = body.ingestFolders as string[]
  }

  const updated = updateIngestSettings(partial)
  // 隐私红线：目录移除立即清理其游标条目，不等下一轮扫描
  pruneIngestStateToFolders(updated.ingestFolders)
  // 开关变化即时生效（起/停轮询）
  ensureIngestTask()

  return c.json(updated)
})

export function createIngestRoutes() {
  return app
}
