// [XJC] 人设一键优化测试：注入假 runner，验证 prompt 组装/JSON 容错解析/幻觉技能过滤。
import { describe, expect, test } from 'bun:test'
import './setup.ts'
import { optimizePersona, parseOptimizeResponse } from '../src/agent/persona-optimizer.ts'

const SKILLS = [
  { name: 'ecom-copywriter', description: '电商文案' },
  { name: 'ecom-image', description: '商品图批量处理' },
  { name: 'content-video-script', description: '短视频脚本' },
]

describe('parseOptimizeResponse', () => {
  const allowed = new Set(SKILLS.map((s) => s.name))

  test('标准 JSON 解析 + 幻觉技能被过滤', () => {
    const raw = JSON.stringify({
      suggestedName: '电商助手',
      persona: '# 角色定位\n电商女装运营助手',
      skills: ['ecom-copywriter', 'made-up-skill', 'ecom-image'],
    })
    const result = parseOptimizeResponse(raw, allowed)
    expect(result.suggestedName).toBe('电商助手')
    expect(result.persona).toContain('角色定位')
    expect(result.suggestedSkills).toEqual(['ecom-copywriter', 'ecom-image'])
  })

  test('容错：代码块包裹 + 前后噪声', () => {
    const raw = '好的，结果如下：\n```json\n{"suggestedName":"助手","persona":"# 角色定位\\nX","skills":[]}\n```\n以上'
    const result = parseOptimizeResponse(raw, allowed)
    expect(result.persona).toContain('X')
  })

  test('缺 persona 抛错；超长名截断；技能去重', () => {
    expect(() => parseOptimizeResponse('{"skills":[]}', allowed)).toThrow(/人设/)
    const long = parseOptimizeResponse(JSON.stringify({
      suggestedName: '名'.repeat(40),
      persona: 'P',
      skills: ['ecom-image', 'ecom-image'],
    }), allowed)
    expect(long.suggestedName.length).toBeLessThanOrEqual(20)
    expect(long.suggestedSkills).toEqual(['ecom-image'])
  })
})

describe('optimizePersona', () => {
  test('prompt 携带用户描述与技能清单；返回解析结果', async () => {
    let capturedSystem = ''
    let capturedUser = ''
    const result = await optimizePersona(
      '我是做电商女装的，需要爆款文案和商品套图',
      SKILLS,
      async (sys, user) => {
        capturedSystem = sys
        capturedUser = user
        return JSON.stringify({ suggestedName: '电商助手', persona: '# 角色定位\n女装电商助手', skills: ['ecom-copywriter'] })
      },
    )
    expect(capturedSystem).toContain('数字员工人设设计师')
    expect(capturedUser).toContain('电商女装')
    expect(capturedUser).toContain('ecom-copywriter: 电商文案')
    expect(result.persona).toContain('女装电商助手')
    expect(result.suggestedSkills).toEqual(['ecom-copywriter'])
  })

  test('空描述直接抛错（不调 runner）', async () => {
    let called = false
    await expect(optimizePersona('  ', SKILLS, async () => { called = true; return '{}' })).rejects.toThrow(/需求描述/)
    expect(called).toBe(false)
  })
})
