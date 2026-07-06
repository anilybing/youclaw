import { describe, expect, test } from 'bun:test'

// 冒烟测试：确认四个办公文档依赖可导入、主仓库解析器可从 skills-dev 解析

describe('office 依赖可导入', () => {
  test('pptxgenjs', async () => {
    const mod = await import('pptxgenjs')
    expect(mod.default).toBeDefined()
  })

  test('docx', async () => {
    const mod = await import('docx')
    expect(mod.Document).toBeDefined()
    expect(mod.Packer).toBeDefined()
  })

  test('exceljs', async () => {
    const mod = await import('exceljs')
    const ExcelJS = mod.default ?? mod
    expect(ExcelJS.Workbook).toBeDefined()
  })

  test('pdf-lib', async () => {
    const mod = await import('pdf-lib')
    expect(mod.PDFDocument).toBeDefined()
  })
})

describe('主仓库解析器可导入（golden 测试回读用）', () => {
  test('src/document/parsers/office.ts', async () => {
    const parsers = await import('../../src/document/parsers/office.ts')
    expect(typeof parsers.extractPptxText).toBe('function')
    expect(typeof parsers.extractDocxText).toBe('function')
    expect(typeof parsers.extractXlsxText).toBe('function')
  })
})
