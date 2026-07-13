// [XJC] 漫剧工作室路由：资产库（角色/场景/道具一致性设定）+ 成片草稿导出。
//   GET    /studio/assets?runId=&kind=              — 列出某项目资产
//   POST   /studio/assets                           — 建/更新单条资产（带 refKey 幂等）
//   PATCH  /studio/assets/:id                        — 局部更新（锁定/换图/改名）
//   DELETE /studio/assets/:id                        — 删除单条
//   POST   /studio/runs/:runId/assets/import         — 从剧本/圣经解析批量播种资产
//   DELETE /studio/runs/:runId/assets                — 清空该项目资产
//   POST   /studio/runs/:runId/draft                 — 导出成片草稿包（剪映 + FFmpeg + manifest）
// 全部本机 SQLite / 本机文件，不上云。引擎见 src/studio/*。

import { Hono } from 'hono'
import {
  clearRunAssets,
  deleteAsset,
  listAssets,
  patchAsset,
  seedAssetsFromScript,
  upsertAsset,
  StudioAssetError,
  type StudioAssetKind,
  type SeedAssetItem,
} from '../studio/assetStore.ts'
import { exportStudioDraftPackage } from '../studio/draftExport.ts'
import type { StudioTimelineShot } from '../studio/capcutDraft.ts'
import { getLogger } from '../logger/index.ts'

const ASSET_KINDS = new Set(['character', 'location', 'prop'])

function handleError(err: unknown, fallback: string) {
  if (err instanceof StudioAssetError) {
    return { status: 400 as const, body: { error: err.message, errorCode: err.code } }
  }
  getLogger().error({ error: String(err), category: 'studio' }, fallback)
  return { status: 500 as const, body: { error: fallback } }
}

function asSeedItems(value: unknown): SeedAssetItem[] {
  if (!Array.isArray(value)) return []
  const items: SeedAssetItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name.trim() : ''
    if (!name) continue
    items.push({
      refKey: typeof obj.refKey === 'string' ? obj.refKey : (typeof obj.id === 'string' ? obj.id : undefined),
      name,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      attributes: obj.attributes && typeof obj.attributes === 'object' && !Array.isArray(obj.attributes)
        ? obj.attributes as Record<string, unknown>
        : undefined,
    })
  }
  return items
}

function asTimelineShots(value: unknown): StudioTimelineShot[] {
  if (!Array.isArray(value)) return []
  const shots: StudioTimelineShot[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    shots.push({
      shotId: typeof obj.shotId === 'string' ? obj.shotId : '',
      durationSec: Number(obj.durationSec),
      mediaPath: typeof obj.mediaPath === 'string' ? obj.mediaPath : undefined,
      mediaType: obj.mediaType === 'video' || obj.mediaType === 'photo' ? obj.mediaType : undefined,
      dialogue: typeof obj.dialogue === 'string' ? obj.dialogue : undefined,
    })
  }
  return shots
}

export function createStudioRoutes() {
  const app = new Hono()

  app.get('/studio/assets', (c) => {
    const runId = c.req.query('runId')?.trim() ?? ''
    if (!runId) return c.json({ error: '需要 runId' }, 400)
    const kindParam = c.req.query('kind')?.trim()
    const kind = kindParam && ASSET_KINDS.has(kindParam) ? kindParam as StudioAssetKind : undefined
    return c.json({ assets: listAssets(runId, kind) })
  })

  app.post('/studio/assets', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
      const kind = typeof body.kind === 'string' ? body.kind : ''
      const name = typeof body.name === 'string' ? body.name : ''
      if (!runId) return c.json({ error: '需要 runId' }, 400)
      const asset = upsertAsset({
        runId,
        kind,
        name,
        agentId: typeof body.agentId === 'string' ? body.agentId : null,
        projectKey: typeof body.projectKey === 'string' ? body.projectKey : null,
        refKey: typeof body.refKey === 'string' ? body.refKey : null,
        description: typeof body.description === 'string' ? body.description : null,
        imagePath: typeof body.imagePath === 'string' ? body.imagePath : null,
        promptUsed: typeof body.promptUsed === 'string' ? body.promptUsed : null,
        attributes: body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)
          ? body.attributes as Record<string, unknown>
          : null,
        locked: typeof body.locked === 'boolean' ? body.locked : undefined,
      })
      return c.json({ asset })
    } catch (err) {
      const { status, body } = handleError(err, '保存资产失败')
      return c.json(body, status)
    }
  })

  app.patch('/studio/assets/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const asset = patchAsset(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        description: 'description' in body ? (typeof body.description === 'string' ? body.description : null) : undefined,
        imagePath: 'imagePath' in body ? (typeof body.imagePath === 'string' ? body.imagePath : null) : undefined,
        promptUsed: 'promptUsed' in body ? (typeof body.promptUsed === 'string' ? body.promptUsed : null) : undefined,
        attributes: body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes)
          ? body.attributes as Record<string, unknown>
          : undefined,
        locked: typeof body.locked === 'boolean' ? body.locked : undefined,
      })
      return c.json({ asset })
    } catch (err) {
      const { status, body } = handleError(err, '更新资产失败')
      return c.json(body, status)
    }
  })

  app.delete('/studio/assets/:id', (c) => {
    try {
      const ok = deleteAsset(c.req.param('id'))
      return c.json({ ok })
    } catch (err) {
      const { status, body } = handleError(err, '删除资产失败')
      return c.json(body, status)
    }
  })

  app.post('/studio/runs/:runId/assets/import', async (c) => {
    try {
      const runId = c.req.param('runId')
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const assets = seedAssetsFromScript({
        runId,
        agentId: typeof body.agentId === 'string' ? body.agentId : null,
        projectKey: typeof body.projectKey === 'string' ? body.projectKey : null,
        characters: asSeedItems(body.characters),
        locations: asSeedItems(body.locations),
        props: asSeedItems(body.props),
      })
      return c.json({ assets })
    } catch (err) {
      const { status, body } = handleError(err, '播种资产失败')
      return c.json(body, status)
    }
  })

  app.delete('/studio/runs/:runId/assets', (c) => {
    try {
      const removed = clearRunAssets(c.req.param('runId'))
      return c.json({ removed })
    } catch (err) {
      const { status, body } = handleError(err, '清空资产失败')
      return c.json(body, status)
    }
  })

  app.post('/studio/runs/:runId/draft', async (c) => {
    try {
      const runId = c.req.param('runId')
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
      const shots = asTimelineShots(body.shots)
      if (shots.length === 0) return c.json({ error: '导出草稿至少需要 1 个镜头（shots）' }, 400)
      const result = exportStudioDraftPackage(
        runId,
        {
          title: typeof body.title === 'string' ? body.title : '',
          aspect: typeof body.aspect === 'string' ? body.aspect : '9:16',
          resolution: typeof body.resolution === 'string' ? body.resolution : '720p',
          fps: Number.isFinite(Number(body.fps)) ? Number(body.fps) : undefined,
          shots,
          audioPath: typeof body.audioPath === 'string' ? body.audioPath : undefined,
        },
        typeof body.agentId === 'string' ? body.agentId : null,
      )
      return c.json({
        runId: result.runId,
        dir: result.dir,
        totalSec: result.totalSec,
        shotCount: result.shotCount,
        files: result.files,
        manifest: result.bundle.manifest,
      })
    } catch (err) {
      const { status, body } = handleError(err, '导出成片草稿失败')
      return c.json(body, status)
    }
  })

  return app
}
