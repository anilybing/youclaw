// [XJC] 知识库路由（通用能力对齐 · T-A1 底座）
//   GET    /api/knowledge/docs        — 文档列表
//   POST   /api/knowledge/docs        — multipart(file) 上传入库（转文本+分块+索引）
//   DELETE /api/knowledge/docs/:id    — 删除文档（连同分块与索引）
//   GET    /api/knowledge/search?q=   — 检索（返回带来源的命中片段）
// 服务实现见 src/knowledge/service.ts（T-A1 补全 addDocument/search）。

import { Hono } from 'hono'
import { getKnowledgeService } from '../knowledge/service.ts'
import { KnowledgeError } from '../knowledge/types.ts'
import { getLogger } from '../logger/index.ts'

const DOC_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

export function createKnowledgeRoutes() {
  const app = new Hono()

  app.get('/knowledge/docs', (c) => {
    return c.json({ docs: getKnowledgeService().listDocs() })
  })

  app.post('/knowledge/docs', async (c) => {
    try {
      const formData = await c.req.formData()
      const rawFile = formData.get('file')
      if (!(rawFile instanceof File)) {
        return c.json({ error: 'File is required' }, 400)
      }
      if (rawFile.size > DOC_UPLOAD_MAX_BYTES) {
        return c.json({ error: 'File exceeds the 20MB limit' }, 400)
      }
      const doc = await getKnowledgeService().addDocument({
        filename: rawFile.name || 'document',
        mediaType: rawFile.type || 'application/octet-stream',
        data: new Uint8Array(await rawFile.arrayBuffer()),
      })
      return c.json(doc)
    } catch (err) {
      if (err instanceof KnowledgeError) {
        return c.json({ error: err.message, errorCode: err.code }, 400)
      }
      getLogger().error({ error: String(err), category: 'knowledge' }, 'Knowledge upload failed')
      return c.json({ error: 'Failed to add document' }, 500)
    }
  })

  app.delete('/knowledge/docs/:id', (c) => {
    const ok = getKnowledgeService().deleteDoc(c.req.param('id'))
    if (!ok) return c.json({ error: 'Document not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/knowledge/search', async (c) => {
    const q = (c.req.query('q') || '').trim()
    if (!q) return c.json({ hits: [] })
    const topK = Math.min(Number(c.req.query('topK')) || 8, 20)
    try {
      const hits = await getKnowledgeService().search(q, topK)
      return c.json({ hits })
    } catch (err) {
      getLogger().error({ error: String(err), category: 'knowledge' }, 'Knowledge search failed')
      return c.json({ error: 'Search failed' }, 500)
    }
  })

  return app
}
