import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { extractDocxText } from '../../src/document/parsers/office.ts'

// golden 测试：调用构建产物 render.mjs 生成 docx，再用主仓库解析器回读断言
// 前置：先执行 bun run build:office-doc（产物必须与当次源码一致）

const SCRIPT = resolve(import.meta.dir, '../../skills/office-doc/scripts/render.mjs')
const SAMPLE_SPEC = resolve(import.meta.dir, '../../skills/office-doc/examples/doc.sample.json')

let tempDir: string

beforeAll(() => {
  if (!existsSync(SCRIPT)) {
    throw new Error(`构建产物不存在：${SCRIPT}，请先在 skills-dev 执行 bun run build:office-doc`)
  }
  tempDir = mkdtempSync(join(tmpdir(), 'office-doc-test-'))
})

afterAll(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

interface RenderResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runRender(args: string[]): RenderResult {
  const proc = Bun.spawnSync(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  }
}

function writeSpec(name: string, spec: unknown): string {
  const specPath = join(tempDir, name)
  writeFileSync(specPath, JSON.stringify(spec), 'utf8')
  return specPath
}

describe('office-doc 渲染 sample spec', () => {
  test('退出码 0、stdout 单行 ok:true、产物存在，回读含标题/章节/段落/表格内容', async () => {
    const outPath = join(tempDir, 'sample.docx')
    const result = runRender(['--spec', SAMPLE_SPEC, '--out', outPath])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.split('\n')).toHaveLength(1)

    const parsed = JSON.parse(result.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.sections).toBe(6)
    expect(isAbsolute(parsed.out)).toBe(true)
    expect(existsSync(parsed.out)).toBe(true)

    const doc = await extractDocxText(parsed.out)
    // 封面标题
    expect(doc.text).toContain('XiaoJuClaw 试运营方案')
    // 章节标题（level 1 与 level 2 各一）
    expect(doc.text).toContain('一、试运营背景与目标')
    expect(doc.text).toContain('2.1 内置技能清单')
    // 正文段落
    expect(doc.text).toContain('为验证产品在真实业务场景中的稳定性与商业价值，计划开展为期六周的试运营。')
    // bullets
    expect(doc.text).toContain('任务完成率目标：不低于 85%')
    // 表格表头与单元格
    expect(doc.text).toContain('交付形态')
    expect(doc.text).toContain('结构化 JSON 生成 Word 报告/方案')
  })
})

describe('office-doc 三种 style', () => {
  const styles = ['report', 'proposal', 'plain'] as const

  for (const style of styles) {
    test(`style=${style} 渲染成功且可回读`, async () => {
      const specPath = writeSpec(`style-${style}.json`, {
        title: `样式测试-${style}`,
        style,
        toc: true,
        author: '测试作者',
        sections: [
          {
            heading: '第一章 概述',
            level: 1,
            paragraphs: [`这是 ${style} 风格的正文段落。`],
            bullets: ['要点一', '要点二'],
            table: { headers: ['列A', '列B'], rows: [['甲', '乙']] },
          },
        ],
      })
      const outPath = join(tempDir, `style-${style}.docx`)
      const result = runRender(['--spec', specPath, '--out', outPath])

      expect(result.exitCode).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.ok).toBe(true)
      expect(parsed.sections).toBe(1)

      const doc = await extractDocxText(outPath)
      expect(doc.text).toContain(`样式测试-${style}`)
      expect(doc.text).toContain('第一章 概述')
      expect(doc.text).toContain(`这是 ${style} 风格的正文段落。`)
      expect(doc.text).toContain('甲')
    })
  }
})

describe('office-doc 非法 spec', () => {
  test('缺 title：退出码非 0，stderr 有原因，stdout ok:false', () => {
    const specPath = writeSpec('missing-title.json', {
      sections: [{ heading: '章节', paragraphs: ['内容'] }],
    })
    const result = runRender(['--spec', specPath, '--out', join(tempDir, 'missing-title.docx')])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('title')
    expect(JSON.parse(result.stdout).ok).toBe(false)
  })

  test('level=9 超界：退出码非 0，stderr 指明 level 问题', () => {
    const specPath = writeSpec('bad-level.json', {
      title: '超界测试',
      sections: [{ heading: '章节', level: 9, paragraphs: ['内容'] }],
    })
    const result = runRender(['--spec', specPath, '--out', join(tempDir, 'bad-level.docx')])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('level')
    expect(JSON.parse(result.stdout).ok).toBe(false)
  })

  test('缺 --out 参数：退出码非 0', () => {
    const result = runRender(['--spec', SAMPLE_SPEC])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--out')
  })

  test('输出文件已存在且未加 --overwrite：退出码非 0', () => {
    const outPath = join(tempDir, 'exists.docx')
    writeFileSync(outPath, 'placeholder')
    const result = runRender(['--spec', SAMPLE_SPEC, '--out', outPath])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--overwrite')
  })
})
