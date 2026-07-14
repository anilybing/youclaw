// [XJC] 漫剧工作室·镜头台账（per-run shot store，架构师 G0 契约 Q2 落地）
//
// G0「视频进流水线」的单一真源（SQLite，仿 assetStore；不并入 workflow_runs——通用引擎 vs 漫剧域
// 数据分离）。键 (run_id, shot_id) 幂等 upsert。draft/hq 产物路径并存（draft_path/hq_path），
// 供 forEach 批量渲染、单镜重渲、cost_ledger 共用。meta.json 由本表单向导出、只写不回读（避免双写漂移）。
// 状态机：pending → rendering → done / failed（失败/重渲 attempt_count 累加）。

import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/index.ts'

export const STUDIO_SHOT_INVALID_INPUT = 'STUDIO_SHOT_INVALID_INPUT'

export class StudioShotError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'StudioShotError'
  }
}

export type ShotTier = 'draft' | 'hq'
const SHOT_TIERS: ReadonlySet<string> = new Set<ShotTier>(['draft', 'hq'])

export type ShotStatus = 'pending' | 'rendering' | 'done' | 'failed'
const SHOT_STATUSES: ReadonlySet<string> = new Set<ShotStatus>(['pending', 'rendering', 'done', 'failed'])

/** 镜头规格（存 spec_json）：I2V 提示词、时长、画幅等，渲染入参来源。 */
export interface ShotSpec {
  prompt?: string
  durationSec?: number | null
  aspectRatio?: string | null
  [key: string]: unknown
}

export interface StudioShot {
  id: string
  runId: string
  shotId: string
  /** 镜序（分镜 index），稳定排序 */
  shotIndex: number
  spec: ShotSpec
  /** 首帧本机路径（图生视频输入） */
  startPath: string | null
  /** 尾帧本机路径（连续链：endPath[n] → startPath[n+1]） */
  endPath: string | null
  /** draft 档产物 mp4 */
  draftPath: string | null
  /** hq 档产物 mp4（与 draft 并存） */
  hqPath: string | null
  status: ShotStatus
  /** 是否被选中走 HQ 重渲 */
  selected: boolean
  lastTier: ShotTier | null
  lastProvider: string | null
  /** 已渲染次数（含重渲） */
  attemptCount: number
  error: string | null
  /** VLM 质检结果（P1；本期预留） */
  qc: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

const PATH_MAX = 1024

interface ShotRow {
  id: string
  run_id: string
  shot_id: string
  shot_index: number
  spec_json: string
  start_path: string | null
  end_path: string | null
  draft_path: string | null
  hq_path: string | null
  status: string
  selected: number
  last_tier: string | null
  last_provider: string | null
  attempt_count: number
  error: string | null
  qc_json: string | null
  created_at: string
  updated_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseJsonObject(raw: string | null, fallback: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* 损坏 JSON 退化 */ }
  return fallback
}

function rowToShot(row: ShotRow): StudioShot {
  return {
    id: row.id,
    runId: row.run_id,
    shotId: row.shot_id,
    shotIndex: row.shot_index,
    spec: (parseJsonObject(row.spec_json, {}) ?? {}) as ShotSpec,
    startPath: row.start_path,
    endPath: row.end_path,
    draftPath: row.draft_path,
    hqPath: row.hq_path,
    status: row.status as ShotStatus,
    selected: row.selected === 1,
    lastTier: (row.last_tier as ShotTier | null) ?? null,
    lastProvider: row.last_provider,
    attemptCount: row.attempt_count,
    error: row.error,
    qc: parseJsonObject(row.qc_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function normalizeTier(tier: string | undefined | null, fallback: ShotTier = 'draft'): ShotTier {
  const t = (tier ?? '').trim().toLowerCase()
  if (!t) return fallback
  if (!SHOT_TIERS.has(t)) {
    throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, `镜头 tier「${tier}」不合法（draft/hq）`)
  }
  return t as ShotTier
}

function normalizeStatus(status: string): ShotStatus {
  const s = (status ?? '').trim().toLowerCase()
  if (!SHOT_STATUSES.has(s)) {
    throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, `镜头 status「${status}」不合法（pending/rendering/done/failed）`)
  }
  return s as ShotStatus
}

function clampPath(value: string | null | undefined): string | null {
  const v = value?.trim()
  return v ? v.slice(0, PATH_MAX) : null
}

export function getShot(runId: string, shotId: string): StudioShot | null {
  const row = getDatabase()
    .query('SELECT * FROM studio_shots WHERE run_id = ? AND shot_id = ?')
    .get((runId ?? '').trim(), (shotId ?? '').trim()) as ShotRow | null
  return row ? rowToShot(row) : null
}

export function getShotById(id: string): StudioShot | null {
  const row = getDatabase().query('SELECT * FROM studio_shots WHERE id = ?').get((id ?? '').trim()) as ShotRow | null
  return row ? rowToShot(row) : null
}

export function listShots(runId: string, opts?: { status?: ShotStatus; selected?: boolean }): StudioShot[] {
  const id = (runId ?? '').trim()
  if (!id) return []
  const clauses = ['run_id = ?']
  const params: (string | number)[] = [id]
  if (opts?.status) { clauses.push('status = ?'); params.push(opts.status) }
  if (opts?.selected !== undefined) { clauses.push('selected = ?'); params.push(opts.selected ? 1 : 0) }
  const rows = getDatabase()
    .query(`SELECT * FROM studio_shots WHERE ${clauses.join(' AND ')} ORDER BY shot_index, created_at`)
    .all(...params) as ShotRow[]
  return rows.map(rowToShot)
}

/**
 * 前向 I2V 兼底（项2；SiliconFlow 无原生 FLF2V）：返回「当前镜之前、shot_index 最大且带尾帧」的
 * 那一镜的 endPath，作为当前镜的起始图，实现 end[n]→start[n+1] 的前向连续。
 */
export function resolveForwardStart(runId: string, shotIndex: number): string | null {
  const rid = (runId ?? '').trim()
  if (!rid || !Number.isFinite(Number(shotIndex))) return null
  const row = getDatabase()
    .query(
      `SELECT end_path FROM studio_shots
       WHERE run_id = ? AND shot_index < ? AND end_path IS NOT NULL AND end_path != ''
       ORDER BY shot_index DESC LIMIT 1`,
    )
    .get(rid, Math.trunc(Number(shotIndex))) as { end_path: string | null } | null
  return row?.end_path ?? null
}

export interface UpsertShotInput {
  runId: string
  shotId: string
  shotIndex?: number
  spec?: ShotSpec | null
  startPath?: string | null
  endPath?: string | null
  selected?: boolean
}

/**
 * 建/更新镜头规格（幂等：按 run_id+shot_id）。合并 spec（浅合并）、首尾帧、选中态；
 * 不触碰渲染结果字段（status/draft_path/hq_path/attempt_count）——避免重解析分镜冲掉已渲染结果。
 */
export function upsertShot(input: UpsertShotInput): StudioShot {
  const runId = (input.runId ?? '').trim()
  if (!runId) throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, '镜头需要 runId')
  const shotId = (input.shotId ?? '').trim()
  if (!shotId) throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, '镜头需要 shotId')
  const now = nowIso()
  const existing = getShot(runId, shotId)

  if (existing) {
    const mergedSpec = input.spec && typeof input.spec === 'object'
      ? { ...existing.spec, ...input.spec }
      : existing.spec
    const shotIndex = input.shotIndex !== undefined && Number.isFinite(Number(input.shotIndex))
      ? Math.trunc(Number(input.shotIndex))
      : existing.shotIndex
    getDatabase().run(
      `UPDATE studio_shots SET
         shot_index = ?, spec_json = ?,
         start_path = COALESCE(?, start_path), end_path = COALESCE(?, end_path),
         selected = ?, updated_at = ?
       WHERE id = ?`,
      [
        shotIndex,
        JSON.stringify(mergedSpec ?? {}),
        clampPath(input.startPath),
        clampPath(input.endPath),
        (input.selected !== undefined ? input.selected : existing.selected) ? 1 : 0,
        now,
        existing.id,
      ],
    )
    return getShotById(existing.id)!
  }

  const id = `shot-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`
  const shotIndex = Number.isFinite(Number(input.shotIndex)) ? Math.trunc(Number(input.shotIndex)) : 0
  getDatabase().run(
    `INSERT INTO studio_shots
       (id, run_id, shot_id, shot_index, spec_json, start_path, end_path, draft_path, hq_path,
        status, selected, last_tier, last_provider, attempt_count, error, qc_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, NULL, NULL, 0, NULL, NULL, ?, ?)`,
    [
      id, runId, shotId, shotIndex,
      JSON.stringify(input.spec && typeof input.spec === 'object' ? input.spec : {}),
      clampPath(input.startPath), clampPath(input.endPath),
      input.selected ? 1 : 0, now, now,
    ],
  )
  return getShotById(id)!
}

/** 开始渲染一镜：status→rendering、attempt_count+1、清空上次错误。返回本次 attempt 号。 */
export function markShotRendering(runId: string, shotId: string): { shot: StudioShot; attempt: number } {
  const existing = getShot(runId, shotId)
  if (!existing) throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, `镜头不存在：${runId}/${shotId}`)
  const attempt = existing.attemptCount + 1
  getDatabase().run(
    `UPDATE studio_shots SET status = 'rendering', attempt_count = ?, error = NULL, updated_at = ? WHERE id = ?`,
    [attempt, nowIso(), existing.id],
  )
  return { shot: getShotById(existing.id)!, attempt }
}

export interface RenderedInput {
  tier: ShotTier
  outputPath: string
  provider: string
  endPath?: string | null
  qc?: Record<string, unknown> | null
}

/** 渲染完成一镜：status→done，按 tier 写 draft_path / hq_path，记 last_tier/last_provider。
 * 仅当 provider 产出真实尾帧才更新 end_path（否则保留规格连续尾帧，mock 的 null 不冲掉连续链）。 */
export function markShotRendered(runId: string, shotId: string, result: RenderedInput): StudioShot {
  const existing = getShot(runId, shotId)
  if (!existing) throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, `镜头不存在：${runId}/${shotId}`)
  const tier = normalizeTier(result.tier)
  const outputPath = clampPath(result.outputPath)
  const draftPath = tier === 'draft' ? outputPath : existing.draftPath
  const hqPath = tier === 'hq' ? outputPath : existing.hqPath
  const endPath = result.endPath ? clampPath(result.endPath) : existing.endPath
  const qcJson = result.qc !== undefined && result.qc !== null ? JSON.stringify(result.qc) : (existing.qc ? JSON.stringify(existing.qc) : null)
  getDatabase().run(
    `UPDATE studio_shots SET status = 'done', draft_path = ?, hq_path = ?, end_path = ?,
       last_tier = ?, last_provider = ?, qc_json = ?, error = NULL, updated_at = ? WHERE id = ?`,
    [draftPath, hqPath, endPath, tier, result.provider?.trim() || null, qcJson, nowIso(), existing.id],
  )
  return getShotById(existing.id)!
}

/** 渲染失败一镜：status→failed + 错误信息（记 last_tier 便于排查）。 */
export function markShotFailed(runId: string, shotId: string, error: string, tier?: ShotTier): StudioShot {
  const existing = getShot(runId, shotId)
  if (!existing) throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, `镜头不存在：${runId}/${shotId}`)
  getDatabase().run(
    `UPDATE studio_shots SET status = 'failed', error = ?, last_tier = COALESCE(?, last_tier), updated_at = ? WHERE id = ?`,
    [(error ?? '').slice(0, 2000), tier ?? null, nowIso(), existing.id],
  )
  return getShotById(existing.id)!
}

/** 标记/取消某镜「被选中走 HQ」。 */
export function setShotSelected(runId: string, shotId: string, selected: boolean): StudioShot {
  const existing = getShot(runId, shotId)
  if (!existing) throw new StudioShotError(STUDIO_SHOT_INVALID_INPUT, `镜头不存在：${runId}/${shotId}`)
  getDatabase().run(
    'UPDATE studio_shots SET selected = ?, updated_at = ? WHERE id = ?',
    [selected ? 1 : 0, nowIso(), existing.id],
  )
  return getShotById(existing.id)!
}

/** 清空某 run 的全部镜头（重新解析分镜前清场）。 */
export function clearRunShots(runId: string): number {
  const res = getDatabase().run('DELETE FROM studio_shots WHERE run_id = ?', [(runId ?? '').trim()])
  return res?.changes ?? 0
}

export interface RunShotSummary {
  runId: string
  total: number
  byStatus: Record<ShotStatus, number>
  selected: number
  draftRendered: number
  hqRendered: number
}

/** 某 run 的镜头进度概览（供工作室阶段条 / 交付摘要）。 */
export function summarizeRunShots(runId: string): RunShotSummary {
  const shots = listShots(runId)
  const byStatus: Record<ShotStatus, number> = { pending: 0, rendering: 0, done: 0, failed: 0 }
  let selected = 0
  let draftRendered = 0
  let hqRendered = 0
  for (const shot of shots) {
    byStatus[shot.status] += 1
    if (shot.selected) selected += 1
    if (shot.draftPath) draftRendered += 1
    if (shot.hqPath) hqRendered += 1
  }
  return { runId: (runId ?? '').trim(), total: shots.length, byStatus, selected, draftRendered, hqRendered }
}
