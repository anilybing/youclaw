/**
 * Scheduler attachment marker tests ([[attach:...]])
 *
 * Coverage:
 * - extractAttachments: no marker / single / multiple / spaces in path /
 *   case-insensitive keyword / malformed markers left untouched / blank-line cleanup
 * - validateAttachmentPaths: absolute + exists + inside agent workspace,
 *   ../ escape and outside-workspace rejection, directory rejection
 * - formatResultWithAttachmentLines: 📎 lines for desktop chat persistence
 */

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  extractAttachments,
  formatResultWithAttachmentLines,
  MAX_TASK_ATTACHMENTS,
  validateAttachmentPaths,
} from '../src/scheduler/attachments.ts'

// ===== extractAttachments =====

describe('extractAttachments', () => {
  test('text without markers is returned unchanged', () => {
    const text = '今日报告已完成。\n\n明细见正文。'
    const result = extractAttachments(text)
    expect(result.cleanText).toBe(text)
    expect(result.paths).toEqual([])
  })

  test('single marker is extracted and its line removed', () => {
    const text = '报告已生成。\n[[attach:D:\\ws\\agents\\a1\\报告.pptx]]\n请查收。'
    const result = extractAttachments(text)
    expect(result.paths).toEqual(['D:\\ws\\agents\\a1\\报告.pptx'])
    expect(result.cleanText).toBe('报告已生成。\n请查收。')
    expect(result.cleanText).not.toContain('[[attach')
  })

  test('multiple markers on separate lines are all extracted in order', () => {
    const text = [
      '产出如下：',
      '[[attach:D:\\ws\\a.pptx]]',
      '[[attach:D:\\ws\\b.xlsx]]',
      '[[attach:D:\\ws\\c.html]]',
    ].join('\n')
    const result = extractAttachments(text)
    expect(result.paths).toEqual(['D:\\ws\\a.pptx', 'D:\\ws\\b.xlsx', 'D:\\ws\\c.html'])
    expect(result.cleanText).toBe('产出如下：')
  })

  test('multiple markers on one line are all extracted', () => {
    const text = '[[attach:D:\\ws\\a.pptx]] [[attach:D:\\ws\\b.xlsx]]'
    const result = extractAttachments(text)
    expect(result.paths).toEqual(['D:\\ws\\a.pptx', 'D:\\ws\\b.xlsx'])
    expect(result.cleanText).toBe('')
  })

  test('paths containing spaces are preserved', () => {
    const text = '[[attach:D:\\my workspace\\周报 2026-07.xlsx]]'
    const result = extractAttachments(text)
    expect(result.paths).toEqual(['D:\\my workspace\\周报 2026-07.xlsx'])
  })

  test('marker keyword is case-insensitive', () => {
    const text = '[[ATTACH:D:\\ws\\a.pptx]]\n[[Attach:D:\\ws\\b.xlsx]]'
    const result = extractAttachments(text)
    expect(result.paths).toEqual(['D:\\ws\\a.pptx', 'D:\\ws\\b.xlsx'])
    expect(result.cleanText).toBe('')
  })

  test('surrounding whitespace in the path is trimmed', () => {
    const result = extractAttachments('[[attach:  D:\\ws\\a.pptx  ]]')
    expect(result.paths).toEqual(['D:\\ws\\a.pptx'])
  })

  test('marker line embedded in text keeps surrounding content', () => {
    const text = '前文 [[attach:D:\\ws\\a.pptx]] 后文'
    const result = extractAttachments(text)
    expect(result.paths).toEqual(['D:\\ws\\a.pptx'])
    expect(result.cleanText).toContain('前文')
    expect(result.cleanText).toContain('后文')
  })

  test('removing marker lines does not leave excessive blank lines', () => {
    const text = '第一段。\n\n[[attach:D:\\ws\\a.pptx]]\n\n第二段。'
    const result = extractAttachments(text)
    expect(result.cleanText).not.toMatch(/\n{3,}/)
    expect(result.cleanText).toContain('第一段。')
    expect(result.cleanText).toContain('第二段。')
  })

  test('malformed markers are left untouched', () => {
    const cases = [
      '[[attach:]]',                    // 空路径
      '[attach:D:\\ws\\a.pptx]',        // 单层括号
      '[[attach:D:\\ws\\a.pptx',        // 未闭合
      '[[attachment:D:\\ws\\a.pptx]]',  // 关键字不符
      '[[attach D:\\ws\\a.pptx]]',      // 缺少冒号
    ]
    for (const text of cases) {
      const result = extractAttachments(text)
      expect(result.paths).toEqual([])
      expect(result.cleanText).toBe(text)
    }
  })

  test('marker spanning two lines is not matched', () => {
    const text = '[[attach:D:\\ws\\a\n.pptx]]'
    const result = extractAttachments(text)
    expect(result.paths).toEqual([])
    expect(result.cleanText).toBe(text)
  })

  test('exported attachment limit constant is 5', () => {
    expect(MAX_TASK_ATTACHMENTS).toBe(5)
  })
})

// ===== validateAttachmentPaths =====

describe('validateAttachmentPaths', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'XiaoJuClaw-att-test-'))
  const workspaceDir = resolve(baseDir, 'agents', 'agent-1')
  const insideFile = resolve(workspaceDir, '办公产出', '报告 v1.pptx')
  const outsideFile = resolve(baseDir, 'outside.txt')

  mkdirSync(resolve(workspaceDir, '办公产出'), { recursive: true })
  writeFileSync(insideFile, 'inside')
  writeFileSync(outsideFile, 'outside')

  afterAll(() => rmSync(baseDir, { recursive: true, force: true }))

  test('accepts an existing file inside the agent workspace', () => {
    const result = validateAttachmentPaths([insideFile], workspaceDir)
    expect(result.accepted).toEqual([insideFile])
    expect(result.rejected).toEqual([])
  })

  test('rejects relative paths', () => {
    const result = validateAttachmentPaths(['办公产出/报告 v1.pptx'], workspaceDir)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toBe('not an absolute path')
  })

  test('rejects nonexistent files', () => {
    const result = validateAttachmentPaths([resolve(workspaceDir, 'missing.pptx')], workspaceDir)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toBe('file not found')
  })

  test('rejects files outside the workspace', () => {
    const result = validateAttachmentPaths([outsideFile], workspaceDir)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toBe('outside the agent workspace')
  })

  test('rejects ../ escape that resolves outside the workspace', () => {
    const escapePath = resolve(workspaceDir, '..', '..', 'outside.txt')
    // 双重确认：这个构造路径真实存在，逃逸只能被前缀比对拦下
    const result = validateAttachmentPaths([escapePath], workspaceDir)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toBe('outside the agent workspace')
  })

  test('rejects directories', () => {
    const result = validateAttachmentPaths([resolve(workspaceDir, '办公产出')], workspaceDir)
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toBe('not a regular file')
  })

  test('rejects everything when the workspace directory itself does not exist', () => {
    const result = validateAttachmentPaths([insideFile], resolve(baseDir, 'agents', 'no-such-agent'))
    expect(result.accepted).toEqual([])
    expect(result.rejected[0]?.reason).toBe('agent workspace directory not found')
  })

  test('workspace prefix comparison is case-insensitive on Windows', () => {
    if (process.platform !== 'win32') return
    const upperCased = insideFile.toUpperCase()
    const result = validateAttachmentPaths([upperCased], workspaceDir)
    expect(result.accepted).toEqual([upperCased])
  })

  test('mixed valid and invalid paths are split correctly', () => {
    const missing = resolve(workspaceDir, 'nope.xlsx')
    const result = validateAttachmentPaths([insideFile, missing, outsideFile], workspaceDir)
    expect(result.accepted).toEqual([insideFile])
    expect(result.rejected.map((r) => r.path)).toEqual([missing, outsideFile])
  })
})

// ===== formatResultWithAttachmentLines =====

describe('formatResultWithAttachmentLines', () => {
  test('returns cleanText unchanged when there are no attachments', () => {
    expect(formatResultWithAttachmentLines('正文', [])).toBe('正文')
  })

  test('appends one 📎 line per attachment', () => {
    const out = formatResultWithAttachmentLines('正文', ['D:\\ws\\a.pptx', 'D:\\ws\\b.xlsx'])
    expect(out).toBe('正文\n\n📎 D:\\ws\\a.pptx\n📎 D:\\ws\\b.xlsx')
  })

  test('returns only 📎 lines when cleanText is empty', () => {
    expect(formatResultWithAttachmentLines('', ['D:\\ws\\a.pptx'])).toBe('📎 D:\\ws\\a.pptx')
  })
})
