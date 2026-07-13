// [XJC] 漫剧工作室·资产库（角色/场景/道具设定资产）
//
// 目的：把「结构化剧本 → 圣经」阶段产出的角色/场景/道具，落成可复用、可锁定的资产，
// 让后续分镜/静帧/视频强制引用同一份设定，解决多镜多集的「串脸/串景」一致性问题。
//
// 边界：只存文本设定 + 本机参考图路径（媒体产出内），纯本地 SQLite，不上云。
// 资产按 run_id（单集项目）归属；project_key 预留跨 run（整季）复用，本期不强用。

import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/index.ts'

export const STUDIO_ASSET_INVALID_INPUT = 'STUDIO_ASSET_INVALID_INPUT'

export class StudioAssetError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'StudioAssetError'
  }
}

export type StudioAssetKind = 'character' | 'location' | 'prop'
const ASSET_KINDS: ReadonlySet<string> = new Set<StudioAssetKind>(['character', 'location', 'prop'])

export interface StudioAsset {
  id: string
  runId: string
  projectKey: string | null
  agentId: string | null
  kind: StudioAssetKind
  /** 剧本/圣经里的稳定标识（如 c1/l1/p1），用于去重与跨步骤关联 */
  refKey: string | null
  name: string
  description: string | null
  /** 锁定的参考图本机路径（媒体产出内） */
  imagePath: string | null
  promptUsed: string | null
  attributes: Record<string, unknown>
  locked: boolean
  version: number
  createdAt: string
  updatedAt: string
}

const NAME_MAX = 200
const DESC_MAX = 4000
const PROMPT_MAX = 4000

function nowIso(): string {
  return new Date().toISOString()
}

interface AssetRow {
  id: string
  run_id: string
  project_key: string | null
  agent_id: string | null
  kind: string
  ref_key: string | null
  name: string
  description: string | null
  image_path: string | null
  prompt_used: string | null
  attributes_json: string
  locked: number
  version: number
  created_at: string
  updated_at: string
}

function rowToAsset(row: AssetRow): StudioAsset {
  let attributes: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.attributes_json || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) attributes = parsed as Record<string, unknown>
  } catch { /* 损坏的属性 JSON 退化为空对象 */ }
  return {
    id: row.id,
    runId: row.run_id,
    projectKey: row.project_key,
    agentId: row.agent_id,
    kind: row.kind as StudioAssetKind,
    refKey: row.ref_key,
    name: row.name,
    description: row.description,
    imagePath: row.image_path,
    promptUsed: row.prompt_used,
    attributes,
    locked: row.locked === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeKind(kind: string): StudioAssetKind {
  const k = (kind ?? '').trim().toLowerCase()
  if (!ASSET_KINDS.has(k)) {
    throw new StudioAssetError(STUDIO_ASSET_INVALID_INPUT, `资产 kind「${kind}」不合法（character/location/prop）`)
  }
  return k as StudioAssetKind
}

export interface UpsertAssetInput {
  runId: string
  kind: string
  name: string
  projectKey?: string | null
  agentId?: string | null
  refKey?: string | null
  description?: string | null
  imagePath?: string | null
  promptUsed?: string | null
  attributes?: Record<string, unknown> | null
  locked?: boolean
}

/**
 * 建/更新资产。带 refKey 时按 (run_id, kind, ref_key) 幂等更新（剧本重复解析不会重复建卡）；
 * 无 refKey 时始终新建。已锁定资产被再次 upsert（同 refKey）时，locked/imagePath 不会被无意清空。
 */
export function upsertAsset(input: UpsertAssetInput): StudioAsset {
  const runId = (input.runId ?? '').trim()
  if (!runId) throw new StudioAssetError(STUDIO_ASSET_INVALID_INPUT, '资产需要 runId')
  const kind = normalizeKind(input.kind)
  const name = (input.name ?? '').trim().slice(0, NAME_MAX)
  if (!name) throw new StudioAssetError(STUDIO_ASSET_INVALID_INPUT, '资产需要名称')
  const refKey = input.refKey?.trim() || null
  const description = input.description?.trim().slice(0, DESC_MAX) ?? null
  const promptUsed = input.promptUsed?.trim().slice(0, PROMPT_MAX) ?? null
  const imagePath = input.imagePath?.trim() || null
  const projectKey = input.projectKey?.trim() || null
  const agentId = input.agentId?.trim() || null
  const attributes = input.attributes && typeof input.attributes === 'object' ? input.attributes : {}
  const now = nowIso()

  const existing = refKey ? findByRefKey(runId, kind, refKey) : null
  if (existing) {
    // 已有同 refKey：合并式更新，避免解析步骤把用户已锁定的图/锁态覆盖掉。
    const nextImage = imagePath ?? existing.imagePath
    const nextLocked = input.locked ?? existing.locked
    getDatabase().run(
      `UPDATE studio_assets SET name = ?, description = ?, prompt_used = ?, image_path = ?,
         attributes_json = ?, locked = ?, project_key = COALESCE(?, project_key),
         agent_id = COALESCE(?, agent_id), version = version + 1, updated_at = ?
       WHERE id = ?`,
      [
        name, description, promptUsed, nextImage,
        JSON.stringify(attributes), nextLocked ? 1 : 0, projectKey,
        agentId, now, existing.id,
      ],
    )
    return getAsset(existing.id)!
  }

  const id = `asset-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`
  getDatabase().run(
    `INSERT INTO studio_assets
       (id, run_id, project_key, agent_id, kind, ref_key, name, description, image_path,
        prompt_used, attributes_json, locked, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id, runId, projectKey, agentId, kind, refKey, name, description, imagePath,
      promptUsed, JSON.stringify(attributes), input.locked ? 1 : 0, now, now,
    ],
  )
  return getAsset(id)!
}

export function getAsset(id: string): StudioAsset | null {
  const row = getDatabase().query('SELECT * FROM studio_assets WHERE id = ?').get(id.trim()) as AssetRow | null
  return row ? rowToAsset(row) : null
}

function findByRefKey(runId: string, kind: StudioAssetKind, refKey: string): StudioAsset | null {
  const row = getDatabase()
    .query('SELECT * FROM studio_assets WHERE run_id = ? AND kind = ? AND ref_key = ?')
    .get(runId, kind, refKey) as AssetRow | null
  return row ? rowToAsset(row) : null
}

export function listAssets(runId: string, kind?: StudioAssetKind): StudioAsset[] {
  const id = (runId ?? '').trim()
  if (!id) return []
  const rows = kind
    ? getDatabase().query('SELECT * FROM studio_assets WHERE run_id = ? AND kind = ? ORDER BY kind, created_at').all(id, kind)
    : getDatabase().query('SELECT * FROM studio_assets WHERE run_id = ? ORDER BY kind, created_at').all(id)
  return (rows as AssetRow[]).map(rowToAsset)
}

export interface PatchAssetInput {
  name?: string
  description?: string | null
  imagePath?: string | null
  promptUsed?: string | null
  attributes?: Record<string, unknown>
  locked?: boolean
}

/** 局部更新一条资产（改名/换参考图/锁定与解锁/补属性）。只写传入的字段。 */
export function patchAsset(id: string, patch: PatchAssetInput): StudioAsset {
  const existing = getAsset(id)
  if (!existing) throw new StudioAssetError(STUDIO_ASSET_INVALID_INPUT, '资产不存在')
  const name = patch.name !== undefined ? patch.name.trim().slice(0, NAME_MAX) : existing.name
  if (!name) throw new StudioAssetError(STUDIO_ASSET_INVALID_INPUT, '资产名称不能为空')
  const description = patch.description !== undefined ? (patch.description?.trim().slice(0, DESC_MAX) ?? null) : existing.description
  const imagePath = patch.imagePath !== undefined ? (patch.imagePath?.trim() || null) : existing.imagePath
  const promptUsed = patch.promptUsed !== undefined ? (patch.promptUsed?.trim().slice(0, PROMPT_MAX) ?? null) : existing.promptUsed
  const attributes = patch.attributes !== undefined ? patch.attributes : existing.attributes
  const locked = patch.locked !== undefined ? patch.locked : existing.locked
  getDatabase().run(
    `UPDATE studio_assets SET name = ?, description = ?, image_path = ?, prompt_used = ?,
       attributes_json = ?, locked = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [name, description, imagePath, promptUsed, JSON.stringify(attributes ?? {}), locked ? 1 : 0, nowIso(), id.trim()],
  )
  return getAsset(id)!
}

export function deleteAsset(id: string): boolean {
  const res = getDatabase().run('DELETE FROM studio_assets WHERE id = ?', [id.trim()])
  return (res?.changes ?? 0) > 0
}

/** 清空某 run 的全部资产（重新解析剧本前清场，避免陈旧资产堆积）。 */
export function clearRunAssets(runId: string): number {
  const res = getDatabase().run('DELETE FROM studio_assets WHERE run_id = ?', [(runId ?? '').trim()])
  return res?.changes ?? 0
}

export interface SeedAssetItem {
  refKey?: string
  name: string
  description?: string
  attributes?: Record<string, unknown>
}

export interface SeedAssetsInput {
  runId: string
  agentId?: string | null
  projectKey?: string | null
  characters?: SeedAssetItem[]
  locations?: SeedAssetItem[]
  props?: SeedAssetItem[]
}

/**
 * 从剧本/圣经解析结果批量播种资产（幂等：带 refKey 的重复播种走 upsert 合并，不会重复建卡、
 * 也不覆盖用户已锁定的参考图）。返回本次写入/更新后的完整资产列表。
 */
export function seedAssetsFromScript(input: SeedAssetsInput): StudioAsset[] {
  const runId = (input.runId ?? '').trim()
  if (!runId) throw new StudioAssetError(STUDIO_ASSET_INVALID_INPUT, '播种资产需要 runId')
  const seedKind = (kind: StudioAssetKind, items?: SeedAssetItem[]) => {
    for (const item of items ?? []) {
      const name = (item?.name ?? '').trim()
      if (!name) continue
      upsertAsset({
        runId,
        agentId: input.agentId ?? null,
        projectKey: input.projectKey ?? null,
        kind,
        refKey: item.refKey ?? null,
        name,
        description: item.description ?? null,
        attributes: item.attributes ?? null,
      })
    }
  }
  seedKind('character', input.characters)
  seedKind('location', input.locations)
  seedKind('prop', input.props)
  return listAssets(runId)
}
