// [XJC] 周经营复盘：周范围计算 + 交付物/工作流聚合 + 事实型渲染。
import { beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables } from './setup.ts'
import { createDeliverable, updateDeliverableStatus } from '../src/business/deliverables.ts'
import {
  getWeeklyBusinessReview,
  renderWeeklyBusinessReview,
  resolveBusinessWeekRange,
} from '../src/business/dashboard.ts'

beforeEach(() => cleanTables('deliverables', 'workflow_runs', 'task_run_logs', 'agentops_traces'))

describe('weekly business review', () => {
  test('week range is a Monday..next-Monday half-open window', () => {
    // 2026-07-08 20:00 in Asia/Shanghai is a Wednesday.
    const range = resolveBusinessWeekRange(new Date('2026-07-08T12:00:00.000Z'), 'Asia/Shanghai')
    expect(range.weekStartDate).toBe('2026-07-06')
    expect(range.weekEndDate).toBe('2026-07-12')
    expect(new Date(range.startIso).getTime()).toBeLessThan(new Date(range.endIso).getTime())
  })

  test('aggregates this week deliverables with adoption rate', () => {
    const a = createDeliverable({ title: 'a' })
    const b = createDeliverable({ title: 'b' })
    const c = createDeliverable({ title: 'c' })
    updateDeliverableStatus(a.id, 'adopted')
    updateDeliverableStatus(b.id, 'revised')
    updateDeliverableStatus(c.id, 'discarded')
    const review = getWeeklyBusinessReview()
    expect(review.deliverables.total).toBe(3)
    expect(review.deliverables.adopted).toBe(1)
    expect(review.deliverables.revised).toBe(1)
    expect(review.deliverables.discarded).toBe(1)
    // (adopted + revised) / (total - discarded) = 2 / 2 = 100
    expect(review.deliverables.adoptionRate).toBe(100)
  })

  test('renders a fact-only markdown review that never invents revenue', () => {
    const review = getWeeklyBusinessReview()
    const brief = renderWeeklyBusinessReview(review)
    expect(brief).toContain('# 本周经营复盘')
    expect(brief).toContain('## 交付物')
    expect(brief).toContain('## 下周建议')
    expect(brief).toContain('不推测未接入的营收、订单、毛利或转化')
  })
})
