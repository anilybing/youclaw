// [XJC] 一人公司“今日经营”只读快照。
// 只聚合本地结构化状态，不读取 prompt、对话正文、工作流产出、文件路径或渠道目标。
import { getDatabase } from '../db/index.ts'
import {
  getBusinessProfile,
  getBusinessProfileCompletion,
  type BusinessProfile,
  type BusinessProfileField,
} from './profile.ts'
import { countDeliverablesInRange, type DeliverableStatusCounts } from './deliverables.ts'

export interface BusinessEvidence {
  id: string
  label: string
  value: string | number
  updatedAt: string | null
}

export interface BusinessCandidateAction {
  id: string
  kind:
    | 'complete_profile'
    | 'review_failed_workflows'
    | 'review_failed_automations'
    | 'check_running_workflows'
    | 'continue_plan'
    | 'advance_goal'
    | 'prepare_schedule'
    | 'create_automation'
    | 'organize_knowledge'
  title: string
  reason: string
  route: string
  evidenceIds: string[]
}

export interface TodayBusinessSnapshot {
  schemaVersion: 1
  generatedAt: string
  localDate: string
  timeZone: string
  profile: BusinessProfile & {
    completeness: number
    missingFields: BusinessProfileField[]
  }
  automation: {
    scheduledTasks: {
      total: number
      active: number
      paused: number
      running: number
      failing: number
      nextRun: string | null
      nextName: string | null
    }
    workflowRunsToday: {
      total: number
      running: number
      runningNow: number
      success: number
      failed: number
    }
    activePlans: number
    outOfStockSkus: number
    aiUsageToday: {
      modelCalls: number
      totalTokens: number
      costUsd: number
      toolCalls: number
      unknownCostCalls: number
    }
  }
  evidence: BusinessEvidence[]
  candidateActions: BusinessCandidateAction[]
  dataCoverage: {
    available: string[]
    unavailable: string[]
  }
}

interface ZonedDateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function asNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  }
}

function zonedDateTimeToUtc(parts: ZonedDateParts, timeZone: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  let guess = target
  for (let index = 0; index < 3; index += 1) {
    const observed = getZonedDateParts(new Date(guess), timeZone)
    const observedUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    )
    guess += target - observedUtc
  }
  return new Date(guess)
}

export function resolveBusinessDayRange(now: Date, timeZone: string): {
  localDate: string
  startIso: string
  endIso: string
} {
  const local = getZonedDateParts(now, timeZone)
  const start = zonedDateTimeToUtc({ ...local, hour: 0, minute: 0, second: 0 }, timeZone)
  const nextCalendarDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
  const end = zonedDateTimeToUtc({
    year: nextCalendarDate.getUTCFullYear(),
    month: nextCalendarDate.getUTCMonth() + 1,
    day: nextCalendarDate.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  }, timeZone)
  return {
    localDate: `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  }
}

function countActivePlans(rows: Array<{ steps_json: string }>): number {
  let active = 0
  for (const row of rows) {
    try {
      const steps = JSON.parse(row.steps_json) as Array<{ status?: string }>
      if (Array.isArray(steps) && steps.some((step) => step?.status === 'pending' || step?.status === 'in_progress')) {
        active += 1
      }
    } catch {
      // 损坏计划局部降级，不影响整个经营快照。
    }
  }
  return active
}

function buildCandidateActions(snapshot: Omit<TodayBusinessSnapshot, 'candidateActions'>): BusinessCandidateAction[] {
  const actions: BusinessCandidateAction[] = []
  const { profile, automation } = snapshot

  if (profile.completeness < 100) {
    actions.push({
      id: 'complete_profile',
      kind: 'complete_profile',
      title: '补齐经营画像',
      reason: `当前完成度 ${profile.completeness}%，补齐后经营建议才能贴合真实业务。`,
      route: '/today',
      evidenceIds: ['profile.completeness'],
    })
  }
  if (automation.workflowRunsToday.failed > 0) {
    actions.push({
      id: 'review_failed_workflows',
      kind: 'review_failed_workflows',
      title: '处理失败的工作流',
      reason: `今天有 ${automation.workflowRunsToday.failed} 条工作流失败，优先判断是否续跑或修正输入。`,
      route: '/workflows',
      evidenceIds: ['workflow.failed'],
    })
  }
  if (automation.scheduledTasks.failing > 0) {
    actions.push({
      id: 'review_failed_automations',
      kind: 'review_failed_automations',
      title: '检查连续失败的自动化',
      reason: `${automation.scheduledTasks.failing} 个定时任务存在连续失败，避免静默漏执行。`,
      route: '/cron',
      evidenceIds: ['task.failing'],
    })
  }
  if (automation.workflowRunsToday.runningNow > 0) {
    actions.push({
      id: 'check_running_workflows',
      kind: 'check_running_workflows',
      title: '查看正在执行的工作流',
      reason: `${automation.workflowRunsToday.runningNow} 条工作流仍在执行，可检查当前步骤与费用。`,
      route: '/workflows',
      evidenceIds: ['workflow.running'],
    })
  }
  if (automation.activePlans > 0) {
    actions.push({
      id: 'continue_active_plan',
      kind: 'continue_plan',
      title: '继续未完成的执行计划',
      reason: `当前有 ${automation.activePlans} 个会话计划尚未完成，先推进已有承诺。`,
      route: '/chat',
      evidenceIds: ['plan.active'],
    })
  }
  for (const [index, goal] of profile.currentGoals.entries()) {
    actions.push({
      id: `advance_goal_${index + 1}`,
      kind: 'advance_goal',
      title: `推进目标：${goal}`,
      reason: '围绕已确认的经营目标安排一个今天可完成、可验收的动作。',
      route: '/workbench',
      evidenceIds: ['profile.goals'],
    })
  }
  if (automation.scheduledTasks.nextRun) {
    actions.push({
      id: 'prepare_next_schedule',
      kind: 'prepare_schedule',
      title: '确认下一次自动执行所需资料',
      reason: automation.scheduledTasks.nextName
        ? `下一项是「${automation.scheduledTasks.nextName}」，执行前确认输入仍然有效。`
        : '已有自动任务即将执行，执行前确认输入仍然有效。',
      route: '/cron',
      evidenceIds: ['task.next'],
    })
  }
  if (automation.scheduledTasks.active === 0) {
    actions.push({
      id: 'create_first_automation',
      kind: 'create_automation',
      title: '沉淀第一条周期自动化',
      reason: '当前没有启用的定时任务，选择一项每周重复工作先实现半自动。',
      route: '/workbench',
      evidenceIds: ['task.active'],
    })
  }
  actions.push({
    id: 'organize_business_knowledge',
    kind: 'organize_knowledge',
    title: '整理本周会反复使用的业务资料',
    reason: '把产品、客户、政策或交付模板加入知识库，减少重复说明和上下文偏差。',
    route: '/knowledge',
    evidenceIds: ['profile.updated'],
  })

  return actions.slice(0, 10)
}

export function getTodayBusinessSnapshot(options: {
  now?: Date
  excludeWorkflowRunId?: string
} = {}): TodayBusinessSnapshot {
  const now = options.now ?? new Date()
  const profile = getBusinessProfile()
  const completion = getBusinessProfileCompletion(profile)
  const range = resolveBusinessDayRange(now, profile.timeZone)
  const db = getDatabase()
  const excludedRunId = options.excludeWorkflowRunId ?? ''

  const taskRow = db.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
      SUM(CASE WHEN running_since IS NOT NULL THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END) AS failing
    FROM scheduled_tasks
  `).get() as Record<string, unknown>
  const nextTask = db.query(`
    SELECT name, next_run
    FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND running_since IS NULL
    ORDER BY next_run ASC
    LIMIT 1
  `).get() as { name: string | null; next_run: string } | null
  const workflowRow = db.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM workflow_runs
    WHERE started_at >= ? AND started_at < ? AND id != ?
  `).get(range.startIso, range.endIso, excludedRunId) as Record<string, unknown>
  const runningWorkflowRow = db.query(`
    SELECT COUNT(*) AS count
    FROM workflow_runs
    WHERE status = 'running' AND id != ?
  `).get(excludedRunId) as { count: number } | null
  const usageRow = db.query(`
    SELECT
      SUM(model_calls) AS model_calls,
      SUM(total_tokens) AS total_tokens,
      SUM(cost_usd) AS cost_usd,
      SUM(tool_calls) AS tool_calls,
      SUM(unknown_cost_calls) AS unknown_cost_calls
    FROM agentops_traces
    WHERE started_at >= ? AND started_at < ?
      AND (workflow_run_id IS NULL OR workflow_run_id != ?)
  `).get(range.startIso, range.endIso, excludedRunId) as Record<string, unknown>
  const planRows = db.query('SELECT steps_json FROM chat_plans').all() as Array<{ steps_json: string }>
  const stockRow = db.query(`
    SELECT COUNT(*) AS count
    FROM fulfillment_skus sku
    WHERE NOT EXISTS (
      SELECT 1 FROM fulfillment_cards card
      WHERE card.sku_id = sku.id AND card.status = 'available'
    )
  `).get() as { count: number } | null

  const automation: TodayBusinessSnapshot['automation'] = {
    scheduledTasks: {
      total: asNumber(taskRow.total),
      active: asNumber(taskRow.active),
      paused: asNumber(taskRow.paused),
      running: asNumber(taskRow.running),
      failing: asNumber(taskRow.failing),
      nextRun: nextTask?.next_run ?? null,
      nextName: nextTask?.name ?? null,
    },
    workflowRunsToday: {
      total: asNumber(workflowRow.total),
      running: asNumber(workflowRow.running),
      runningNow: asNumber(runningWorkflowRow?.count),
      success: asNumber(workflowRow.success),
      failed: asNumber(workflowRow.failed),
    },
    activePlans: countActivePlans(planRows),
    outOfStockSkus: asNumber(stockRow?.count),
    aiUsageToday: {
      modelCalls: asNumber(usageRow.model_calls),
      totalTokens: asNumber(usageRow.total_tokens),
      costUsd: asNumber(usageRow.cost_usd),
      toolCalls: asNumber(usageRow.tool_calls),
      unknownCostCalls: asNumber(usageRow.unknown_cost_calls),
    },
  }
  const evidence: BusinessEvidence[] = [
    { id: 'profile.completeness', label: '经营画像完成度', value: completion.completeness, updatedAt: profile.updatedAt },
    { id: 'profile.goals', label: '当前经营目标', value: profile.currentGoals.length, updatedAt: profile.updatedAt },
    { id: 'profile.updated', label: '经营画像更新时间', value: profile.updatedAt ?? '未保存', updatedAt: profile.updatedAt },
    { id: 'workflow.running', label: '当前运行中工作流', value: automation.workflowRunsToday.runningNow, updatedAt: now.toISOString() },
    { id: 'workflow.failed', label: '今日失败工作流', value: automation.workflowRunsToday.failed, updatedAt: now.toISOString() },
    { id: 'task.active', label: '启用中的定时任务', value: automation.scheduledTasks.active, updatedAt: now.toISOString() },
    { id: 'task.failing', label: '连续失败的定时任务', value: automation.scheduledTasks.failing, updatedAt: now.toISOString() },
    { id: 'task.next', label: '下一次自动执行', value: automation.scheduledTasks.nextRun ?? '未安排', updatedAt: now.toISOString() },
    { id: 'plan.active', label: '未完成会话计划', value: automation.activePlans, updatedAt: now.toISOString() },
  ]
  const withoutActions: Omit<TodayBusinessSnapshot, 'candidateActions'> = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    localDate: range.localDate,
    timeZone: profile.timeZone,
    profile: { ...profile, ...completion },
    automation,
    evidence,
    dataCoverage: {
      available: ['本地经营画像', '定时任务状态', '工作流运行状态', '会话计划数量', 'AI 调用与费用'],
      unavailable: ['真实营收', '平台订单', '毛利与现金余额', '线索与成交', '内容曝光与转化'],
    },
  }
  return {
    ...withoutActions,
    candidateActions: buildCandidateActions(withoutActions),
  }
}

export function parseRankedActionIds(raw: string): string[] {
  const text = raw.trim()
  const candidates = [text, text.match(/\[[\s\S]*\]/)?.[0]].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (!Array.isArray(parsed)) continue
      return parsed
        .map((item) => typeof item === 'string' ? item : '')
        .filter(Boolean)
    } catch {
      // Try the next extracted JSON candidate.
    }
  }
  return []
}

export function renderTodayBusinessBrief(snapshot: TodayBusinessSnapshot, ranking: string): string {
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.candidateActions)) {
    throw new Error('经营快照格式无效')
  }
  const byId = new Map(snapshot.candidateActions.map((action) => [action.id, action]))
  const selected: BusinessCandidateAction[] = []
  for (const id of parseRankedActionIds(ranking)) {
    const action = byId.get(id)
    if (action && !selected.some((item) => item.id === id)) selected.push(action)
    if (selected.length === 3) break
  }
  for (const action of snapshot.candidateActions) {
    if (!selected.some((item) => item.id === action.id)) selected.push(action)
    if (selected.length === 3) break
  }

  const lines = [
    '# 今日经营行动简报',
    '',
    `> ${snapshot.profile.businessName || '尚未命名的业务'} · ${snapshot.localDate} · 数据截至 ${snapshot.generatedAt}`,
    '',
    '## 今天最重要的三件事',
    '',
  ]
  for (const [index, action] of selected.entries()) {
    lines.push(
      `${index + 1}. **${action.title}**`,
      `   - 原因：${action.reason}`,
      `   - 依据：${action.evidenceIds.join('、')}`,
      `   - 入口：${action.route}`,
    )
  }
  const { scheduledTasks, workflowRunsToday, aiUsageToday } = snapshot.automation
  lines.push(
    '',
    '## 自动化状态',
    '',
    `- 工作流：今日成功 ${workflowRunsToday.success} · 当前运行中 ${workflowRunsToday.runningNow} · 今日失败 ${workflowRunsToday.failed}`,
    `- 定时任务：启用 ${scheduledTasks.active} · 连续失败 ${scheduledTasks.failing} · 暂停 ${scheduledTasks.paused}`,
    `- AI 使用：模型调用 ${aiUsageToday.modelCalls} · Token ${aiUsageToday.totalTokens} · 工具调用 ${aiUsageToday.toolCalls} · 已知费用 $${aiUsageToday.costUsd.toFixed(4)}`,
    '',
    '## 数据边界',
    '',
    `- 已覆盖：${snapshot.dataCoverage.available.join('、')}`,
    `- 尚未接入：${snapshot.dataCoverage.unavailable.join('、')}`,
    '- 本简报不会推测未接入的营收、订单、毛利或转化数据。',
  )
  return lines.join('\n')
}

// ── 周经营复盘（Weekly Business Review）─────────────────────────────────────
// 事实型：只聚合本地结构化状态（交付物、工作流、定时任务、AI 用量），确定性生成建议，不 LLM、不推测营收。

export interface WeeklyBusinessReview {
  schemaVersion: 1
  generatedAt: string
  weekStartDate: string
  weekEndDate: string
  timeZone: string
  businessName: string
  currentGoals: string[]
  completeness: number
  deliverables: DeliverableStatusCounts & { adoptionRate: number }
  workflows: { total: number; success: number; failed: number }
  automations: { executions: number; success: number; failed: number }
  aiUsage: { modelCalls: number; totalTokens: number; costUsd: number; toolCalls: number }
  dataCoverage: { available: string[]; unavailable: string[] }
}

/** 本地经营周范围：本周一 00:00 到下周一 00:00（半开区间，经营时区）。 */
export function resolveBusinessWeekRange(now: Date, timeZone: string): {
  weekStartDate: string
  weekEndDate: string
  startIso: string
  endIso: string
} {
  const local = getZonedDateParts(now, timeZone)
  const localMidday = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0))
  const daysFromMonday = (localMidday.getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(local.year, local.month - 1, local.day - daysFromMonday))
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6))
  const nextMonday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7))
  const start = zonedDateTimeToUtc(
    { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate(), hour: 0, minute: 0, second: 0 },
    timeZone,
  )
  const end = zonedDateTimeToUtc(
    { year: nextMonday.getUTCFullYear(), month: nextMonday.getUTCMonth() + 1, day: nextMonday.getUTCDate(), hour: 0, minute: 0, second: 0 },
    timeZone,
  )
  const fmt = (d: Date) => `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  return { weekStartDate: fmt(monday), weekEndDate: fmt(sunday), startIso: start.toISOString(), endIso: end.toISOString() }
}

export function getWeeklyBusinessReview(options: { now?: Date } = {}): WeeklyBusinessReview {
  const now = options.now ?? new Date()
  const profile = getBusinessProfile()
  const completion = getBusinessProfileCompletion(profile)
  const range = resolveBusinessWeekRange(now, profile.timeZone)
  const db = getDatabase()

  const workflowRow = db.query(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM workflow_runs WHERE started_at >= ? AND started_at < ?
  `).get(range.startIso, range.endIso) as Record<string, unknown>
  const taskRow = db.query(`
    SELECT COUNT(*) AS executions,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed
    FROM task_run_logs WHERE run_at >= ? AND run_at < ?
  `).get(range.startIso, range.endIso) as Record<string, unknown>
  const usageRow = db.query(`
    SELECT SUM(model_calls) AS model_calls, SUM(total_tokens) AS total_tokens,
      SUM(cost_usd) AS cost_usd, SUM(tool_calls) AS tool_calls
    FROM agentops_traces WHERE started_at >= ? AND started_at < ?
  `).get(range.startIso, range.endIso) as Record<string, unknown>
  const counts = countDeliverablesInRange(range.startIso, range.endIso)
  const decided = counts.adopted + counts.revised
  const denom = counts.total - counts.discarded
  const adoptionRate = denom > 0 ? Math.round((decided / denom) * 100) : 0

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    weekStartDate: range.weekStartDate,
    weekEndDate: range.weekEndDate,
    timeZone: profile.timeZone,
    businessName: profile.businessName,
    currentGoals: profile.currentGoals,
    completeness: completion.completeness,
    deliverables: { ...counts, adoptionRate },
    workflows: { total: asNumber(workflowRow.total), success: asNumber(workflowRow.success), failed: asNumber(workflowRow.failed) },
    automations: { executions: asNumber(taskRow.executions), success: asNumber(taskRow.success), failed: asNumber(taskRow.failed) },
    aiUsage: {
      modelCalls: asNumber(usageRow.model_calls),
      totalTokens: asNumber(usageRow.total_tokens),
      costUsd: asNumber(usageRow.cost_usd),
      toolCalls: asNumber(usageRow.tool_calls),
    },
    dataCoverage: {
      available: ['本周交付物与采用状态', '工作流运行结果', '定时任务执行结果', 'AI 调用与费用'],
      unavailable: ['真实营收', '平台订单', '毛利与现金余额', '线索与成交'],
    },
  }
}

export function renderWeeklyBusinessReview(review: WeeklyBusinessReview): string {
  const d = review.deliverables
  const suggestions: string[] = []
  if (d.draft > 0) suggestions.push(`有 ${d.draft} 个交付物待你确认「采用/修改/废弃」，先把本周产出定性。`)
  if (review.workflows.failed > 0) suggestions.push(`本周 ${review.workflows.failed} 条工作流失败，排查输入或续跑。`)
  if (review.automations.failed > 0) suggestions.push(`定时任务有 ${review.automations.failed} 次失败执行，确认是否需要修正。`)
  if (d.total === 0) suggestions.push('本周还没有登记交付物，跑一个工作流或手动登记一次成果，形成可复盘的产出。')
  if (review.completeness < 100) suggestions.push('补齐经营画像，让下周的经营建议更贴合真实业务。')
  if (suggestions.length === 0) suggestions.push('本周产出与执行状态健康，围绕当前目标安排下周第一个可交付动作。')

  const lines = [
    '# 本周经营复盘',
    '',
    `> ${review.businessName || '尚未命名的业务'} · ${review.weekStartDate} ~ ${review.weekEndDate} · 数据截至 ${review.generatedAt}`,
    '',
    '## 交付物',
    '',
    `- 本周产出 ${d.total} 个：已采用 ${d.adopted} · 已修改 ${d.revised} · 已废弃 ${d.discarded} · 待处理 ${d.draft}`,
    `- 采用率 ${d.adoptionRate}%（已采用+已修改 ÷ 未废弃）`,
    '',
    '## AI 执行',
    '',
    `- 工作流：成功 ${review.workflows.success} · 失败 ${review.workflows.failed}（共 ${review.workflows.total}）`,
    `- 定时任务执行：${review.automations.executions} 次（成功 ${review.automations.success} · 失败 ${review.automations.failed}）`,
    `- AI 使用：模型调用 ${review.aiUsage.modelCalls} · Token ${review.aiUsage.totalTokens} · 工具调用 ${review.aiUsage.toolCalls} · 已知费用 $${review.aiUsage.costUsd.toFixed(4)}`,
    '',
    '## 经营目标',
    '',
    ...(review.currentGoals.length > 0 ? review.currentGoals.map((goal) => `- ${goal}`) : ['- （尚未设定经营目标）']),
    '',
    '## 下周建议',
    '',
    ...suggestions.map((item, index) => `${index + 1}. ${item}`),
    '',
    '## 数据边界',
    '',
    `- 已覆盖：${review.dataCoverage.available.join('、')}`,
    `- 尚未接入：${review.dataCoverage.unavailable.join('、')}`,
    '- 本复盘为事实汇总，不推测未接入的营收、订单、毛利或转化。',
  ]
  return lines.join('\n')
}
