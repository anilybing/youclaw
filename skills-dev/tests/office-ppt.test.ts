import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractPptxText } from '../../src/document/parsers/office.ts'

// golden 测试：直接跑构建产物 render.mjs（bun run build:office-ppt 的输出），
// 渲染 -> 回读 -> 断言，覆盖三主题与非法 spec

const SKILL_DIR = resolve(import.meta.dir, '../../skills/office-ppt')
const RENDER_MJS = join(SKILL_DIR, 'scripts/render.mjs')
const SAMPLE_SPEC = join(SKILL_DIR, 'examples/deck.sample.json')

const workDir = mkdtempSync(join(tmpdir(), 'office-ppt-test-'))

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

function runRender(args: string[]): RunResult {
  const proc = Bun.spawnSync(['bun', RENDER_MJS, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString('utf8').trim(),
    stderr: proc.stderr.toString('utf8').trim(),
  }
}

describe('office-ppt render.mjs（构建产物）', () => {
  test(
    '渲染示例 deck.sample.json：退出码 0、ok:true、slides>=9',
    async () => {
      const out = join(workDir, 'sample.pptx')
      const result = runRender(['--spec', SAMPLE_SPEC, '--out', out])

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout) as { ok: boolean; out: string; slides: number }
      expect(payload.ok).toBe(true)
      expect(payload.slides).toBeGreaterThanOrEqual(9)
      expect(payload.out).toBe(out)
      expect(existsSync(out)).toBe(true)

      // 主仓库解析器回读：页数与关键文本
      const parsed = await extractPptxText(out)
      expect(parsed.slideCount ?? 0).toBeGreaterThanOrEqual(9)
      expect(parsed.text).toContain('XiaoJuClaw 产品介绍')
      expect(parsed.text).toContain('内置办公技能：一句话生成 PPT、Word、Excel、PDF')
      // 表格页与目录也应有文本
      expect(parsed.text).toContain('订阅价格')
      expect(parsed.text).toContain('专业版')
    },
    30000,
  )

  test(
    '三个主题各渲染一次均成功',
    () => {
      for (const theme of ['business', 'minimal', 'orange']) {
        const out = join(workDir, `sample-${theme}.pptx`)
        const result = runRender(['--spec', SAMPLE_SPEC, '--out', out, '--theme', theme])
        expect(result.exitCode).toBe(0)
        const payload = JSON.parse(result.stdout) as { ok: boolean; slides: number }
        expect(payload.ok).toBe(true)
        expect(payload.slides).toBeGreaterThanOrEqual(9)
        expect(existsSync(out)).toBe(true)
      }
    },
    60000,
  )

  test(
    '非法 spec：缺 title 退出码非 0 且报错可读',
    () => {
      const spec = join(workDir, 'bad-no-title.json')
      writeFileSync(spec, JSON.stringify({ slides: [{ type: 'content', title: 'x', bullets: ['y'] }] }))
      const result = runRender(['--spec', spec, '--out', join(workDir, 'bad1.pptx')])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('title')
    },
    30000,
  )

  test(
    '非法 spec：未知 type 退出码非 0 且报错可读',
    () => {
      const spec = join(workDir, 'bad-unknown-type.json')
      writeFileSync(spec, JSON.stringify({ title: '测试', slides: [{ type: 'pie-chart', title: 'x' }] }))
      const result = runRender(['--spec', spec, '--out', join(workDir, 'bad2.pptx')])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('未知版式')
    },
    30000,
  )

  test(
    '输出文件已存在且未加 --overwrite 时报错',
    () => {
      const out = join(workDir, 'exists.pptx')
      writeFileSync(out, 'placeholder')
      const result = runRender(['--spec', SAMPLE_SPEC, '--out', out])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('已存在')

      const retry = runRender(['--spec', SAMPLE_SPEC, '--out', out, '--overwrite'])
      expect(retry.exitCode).toBe(0)
    },
    30000,
  )
})
