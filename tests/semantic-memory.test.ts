// [XJC] 语义记忆测试：切块/合并去重纯逻辑 + 未安装时的静默降级。
import { describe, expect, test } from 'bun:test'
import './setup.ts'
import {
  buildSemanticMemoryBlock,
  chunkMemoryText,
  mergeMemoryHits,
  searchSemanticMemory,
  type SemanticHit,
} from '../src/memory/semantic.ts'

describe('semantic: chunkMemoryText', () => {
  test('按空行分段，碎段合并，短内容丢弃', () => {
    const text = ['用户主营北美站跨境电商。', '', '偏好简洁回复，不要长篇大论，重要结论放最前面，这样便于快速浏览。', '', '短'].join('\n')
    const chunks = chunkMemoryText(text)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((chunk) => chunk.length >= 40)).toBe(true)
    expect(chunks.join('')).not.toContain('短短')
  })

  test('超长段落硬切且每块不超过上限', () => {
    const long = '很'.repeat(1500)
    const chunks = chunkMemoryText(long)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.every((chunk) => chunk.length <= 480)).toBe(true)
  })

  test('空内容返回空数组', () => {
    expect(chunkMemoryText('')).toEqual([])
    expect(chunkMemoryText('   \n\n  ')).toEqual([])
  })
})

describe('semantic: mergeMemoryHits', () => {
  const fts = [
    { filePath: '/m/MEMORY.md', snippet: '用户是跨境电商卖家，主营北美站点的家居用品类目' },
    { filePath: '/m/2026-07-01.md', snippet: '今天讨论了发票整理流程' },
  ]
  const semantic: SemanticHit[] = [
    { agentId: 'a', fileType: 'note', filePath: '/m/2026-07-01.md', snippet: '今天讨论了发票整理流程', score: 0.8 },
    { agentId: 'a', fileType: 'memory', filePath: '/m/MEMORY.md', snippet: '报销单据统一存放在财务共享盘', score: 0.7 },
  ]

  test('FTS 优先，语义补充，重复片段去重', () => {
    const merged = mergeMemoryHits(fts, semantic, 5)
    expect(merged).toHaveLength(3)
    expect(merged[0]).toBe(fts[0])
    expect((merged[2] as SemanticHit).snippet).toContain('报销单据')
  })

  test('limit 截断', () => {
    expect(mergeMemoryHits(fts, semantic, 2)).toHaveLength(2)
  })
})

describe('semantic: 未安装时静默降级', () => {
  test('searchSemanticMemory 返回空数组', async () => {
    expect(await searchSemanticMemory('agent-x', '发票')).toEqual([])
  })

  test('buildSemanticMemoryBlock 返回 null', async () => {
    expect(await buildSemanticMemoryBlock('agent-x', '发票')).toBeNull()
  })
})
