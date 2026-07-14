// [XJC] 漫剧工作室·镜头级成本台账（cost_ledger）+ ¥ 预算硬闸
//
// 目的：每次 render_*（出图/出视频）写一条成本记录，把「一集成本」拆到镜/供应商/档位，
// 支撑「镜头级成本 + 每分钟成本 + provider 占比」看板与混用策略数据化；并提供 ¥ 预算硬闸，
// 在「真渲染」前预估卡住总预算（默认 ¥32；逼近 ¥30 警戒线阻断并回主控确认）。
//
// 与 run 级 token 预算（budget.ts, maxTotalTokens=36k / maxCostUsd=2.5 硬闸）互补：
// budget.ts 管「模型 token 费用 + 步骤/时长闸门」；本台账记「视频/图像供应商的 credits/费用（¥）」。
// dry_run（mock 联调）记名义成本、免费、不计入预算；真出片记真实 ¥、计入并受硬闸约束。

import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/index.ts'
import { getStoredSettings } from '../settings/manager.ts'

export const COST_LEDGER_INVALID_INPUT = 'COST_LEDGER_INVALID_INPUT'

export class CostLedgerError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'CostLedgerError'
  }
}

export type CostKind = 'video' | 'image' | 'vlm' | 'other'
export type CostStatus = 'ok' | 'failed'

export interface CostLedgerEntry {
  id: string
  runId: string
  shotId: string | null
  kind: CostKind
  provider: string
  model: string | null
  tier: string | null
  credits: number
  costUsd: number
  costCny: number
  attempt: number
  durationMs: number
  dryRun: boolean
  status: CostStatus
  detail: string | null
  createdAt: string
}

interface CostRow {
  id: string
  run_id: string
  shot_id: string | null
  kind: string
  provider: string
  model: string | null
  tier: string | null
  credits: number
  cost_usd: number
  cost_cny: number
  attempt: number
  duration_ms: number
  dry_run: number
  status: string
  detail: string | null
  created_at: string
}

const DETAIL_MAX = 2000

function nowIso(): string {
  return new Date().toISOString()
}

function rowToEntry(row: CostRow): CostLedgerEntry {
  return {
    id: row.id,
    runId: row.run_id,
    shotId: row.shot_id,
    kind: row.kind as CostKind,
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    credits: row.credits,
    costUsd: row.cost_usd,
    costCny: row.cost_cny,
    attempt: row.attempt,
    durationMs: row.duration_ms,
    dryRun: row.dry_run === 1,
    status: row.status as CostStatus,
    detail: row.detail,
    createdAt: row.created_at,
  }
}

function nonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export interface RecordCostInput {
  runId: string
  provider: string
  shotId?: string | null
  kind?: CostKind
  model?: string | null
  tier?: string | null
  credits?: number
  costUsd?: number
  costCny?: number
  attempt?: number
  durationMs?: number
  dryRun?: boolean
  status?: CostStatus
  detail?: string | null
}

/** 追加一条成本记录（append-only；每次渲染尝试一行，含重试）。 */
export function recordCost(input: RecordCostInput): CostLedgerEntry {
  const runId = (input.runId ?? '').trim()
  if (!runId) throw new CostLedgerError(COST_LEDGER_INVALID_INPUT, '成本记录需要 runId')
  const provider = (input.provider ?? '').trim()
  if (!provider) throw new CostLedgerError(COST_LEDGER_INVALID_INPUT, '成本记录需要 provider')
  const id = `cost-${Date.now().toString(36)}${randomUUID().slice(0, 8)}`
  const attempt = Number.isFinite(Number(input.attempt)) && Number(input.attempt) > 0 ? Math.trunc(Number(input.attempt)) : 1
  const now = nowIso()
  getDatabase().run(
    `INSERT INTO studio_cost_ledger
       (id, run_id, shot_id, kind, provider, model, tier, credits, cost_usd, cost_cny, attempt, duration_ms, dry_run, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      runId,
      input.shotId?.trim() || null,
      (input.kind ?? 'video'),
      provider,
      input.model?.trim() || null,
      input.tier?.trim() || null,
      nonNegative(input.credits),
      nonNegative(input.costUsd),
      nonNegative(input.costCny),
      attempt,
      Math.max(0, Math.trunc(Number(input.durationMs) || 0)),
      input.dryRun ? 1 : 0,
      (input.status ?? 'ok'),
      input.detail?.trim().slice(0, DETAIL_MAX) || null,
      now,
    ],
  )
  const created = getCostEntry(id)
  if (!created) throw new CostLedgerError(COST_LEDGER_INVALID_INPUT, '成本记录写入失败')
  return created
}

export function getCostEntry(id: string): CostLedgerEntry | null {
  const row = getDatabase().query('SELECT * FROM studio_cost_ledger WHERE id = ?').get((id ?? '').trim()) as CostRow | null
  return row ? rowToEntry(row) : null
}

export function listRunCosts(runId: string): CostLedgerEntry[] {
  const id = (runId ?? '').trim()
  if (!id) return []
  const rows = getDatabase()
    .query('SELECT * FROM studio_cost_ledger WHERE run_id = ? ORDER BY created_at, id')
    .all(id) as CostRow[]
  return rows.map(rowToEntry)
}

export function listShotCosts(runId: string, shotId: string): CostLedgerEntry[] {
  const rid = (runId ?? '').trim()
  const sid = (shotId ?? '').trim()
  if (!rid || !sid) return []
  const rows = getDatabase()
    .query('SELECT * FROM studio_cost_ledger WHERE run_id = ? AND shot_id = ? ORDER BY created_at, id')
    .all(rid, sid) as CostRow[]
  return rows.map(rowToEntry)
}

export interface CostBucket {
  credits: number
  costUsd: number
  costCny: number
  count: number
}

export interface RunCostSummary {
  runId: string
  entries: number
  totalCredits: number
  totalCostUsd: number
  totalCostCny: number
  attempts: number
  /** 只统计 dry_run=false 的真实花费；mock 联调期真实为 0 */
  realCostUsd: number
  realCostCny: number
  realCredits: number
  byProvider: Record<string, CostBucket>
  byTier: Record<string, CostBucket>
  byShot: Record<string, CostBucket>
}

function addToBucket(map: Record<string, CostBucket>, key: string, entry: CostLedgerEntry): void {
  const bucket = map[key] ?? { credits: 0, costUsd: 0, costCny: 0, count: 0 }
  bucket.credits += entry.credits
  bucket.costUsd += entry.costUsd
  bucket.costCny += entry.costCny
  bucket.count += 1
  map[key] = bucket
}

/** 某 run 的成本归集：总额 + 按 provider / tier / shot 拆分（看板/降本策略的数据源）。 */
export function summarizeRunCost(runId: string): RunCostSummary {
  const entries = listRunCosts(runId)
  const summary: RunCostSummary = {
    runId: (runId ?? '').trim(),
    entries: entries.length,
    totalCredits: 0,
    totalCostUsd: 0,
    totalCostCny: 0,
    attempts: 0,
    realCostUsd: 0,
    realCostCny: 0,
    realCredits: 0,
    byProvider: {},
    byTier: {},
    byShot: {},
  }
  for (const entry of entries) {
    summary.totalCredits += entry.credits
    summary.totalCostUsd += entry.costUsd
    summary.totalCostCny += entry.costCny
    summary.attempts += 1
    if (!entry.dryRun) {
      summary.realCostUsd += entry.costUsd
      summary.realCostCny += entry.costCny
      summary.realCredits += entry.credits
    }
    addToBucket(summary.byProvider, entry.provider, entry)
    if (entry.tier) addToBucket(summary.byTier, entry.tier, entry)
    if (entry.shotId) addToBucket(summary.byShot, entry.shotId, entry)
  }
  return summary
}

/** 清空某 run 的成本台账（重跑整集前清场）。 */
export function clearRunCosts(runId: string): number {
  const res = getDatabase().run('DELETE FROM studio_cost_ledger WHERE run_id = ?', [(runId ?? '').trim()])
  return res?.changes ?? 0
}

// ── ¥ 预算硬闸 ───────────────────────────────────────────────────────────
// 用户给定硬预算 ¥32：图 ¥0.3/张、视频 5s ¥2/条，其余给分镜脚本(LLM)。
// 8–12 镜 draft 全量 ≈ ¥30，几乎用光、无重试余地 → 真渲染前必须预估卡住。

export const DEFAULT_RUN_BUDGET_CNY = 32
export const DEFAULT_WARN_CNY = 30

/** SiliconFlow（硅基流动）真实成本口径（¥）：5s 视频 ≈ ¥2、关键帧图 ≈ ¥0.3。hq 暂缓，给占位。 */
export const SILICONFLOW_COST_CNY = {
  draftVideo5s: 2,
  hqVideo5s: 6,
  image: 0.3,
} as const

export const STUDIO_BUDGET_EXCEEDED = 'STUDIO_BUDGET_EXCEEDED'

export interface BudgetStatus {
  runId: string
  limitCny: number
  warnCny: number
  /** 已发生的真实花费（dry_run=false） */
  spentCny: number
  /** 本批预估增量 */
  addCny: number
  /** spentCny + addCny */
  projectedCny: number
  remainingCny: number
  /** projected ≥ 警戒线 */
  nearLimit: boolean
  /** projected > 硬顶 */
  exceeded: boolean
}

export class BudgetExceededError extends Error {
  readonly code = STUDIO_BUDGET_EXCEEDED
  constructor(message: string, public readonly status: BudgetStatus) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export interface BudgetOptions {
  limitCny?: number
  warnCny?: number
  /** 已获主控确认后可越过警戒线（¥30）继续到硬顶（¥32） */
  allowNearLimit?: boolean
}

/** 某 run 的预算状态（只计真实花费 dry_run=false；addCny 为本批预估增量）。 */
/** 从 settings.studio 读 ¥ 预算硬顶（maxRenderCnyPerRun，¥ 全口径；SiliconFlow ¥ 计费）；DB 未就绪回退默认 ¥32。 */
function readStudioBudgetCny(): number {
  try {
    const v = Number(getStoredSettings().studio.maxRenderCnyPerRun)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_RUN_BUDGET_CNY
  } catch {
    return DEFAULT_RUN_BUDGET_CNY
  }
}

export function getRunBudgetStatus(runId: string, addCny = 0, opts?: BudgetOptions): BudgetStatus {
  const limitCny = opts?.limitCny ?? readStudioBudgetCny()
  const warnCny = opts?.warnCny ?? Math.max(0, limitCny - 2)
  const spentCny = summarizeRunCost(runId).realCostCny
  const add = nonNegative(addCny)
  const projectedCny = spentCny + add
  return {
    runId: (runId ?? '').trim(),
    limitCny,
    warnCny,
    spentCny,
    addCny: add,
    projectedCny,
    remainingCny: Math.max(0, limitCny - spentCny),
    nearLimit: projectedCny >= warnCny,
    exceeded: projectedCny > limitCny,
  }
}

/**
 * 真渲染前的 ¥ 硬闸：预估本批成本，超硬顶（¥32）或未确认下越警戒线（¥30）即抛 BudgetExceededError
 * 阻断，由调用方回主控确认（确认后传 allowNearLimit=true 放行至硬顶）。
 * dry-run/mock 免费、不应调用本闸。
 */
export function assertRunBudget(runId: string, addCny: number, opts?: BudgetOptions): BudgetStatus {
  const status = getRunBudgetStatus(runId, addCny, opts)
  if (status.projectedCny > status.limitCny) {
    throw new BudgetExceededError(
      `漫剧预算硬顶超限：已花 ¥${status.spentCny.toFixed(2)} + 本批 ¥${status.addCny.toFixed(2)} = ¥${status.projectedCny.toFixed(2)} > 硬顶 ¥${status.limitCny}。请削减镜数或调高预算。`,
      status,
    )
  }
  if (status.nearLimit && !opts?.allowNearLimit) {
    throw new BudgetExceededError(
      `漫剧预算逼近警戒线：预计 ¥${status.projectedCny.toFixed(2)} ≥ 警戒 ¥${status.warnCny}（硬顶 ¥${status.limitCny}）。已阻断，请回主控确认后再续。`,
      status,
    )
  }
  return status
}

/** 估算一批视频渲染的 ¥ 成本（tier 决定单价；count 条数）。 */
export function estimateVideoCny(tier: 'draft' | 'hq', count = 1): number {
  const unit = tier === 'hq' ? SILICONFLOW_COST_CNY.hqVideo5s : SILICONFLOW_COST_CNY.draftVideo5s
  const n = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.trunc(Number(count)) : 1
  return unit * n
}

/** 估算一批关键帧/设定图的 ¥ 成本（SiliconFlow 图 ≈ ¥0.3/张）。 */
export function estimateImageCny(count = 1): number {
  const n = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.trunc(Number(count)) : 1
  return SILICONFLOW_COST_CNY.image * n
}
