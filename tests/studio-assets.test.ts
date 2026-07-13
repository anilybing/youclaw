// [XJC] 漫剧资产库测试：store（幂等/锁定保护/播种/清空）+ 路由（CRUD/import/draft 导出）。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import {
  clearRunAssets,
  deleteAsset,
  listAssets,
  patchAsset,
  seedAssetsFromScript,
  upsertAsset,
} from '../src/studio/assetStore.ts'
import { createStudioRoutes } from '../src/routes/studio.ts'

const RUN = 'run-test-assets'

afterEach(() => {
  getDatabase().run("DELETE FROM studio_assets WHERE run_id LIKE 'run-test%'")
})

describe('studio asset store', () => {
  test('upsert 带 refKey 幂等：重复播种不重复建卡', () => {
    upsertAsset({ runId: RUN, kind: 'character', refKey: 'c1', name: '女主', description: '短发' })
    upsertAsset({ runId: RUN, kind: 'character', refKey: 'c1', name: '女主', description: '短发·改' })
    const list = listAssets(RUN, 'character')
    expect(list.length).toBe(1)
    expect(list[0].description).toBe('短发·改')
    expect(list[0].version).toBeGreaterThan(1)
  })

  test('已锁定+已绑图的资产被再次播种时，锁态与参考图不被覆盖', () => {
    const created = upsertAsset({ runId: RUN, kind: 'character', refKey: 'c1', name: '女主' })
    patchAsset(created.id, { locked: true, imagePath: '/m/hero.png' })
    // 模拟重新解析剧本再次播种（不带 image/locked）
    upsertAsset({ runId: RUN, kind: 'character', refKey: 'c1', name: '女主', description: '新描述' })
    const after = listAssets(RUN, 'character')[0]
    expect(after.locked).toBe(true)
    expect(after.imagePath).toBe('/m/hero.png')
    expect(after.description).toBe('新描述')
  })

  test('非法 kind / 缺名 抛错', () => {
    expect(() => upsertAsset({ runId: RUN, kind: 'weird', name: 'x' })).toThrow(/kind/)
    expect(() => upsertAsset({ runId: RUN, kind: 'prop', name: '  ' })).toThrow(/名称/)
  })

  test('seedAssetsFromScript 批量播种三类 + clearRunAssets 清空', () => {
    const all = seedAssetsFromScript({
      runId: RUN,
      characters: [{ refKey: 'c1', name: '女主' }, { refKey: 'c2', name: '男主' }],
      locations: [{ refKey: 'l1', name: '便利店' }],
      props: [{ refKey: 'p1', name: '囤货清单' }],
    })
    expect(all.length).toBe(4)
    expect(listAssets(RUN, 'location').length).toBe(1)
    const removed = clearRunAssets(RUN)
    expect(removed).toBe(4)
    expect(listAssets(RUN).length).toBe(0)
  })

  test('patch 锁定/换图/改名 + delete', () => {
    const a = upsertAsset({ runId: RUN, kind: 'prop', name: '道具' })
    const locked = patchAsset(a.id, { locked: true, imagePath: '/m/p.png', name: '道具2' })
    expect(locked.locked).toBe(true)
    expect(locked.imagePath).toBe('/m/p.png')
    expect(locked.name).toBe('道具2')
    expect(deleteAsset(a.id)).toBe(true)
    expect(listAssets(RUN).length).toBe(0)
  })
})

describe('studio routes', () => {
  const app = createStudioRoutes()
  const post = (path: string, body?: unknown) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

  test('POST/GET/PATCH/DELETE 资产闭环', async () => {
    const created = await post('/studio/assets', { runId: RUN, kind: 'character', name: '女主', refKey: 'c1' })
    expect(created.status).toBe(200)
    const { asset } = await created.json() as { asset: { id: string; locked: boolean } }
    expect(asset.locked).toBe(false)

    const list = await app.request(`/studio/assets?runId=${RUN}`)
    const listed = await list.json() as { assets: unknown[] }
    expect(listed.assets.length).toBe(1)

    const patched = await app.request(`/studio/assets/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked: true }),
    })
    expect(((await patched.json()) as { asset: { locked: boolean } }).asset.locked).toBe(true)

    const del = await app.request(`/studio/assets/${asset.id}`, { method: 'DELETE' })
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true)
  })

  test('GET 缺 runId → 400；import 播种', async () => {
    const bad = await app.request('/studio/assets')
    expect(bad.status).toBe(400)

    const imported = await post(`/studio/runs/${RUN}/assets/import`, {
      characters: [{ id: 'c1', name: '女主', appearance: '短发' }],
      locations: [{ id: 'l1', name: '便利店' }],
      props: [{ id: 'p1', name: '清单' }],
    })
    const { assets } = await imported.json() as { assets: unknown[] }
    expect(assets.length).toBe(3)
  })

  test('POST draft 导出：无镜头 400，有镜头返回 manifest', async () => {
    const empty = await post(`/studio/runs/${RUN}/draft`, { shots: [] })
    expect(empty.status).toBe(400)

    const ok = await post(`/studio/runs/${RUN}/draft`, {
      title: '囤货少女',
      aspect: '9:16',
      resolution: '720p',
      shots: [
        { shotId: 'S1', durationSec: 4, mediaPath: '/m/a.png', dialogue: '你好' },
        { shotId: 'S2', durationSec: 6, mediaPath: '/m/b.png' },
      ],
    })
    expect(ok.status).toBe(200)
    const res = await ok.json() as { shotCount: number; totalSec: number; manifest: { shots: unknown[] }; dir: string }
    expect(res.shotCount).toBe(2)
    expect(res.totalSec).toBe(10)
    expect(res.manifest.shots.length).toBe(2)
    expect(res.dir).toContain(RUN)
  })
})
