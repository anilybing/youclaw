/**
 * 知识库 RAG（T-A1）测试：addDocument / search / deleteDoc 全链路 + MCP 工具。
 * DB 初始化走共享 setup.ts（临时 DATA_DIR），风格与既有测试一致。
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { getDatabase } from './setup.ts'
import { getKnowledgeService } from '../src/knowledge/service.ts'
import { KnowledgeError, KNOWLEDGE_UNSUPPORTED_TYPE } from '../src/knowledge/types.ts'
import { createKnowledgeTools } from '../src/agent/knowledge-mcp.ts'

const service = getKnowledgeService() // 构造时建表

function cleanKnowledgeTables() {
  const db = getDatabase()
  db.run('DELETE FROM knowledge_docs')
  db.run('DELETE FROM knowledge_chunks')
  db.run('DELETE FROM knowledge_fts')
}

function mdBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

const SAMPLE_MD = `# 差旅报销制度

## 报销标准

员工出差住宿费标准：一线城市每晚不超过 500 元，其他城市每晚不超过 350 元。
市内交通费实报实销，需提供发票。

## 审批流程

出差前需在 OA 系统提交出差申请，经直属主管审批后方可预订行程。
报销单需在出差结束后 10 个工作日内提交，超期不予受理。

## Travel Policy Summary

Hotel expenses are capped at 500 CNY per night in tier-1 cities.
Reimbursement requests must be submitted within 10 business days.
`

describe('knowledge addDocument', () => {
  beforeEach(cleanKnowledgeTables)

  test('md 文档入库：三表落库且元信息正确', async () => {
    const doc = await service.addDocument({
      filename: '差旅报销制度.md',
      mediaType: 'text/markdown',
      data: mdBytes(SAMPLE_MD),
    })

    expect(doc.title).toBe('差旅报销制度.md')
    expect(doc.sizeBytes).toBe(mdBytes(SAMPLE_MD).byteLength)
    expect(doc.chunkCount).toBeGreaterThan(0)

    const listed = service.listDocs()
    expect(listed.length).toBe(1)
    expect(listed[0]!.id).toBe(doc.id)

    const db = getDatabase()
    const chunkRows = db.query('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE doc_id = ?').get(doc.id) as { n: number }
    const ftsRows = db.query('SELECT COUNT(*) AS n FROM knowledge_fts WHERE doc_id = ?').get(doc.id) as { n: number }
    expect(chunkRows.n).toBe(doc.chunkCount)
    expect(ftsRows.n).toBe(doc.chunkCount)
  })

  test('长文本按 1600/160 分块（多块）', async () => {
    const paragraph = 'FTS5 keyword retrieval baseline works fully offline. '.repeat(20)
    const longText = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n\n${paragraph}`).join('\n\n')
    const doc = await service.addDocument({
      filename: 'long.txt',
      mediaType: 'text/plain',
      data: mdBytes(longText),
    })
    expect(doc.chunkCount).toBeGreaterThan(1)
  })

  test('不支持的类型抛 KNOWLEDGE_UNSUPPORTED_TYPE', async () => {
    await expect(
      service.addDocument({
        filename: 'app.exe',
        mediaType: 'application/octet-stream',
        data: mdBytes('binary'),
      }),
    ).rejects.toThrow(KnowledgeError)

    try {
      await service.addDocument({
        filename: 'app.exe',
        mediaType: 'application/octet-stream',
        data: mdBytes('binary'),
      })
      expect.unreachable()
    } catch (err) {
      expect((err as KnowledgeError).code).toBe(KNOWLEDGE_UNSUPPORTED_TYPE)
    }
  })

  test('空文档（无可提取文本）拒绝入库', async () => {
    await expect(
      service.addDocument({ filename: 'empty.txt', mediaType: 'text/plain', data: mdBytes('   \n\n  ') }),
    ).rejects.toThrow(KnowledgeError)
    expect(service.listDocs().length).toBe(0)
  })
})

describe('knowledge search', () => {
  beforeEach(async () => {
    cleanKnowledgeTables()
    await service.addDocument({
      filename: '差旅报销制度.md',
      mediaType: 'text/markdown',
      data: mdBytes(SAMPLE_MD),
    })
  })

  test('中文关键词命中并返回来源与摘录', async () => {
    const hits = await service.search('住宿费标准')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.docTitle).toBe('差旅报销制度.md')
    expect(hits[0]!.snippet).toContain('住宿费')
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(200)
    expect(typeof hits[0]!.score).toBe('number')
  })

  test('英文关键词命中（多词 AND）', async () => {
    const hits = await service.search('hotel expenses')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.docTitle).toBe('差旅报销制度.md')
  })

  test('未命中返回空数组', async () => {
    const hits = await service.search('量子计算机隧穿效应')
    expect(hits).toEqual([])
  })

  test('FTS5 特殊字符/语法词不报错（防注入）', async () => {
    const hostile = [
      '"报销" OR *',
      'AND OR NOT NEAR(',
      'content:"x" }] --',
      '(((',
      '"""',
      '*^',
      '   ',
    ]
    for (const q of hostile) {
      const hits = await service.search(q)
      expect(Array.isArray(hits)).toBe(true)
    }
  })

  test('topK 限制生效', async () => {
    const hits = await service.search('报销', 1)
    expect(hits.length).toBeLessThanOrEqual(1)
  })

  test('删除文档后搜索不再命中', async () => {
    const [doc] = service.listDocs()
    expect(service.deleteDoc(doc!.id)).toBe(true)
    expect(service.listDocs()).toEqual([])
    expect(await service.search('住宿费标准')).toEqual([])
    expect(service.deleteDoc(doc!.id)).toBe(false)
  })
})

describe('knowledge MCP tool', () => {
  beforeEach(async () => {
    cleanKnowledgeTables()
    await service.addDocument({
      filename: '差旅报销制度.md',
      mediaType: 'text/markdown',
      data: mdBytes(SAMPLE_MD),
    })
  })

  test('search_knowledge 返回带 docTitle 的片段与引用提示', async () => {
    const [tool] = createKnowledgeTools()
    expect(tool!.name).toBe('mcp__knowledge__search_knowledge')
    expect(tool!.description).toContain('MUST cite the source document title')

    const result = await tool!.execute('call-1', { query: '审批流程' }, undefined as never)
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed.hits.length).toBeGreaterThan(0)
    expect(parsed.hits[0].docTitle).toBe('差旅报销制度.md')
    expect(parsed.hits[0].snippet).toContain('审批')
    expect(parsed.note).toContain('cite the source document title')
  })

  test('topK 超限被钳制到 8', async () => {
    const [tool] = createKnowledgeTools()
    const result = await tool!.execute('call-2', { query: '报销', topK: 99 }, undefined as never)
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed.hits.length).toBeLessThanOrEqual(8)
  })

  test('空知识库时给出引导提示而非报错', async () => {
    cleanKnowledgeTables()
    const [tool] = createKnowledgeTools()
    const result = await tool!.execute('call-3', { query: '任意问题' }, undefined as never)
    const parsed = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
    expect(parsed.hits).toEqual([])
    expect(parsed.note).toContain('empty')
  })

  test('缺 query 报错', async () => {
    const [tool] = createKnowledgeTools()
    await expect(tool!.execute('call-4', { query: '' } as never, undefined as never)).rejects.toThrow()
  })
})
