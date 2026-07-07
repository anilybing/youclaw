import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'

// office-pdf golden 测试：动态生成样例 PDF -> 以子进程跑 CLI -> pdf-lib 回读断言
// 临时产物写系统临时目录，测试结束清理（规范第 7 节）

const CLI = path.resolve(import.meta.dir, '../src/office-pdf/cli.ts')

let workDir: string
let pdfA3: string // 3 页样例
let pdfB2: string // 2 页样例

interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
}

function runCli(args: string[]): CliRun {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  }
}

async function createSamplePdf(filePath: string, pageCount: number, label: string): Promise<void> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([595, 842]) // A4 竖版
    page.drawText(`${label} - page ${i} of ${pageCount}`, { x: 60, y: 760, size: 18, font })
    page.drawText('sample content for office-pdf golden test', { x: 60, y: 720, size: 12, font })
  }
  fs.writeFileSync(filePath, await doc.save())
}

async function readPageCount(filePath: string): Promise<number> {
  const doc = await PDFDocument.load(fs.readFileSync(filePath))
  return doc.getPageCount()
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pdf-test-'))
  pdfA3 = path.join(workDir, 'a3.pdf')
  pdfB2 = path.join(workDir, 'b2.pdf')
  await createSamplePdf(pdfA3, 3, 'Doc A')
  await createSamplePdf(pdfB2, 2, 'Doc B')
})

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('office-pdf merge', () => {
  test('两个输入按顺序合并，回读页数 3+2=5', async () => {
    const out = path.join(workDir, 'merged.pdf')
    const run = runCli(['--mode', 'merge', '--input', `${pdfA3},${pdfB2}`, '--out', out])
    expect(run.exitCode).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.ok).toBe(true)
    expect(result.pages).toBe(5)
    expect(path.isAbsolute(result.out)).toBe(true)
    expect(await readPageCount(out)).toBe(5)
  })

  test('只给 1 个输入 => 退出码 1 且不产出文件', () => {
    const out = path.join(workDir, 'merge-single.pdf')
    const run = runCli(['--mode', 'merge', '--input', pdfA3, '--out', out])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('至少需要 2 个输入文件')
    expect(fs.existsSync(out)).toBe(false)
  })

  test('--out 与输入文件相同 => 退出码 1（不覆盖原文件红线）', () => {
    const run = runCli(['--mode', 'merge', '--input', `${pdfA3},${pdfB2}`, '--out', pdfA3])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('不能与输入文件相同')
  })
})

describe('office-pdf split', () => {
  test('--pages 1-2 => 输出 2 页', async () => {
    const out = path.join(workDir, 'split-1-2.pdf')
    const run = runCli(['--mode', 'split', '--input', pdfA3, '--pages', '1-2', '--out', out])
    expect(run.exitCode).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.ok).toBe(true)
    expect(result.pages).toBe(2)
    expect(await readPageCount(out)).toBe(2)
  })

  test('--pages 9 越界 => 退出码 1 且报可读错误', () => {
    const out = path.join(workDir, 'split-oob.pdf')
    const run = runCli(['--mode', 'split', '--input', pdfA3, '--pages', '9', '--out', out])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('超出范围')
    expect(run.stderr).toContain('共 3 页')
    expect(fs.existsSync(out)).toBe(false)
  })
})

describe('office-pdf watermark', () => {
  test('英文水印成功：页数不变、文件大于原文件', async () => {
    const out = path.join(workDir, 'marked.pdf')
    const run = runCli(['--mode', 'watermark', '--input', pdfA3, '--text', 'CONFIDENTIAL', '--out', out])
    expect(run.exitCode).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.ok).toBe(true)
    expect(result.pages).toBe(3)
    expect(await readPageCount(out)).toBe(3)
    expect(fs.statSync(out).size).toBeGreaterThan(fs.statSync(pdfA3).size)
  })

  test('中文水印 => 退出码 1，报错提示改用英文/数字', () => {
    const out = path.join(workDir, 'marked-cjk.pdf')
    const run = runCli(['--mode', 'watermark', '--input', pdfA3, '--text', '机密', '--out', out])
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('不支持的字符')
    expect(run.stderr).toContain('英文或数字')
    expect(fs.existsSync(out)).toBe(false)
  })
})
