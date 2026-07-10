// [XJC] 会话计划测试（自主强化 · 显式 planning）：store CRUD/注入块 + MCP 工具行为。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { buildPlanBlock, getPlan, setPlan, updateStep, clearPlan } from '../src/plans/store.ts'
import { createPlanTools } from '../src/agent/plan-mcp.ts'

const CHAT = 'plan-test-chat'
const AGENT = 'plan-test-agent'

afterEach(() => {
  getDatabase().run("DELETE FROM chat_plans WHERE chat_id LIKE 'plan-test-%'")
})

describe('plans/store', () => {
  test('setPlan 建计划，getPlan 读回；同 chat 再建覆盖', () => {
    setPlan(CHAT, AGENT, '做一份调研报告', ['检索资料', '整理提纲', '成稿'])
    let plan = getPlan(CHAT)!
    expect(plan.goal).toBe('做一份调研报告')
    expect(plan.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending'])

    setPlan(CHAT, AGENT, '新目标', ['只有一步'])
    plan = getPlan(CHAT)!
    expect(plan.goal).toBe('新目标')
    expect(plan.steps).toHaveLength(1)
  })

  test('updateStep 改状态；越界/非法状态报错', () => {
    setPlan(CHAT, AGENT, 'g', ['a', 'b'])
    const plan = updateStep(CHAT, 1, 'in_progress')
    expect(plan.steps[0]!.status).toBe('in_progress')
    expect(() => updateStep(CHAT, 3, 'done')).toThrow(/不存在/)
    expect(() => updateStep(CHAT, 1, 'bogus' as never)).toThrow(/invalid status/)
    expect(() => updateStep('plan-test-none', 1, 'done')).toThrow(/没有计划/)
  })

  test('buildPlanBlock：未完成注入、全终态不注入、无计划不注入', () => {
    expect(buildPlanBlock(CHAT)).toBeNull()
    setPlan(CHAT, AGENT, '目标', ['s1', 's2'])
    const block = buildPlanBlock(CHAT)!
    expect(block).toContain('<current_plan>')
    expect(block).toContain('1. s1')

    updateStep(CHAT, 1, 'done')
    updateStep(CHAT, 2, 'skipped')
    expect(buildPlanBlock(CHAT)).toBeNull()

    clearPlan(CHAT)
    expect(getPlan(CHAT)).toBeNull()
  })

  test('步骤数/长度上限与空输入校验', () => {
    expect(() => setPlan(CHAT, AGENT, '  ', ['a'])).toThrow(/goal/)
    expect(() => setPlan(CHAT, AGENT, 'g', [])).toThrow(/step/)
    const many = Array.from({ length: 20 }, (_, i) => `step-${i}`)
    const plan = setPlan(CHAT, AGENT, 'g', many)
    expect(plan.steps.length).toBeLessThanOrEqual(12)
    const long = setPlan(CHAT, AGENT, 'G'.repeat(500), ['S'.repeat(300)])
    expect(long.goal.length).toBeLessThanOrEqual(301)
    expect(long.steps[0]!.title.length).toBeLessThanOrEqual(121)
  })
})

describe('plan-mcp 工具', () => {
  const [setTool, updateTool, getTool] = createPlanTools({ chatId: CHAT, agentId: AGENT })

  test('set_plan → get_plan → update_step 全链路', async () => {
    const created = await setTool!.execute('t', { goal: '写周报', steps: ['收集要点', '成稿'] })
    expect(created.content[0]!.text).toContain('写周报')

    const read = await getTool!.execute('t', {})
    expect(read.content[0]!.text).toContain('1. 收集要点')

    const updated = await updateTool!.execute('t', { step: 1, status: 'done' })
    expect(updated.content[0]!.text).toContain('[✓] 1. 收集要点')
    expect(updated.content[0]!.text).toContain('剩余 1 步')

    const finished = await updateTool!.execute('t', { step: 2, status: 'done' })
    expect(finished.content[0]!.text).toContain('全部完成')
  })

  test('无计划时 get 提示、update 报错', async () => {
    const read = await getTool!.execute('t', {})
    expect(read.content[0]!.text).toContain('没有计划')
    await expect(updateTool!.execute('t', { step: 1, status: 'done' })).rejects.toThrow(/没有计划/)
  })
})
