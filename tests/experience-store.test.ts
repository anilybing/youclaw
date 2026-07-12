// [XJC] 本地经验闭环测试：工具成败统计累计 + 经验块阈值与噪音控制。
import { afterEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { getDatabase } from './setup.ts'
import { buildExperienceBlock, getToolStats, recordToolOutcome } from '../src/agent/experience-store.ts'

const AGENT = 'exp-test-agent'

afterEach(() => {
  getDatabase().run("DELETE FROM tool_experience WHERE agent_id LIKE 'exp-test-%'")
})

describe('experience-store: recordToolOutcome', () => {
  test('累计成败到同一行（员工×类别×工具为主键）', () => {
    recordToolOutcome(AGENT, 'image', 'mcp__media__generate_image', true)
    recordToolOutcome(AGENT, 'image', 'mcp__media__generate_image', true)
    recordToolOutcome(AGENT, 'image', 'mcp__media__generate_image', false)

    const stats = getToolStats(AGENT, 'image')
    expect(stats).toHaveLength(1)
    expect(stats[0]!.successCount).toBe(2)
    expect(stats[0]!.failureCount).toBe(1)
  })

  test('不同类别互不串味', () => {
    recordToolOutcome(AGENT, 'image', 'read', true)
    recordToolOutcome(AGENT, 'other', 'read', false)
    expect(getToolStats(AGENT, 'image')).toHaveLength(1)
    expect(getToolStats(AGENT, 'other')).toHaveLength(1)
    expect(getToolStats(AGENT, 'image')[0]!.failureCount).toBe(0)
  })

  test('空 agentId/toolName 直接忽略', () => {
    recordToolOutcome('', 'image', 'read', true)
    recordToolOutcome(AGENT, 'image', '  ', true)
    expect(getToolStats(AGENT, 'image')).toHaveLength(0)
  })
})

describe('experience-store: buildExperienceBlock', () => {
  test('观测不足（<3 次）不产生任何结论', () => {
    recordToolOutcome(AGENT, 'image', 'mcp__media__generate_image', false)
    recordToolOutcome(AGENT, 'image', 'mcp__media__generate_image', false)
    expect(buildExperienceBlock(AGENT, 'image')).toBeNull()
  })

  test('高失败率工具进入谨慎提示', () => {
    for (let i = 0; i < 2; i++) recordToolOutcome(AGENT, 'other', 'mcp__browser__navigate', false)
    recordToolOutcome(AGENT, 'other', 'mcp__browser__navigate', true)
    const block = buildExperienceBlock(AGENT, 'other')!
    expect(block).toContain('<local_experience>')
    expect(block).toContain('mcp__browser__navigate')
    expect(block).toContain('失败')
    // 隐私边界：只有工具名与次数，不含参数/路径/用户内容
    expect(block).not.toContain('http')
  })

  test('高成功率 mcp__ 工具进入可靠提示（非 other 类别）', () => {
    for (let i = 0; i < 5; i++) recordToolOutcome(AGENT, 'image', 'mcp__media__generate_image', true)
    const block = buildExperienceBlock(AGENT, 'image')!
    expect(block).toContain('mcp__media__generate_image')
    expect(block).toContain('稳定可用')
  })

  test('other 类别不输出可靠表扬（跨场景表扬无指导意义）', () => {
    for (let i = 0; i < 5; i++) recordToolOutcome(AGENT, 'other', 'mcp__task__list_tasks', true)
    expect(buildExperienceBlock(AGENT, 'other')).toBeNull()
  })

  test('内置工具（非 mcp__）可靠不表扬，但高失败仍警示', () => {
    for (let i = 0; i < 5; i++) recordToolOutcome(AGENT, 'knowledge', 'read', true)
    expect(buildExperienceBlock(AGENT, 'knowledge')).toBeNull()

    for (let i = 0; i < 3; i++) recordToolOutcome(AGENT, 'knowledge', 'bash', false)
    const block = buildExperienceBlock(AGENT, 'knowledge')!
    expect(block).toContain('bash')
    expect(block).toContain('失败')
  })

  test('超过 30 天的旧记录不参与统计', () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    getDatabase().run(
      `INSERT INTO tool_experience (agent_id, intent_category, tool_name, success_count, failure_count, updated_at)
       VALUES (?, 'image', 'mcp__media__edit_image', 0, 10, ?)`,
      [AGENT, old],
    )
    expect(buildExperienceBlock(AGENT, 'image')).toBeNull()
  })
})
