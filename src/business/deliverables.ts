// [XJC] 交付物登记：把 AI 的关键产出（工作流报告、生成的图片/视频、手动登记的产物）
// 记成结构化、可「采用/修改/废弃」的交付物台账，供今日经营与周经营复盘度量北极星
// （真实资料 → AI 执行 → 可检查交付物 → 采用/修改 → 形成下一步）。仅本地，不外发。
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/index.ts'

export type DeliverableType = 'report' | 'image' | 'video' | 'document' | 'notes' | 'other'
export type DeliverableSourceKind = 'workflow' | 'media' | 'task' | 'manual'
export type DeliverableStatus = 'draft' | 'adopted' | 'revised' | 'discarded'

const TYPES = new Set<DeliverableType>(['report', 'image', 'video', 'document', 'notes', 'other'])
const STATUSES = new Set<DeliverableStatus>(['draft', 'adopted', 'revised', 'discarded'])
const MAX_TITLE = 200
const MAX_SUMMARY = 2000

export interface Deliverable {
  id: string
  title: string
  type: DeliverableType
  source_kind: DeliverableSourceKind
  source_id: string | null
  agent_id: string | null
  chat_id: string | null
  file_path: string | null
  summary: string | null
  status: DeliverableStatus
  created_at: string
  updated_at: string
}

export interface CreateDeliverableInput {
  title: string
  type?: DeliverableType
  sourceKind?: DeliverableSourceKind
  sourceId?: string | null
  agentId?: string | null
  chatId?: string | null
  filePath?: string | null
  summary?: string | null
}

export interface DeliverableStatusCounts {
  total: number
  draft: number
  adopted: number
  revised: number
  discarded: number
}

function normalizeType(value: unknown): DeliverableType {
  return TYPES.has(value as DeliverableType) ? (value as DeliverableType) : 'other'
}

export function isDeliverableStatus(value: unknown): value is DeliverableStatus {
  return STATUSES.has(value as DeliverableStatus)
}

export function createDeliverable(input: CreateDeliverableInput): Deliverable {
  const id = randomUUID()
  const now = new Date().toISOString()
  const title = (input.title ?? '').trim().slice(0, MAX_TITLE) || '未命名交付物'
  const summary = input.summary ? String(input.summary).trim().slice(0, MAX_SUMMARY) : null
  getDatabase().run(
    `INSERT INTO deliverables (id, title, type, source_kind, source_id, agent_id, chat_id, file_path, summary, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [
      id,
      title,
      normalizeType(input.type),
      input.sourceKind ?? 'manual',
      input.sourceId ?? null,
      input.agentId ?? null,
      input.chatId ?? null,
      input.filePath ?? null,
      summary,
      now,
      now,
    ],
  )
  return getDeliverable(id)!
}

export function getDeliverable(id: string): Deliverable | null {
  return (getDatabase().query('SELECT * FROM deliverables WHERE id = ?').get(id) as Deliverable) ?? null
}

export function listDeliverables(
  filters: { status?: DeliverableStatus; type?: DeliverableType; limit?: number } = {},
): Deliverable[] {
  const conditions: string[] = []
  const params: Array<string | number> = []
  if (filters.status && STATUSES.has(filters.status)) { conditions.push('status = ?'); params.push(filters.status) }
  if (filters.type && TYPES.has(filters.type)) { conditions.push('type = ?'); params.push(filters.type) }
  let sql = 'SELECT * FROM deliverables'
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(Math.min(Math.max(1, filters.limit ?? 50), 200))
  return getDatabase().query(sql).all(...params) as Deliverable[]
}

export function updateDeliverableStatus(id: string, status: DeliverableStatus): Deliverable | null {
  if (!STATUSES.has(status)) throw new Error(`非法交付物状态：${status}`)
  if (!getDeliverable(id)) return null
  getDatabase().run('UPDATE deliverables SET status = ?, updated_at = ? WHERE id = ?', [status, new Date().toISOString(), id])
  return getDeliverable(id)
}

export function deleteDeliverable(id: string): boolean {
  if (!getDeliverable(id)) return false
  getDatabase().run('DELETE FROM deliverables WHERE id = ?', [id])
  return true
}

/** 时间窗内（ISO 半开区间 [start,end)）按状态计数，供周经营复盘聚合。 */
export function countDeliverablesInRange(startIso: string, endIso: string): DeliverableStatusCounts {
  const row = getDatabase().query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status = 'adopted' THEN 1 ELSE 0 END) AS adopted,
      SUM(CASE WHEN status = 'revised' THEN 1 ELSE 0 END) AS revised,
      SUM(CASE WHEN status = 'discarded' THEN 1 ELSE 0 END) AS discarded
    FROM deliverables
    WHERE created_at >= ? AND created_at < ?
  `).get(startIso, endIso) as Record<string, unknown>
  const n = (value: unknown): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return {
    total: n(row.total),
    draft: n(row.draft),
    adopted: n(row.adopted),
    revised: n(row.revised),
    discarded: n(row.discarded),
  }
}

/**
 * 自动登记：产出点（工作流成功、媒体生成）调用，任何异常都吞掉，
 * 绝不影响主流程（如工作流 finishRun）。
 */
export function autoRegisterDeliverable(input: CreateDeliverableInput): void {
  try {
    createDeliverable(input)
  } catch {
    // 登记失败静默降级，不阻断产出主流程。
  }
}
