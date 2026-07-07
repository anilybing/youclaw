import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import ExcelJS from 'exceljs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// office-excel golden 测试：动态生成样例 xlsx/csv -> 以子进程跑真实 CLI -> exceljs 回读断言
// 契约：成功 stdout 单行 JSON {ok,out,mode,rows} 退出码 0；失败 stderr + 退出码 1

const CLI = path.resolve(import.meta.dir, '../src/office-excel/cli.ts')

let tmpDir: string
let inputXlsx: string
let inputCsv: string

// 样例数据：地区两组（华东 7 行 / 华北 5 行），销量 sum 华东=280、华北=125
const HEADER = ['地区', '销量', '单价'] as const
const ROWS: Array<[string, number, number]> = [
  ['华东', 10, 3.5],
  ['华东', 20, 4.0],
  ['华东', 30, 2.5],
  ['华东', 40, 5.0],
  ['华东', 50, 6.5],
  ['华东', 60, 7.0],
  ['华东', 70, 8.5],
  ['华北', 5, 3.0],
  ['华北', 15, 4.5],
  ['华北', 25, 5.5],
  ['华北', 35, 6.0],
  ['华北', 45, 7.5],
]
const SUM_EAST = 280
const SUM_NORTH = 125
const EAST_COUNT = 7
const NORTH_COUNT = 5

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

function runCli(args: string[]): CliResult {
  const proc = Bun.spawnSync(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = proc.stdout.toString('utf8').trim()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(stdout)
  } catch {
    json = null
  }
  return { exitCode: proc.exitCode, stdout, stderr: proc.stderr.toString('utf8'), json }
}

function writeConfig(name: string, cfg: unknown): string {
  const p = path.join(tmpDir, name)
  writeFileSync(p, JSON.stringify(cfg), 'utf8')
  return p
}

async function readWorkbook(file: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  return wb
}

/** 读一个 sheet 为 {header, rows(字符串化)} 便于断言 */
function sheetTable(ws: ExcelJS.Worksheet): { header: string[]; rows: Array<Array<string | number | null>> } {
  const header: string[] = []
  for (let c = 1; c <= ws.columnCount; c++) header.push(String(ws.getRow(1).getCell(c).value ?? ''))
  const rows: Array<Array<string | number | null>> = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row: Array<string | number | null> = []
    for (let c = 1; c <= header.length; c++) {
      const v = ws.getRow(r).getCell(c).value
      row.push(v === null || v === undefined ? null : typeof v === 'number' ? v : String(v))
    }
    if (row.some((v) => v !== null && v !== '')) rows.push(row)
  }
  return { header, rows }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'office-excel-test-'))
  inputXlsx = path.join(tmpDir, 'input.xlsx')
  inputCsv = path.join(tmpDir, 'input.csv')

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.addRow([...HEADER])
  for (const r of ROWS) ws.addRow(r)
  await wb.xlsx.writeFile(inputXlsx)

  // CSV 带 UTF-8 BOM，验证 BOM 处理
  const csvLines = [HEADER.join(','), ...ROWS.map((r) => r.join(','))].join('\r\n')
  writeFileSync(inputCsv, '\ufeff' + csvLines, 'utf8')
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('office-excel CLI', () => {
  test('summarize：统计 sheet 存在且销量 sum 正确', async () => {
    const out = path.join(tmpDir, 'out-summarize.xlsx')
    const res = runCli(['--mode', 'summarize', '--input', inputXlsx, '--out', out])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, out, mode: 'summarize', rows: ROWS.length })

    const wb = await readWorkbook(out)
    const stat = wb.getWorksheet('Sheet1_统计')
    expect(stat).toBeDefined()
    const { header, rows } = sheetTable(stat!)
    expect(header).toEqual(['列名', '类型', '非空数', '唯一值数', 'sum', 'avg', 'min', 'max'])
    const byCol = new Map(rows.map((r) => [r[0], r]))
    const sales = byCol.get('销量')
    expect(sales).toBeDefined()
    expect(sales![1]).toBe('数值')
    expect(sales![2]).toBe(ROWS.length) // 非空数
    expect(sales![4]).toBe(SUM_EAST + SUM_NORTH) // sum
    expect(sales![6]).toBe(5) // min
    expect(sales![7]).toBe(70) // max
    const region = byCol.get('地区')
    expect(region![1]).toBe('文本')
    expect(region![3]).toBe(2) // 唯一值数
  })

  test('filter：地区 eq 华东 命中 7 行且保留表头', async () => {
    const out = path.join(tmpDir, 'out-filter.xlsx')
    const cfg = writeConfig('filter.json', { where: [{ column: '地区', op: 'eq', value: '华东' }] })
    const res = runCli(['--mode', 'filter', '--input', inputXlsx, '--out', out, '--config', cfg])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'filter', rows: EAST_COUNT })

    const wb = await readWorkbook(out)
    const { header, rows } = sheetTable(wb.worksheets[0])
    expect(header).toEqual([...HEADER])
    expect(rows.length).toBe(EAST_COUNT)
    expect(rows.every((r) => r[0] === '华东')).toBe(true)
  })

  test('pivot：按地区 sum 销量，两组值正确', async () => {
    const out = path.join(tmpDir, 'out-pivot.xlsx')
    const cfg = writeConfig('pivot.json', { rowField: '地区', valueField: '销量', agg: 'sum' })
    const res = runCli(['--mode', 'pivot', '--input', inputXlsx, '--out', out, '--config', cfg])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'pivot', rows: 2 })

    const wb = await readWorkbook(out)
    const { header, rows } = sheetTable(wb.worksheets[0])
    expect(header).toEqual(['地区', 'sum(销量)'])
    const map = new Map(rows.map((r) => [r[0], r[1]]))
    expect(map.get('华东')).toBe(SUM_EAST)
    expect(map.get('华北')).toBe(SUM_NORTH)
  })

  test('split：按地区拆分，sheet 数=地区数且行数守恒', async () => {
    const out = path.join(tmpDir, 'out-split.xlsx')
    const cfg = writeConfig('split.json', { byColumn: '地区' })
    const res = runCli(['--mode', 'split', '--input', inputXlsx, '--out', out, '--config', cfg])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'split', rows: ROWS.length })

    const wb = await readWorkbook(out)
    expect(wb.worksheets.length).toBe(2)
    const names = wb.worksheets.map((w) => w.name).sort()
    expect(names).toEqual(['华东', '华北'].sort())
    const east = sheetTable(wb.getWorksheet('华东')!)
    const north = sheetTable(wb.getWorksheet('华北')!)
    expect(east.header).toEqual([...HEADER])
    expect(east.rows.length).toBe(EAST_COUNT)
    expect(north.rows.length).toBe(NORTH_COUNT)
    expect(east.rows.length + north.rows.length).toBe(ROWS.length) // 行数守恒
  })

  test('csv 输入（带 BOM）：summarize 成功且统计正确', async () => {
    const out = path.join(tmpDir, 'out-csv.xlsx')
    const res = runCli(['--mode', 'summarize', '--input', inputCsv, '--out', out])
    expect(res.stderr).toBe('')
    expect(res.exitCode).toBe(0)
    expect(res.json).toMatchObject({ ok: true, mode: 'summarize', rows: ROWS.length })

    const wb = await readWorkbook(out)
    const stat = wb.getWorksheet('input_统计')
    expect(stat).toBeDefined()
    const { rows } = sheetTable(stat!)
    const sales = rows.find((r) => r[0] === '销量')
    expect(sales![4]).toBe(SUM_EAST + SUM_NORTH) // BOM 处理正确才能读出数值列
    const region = rows.find((r) => r[0] === '地区')
    expect(region![2]).toBe(ROWS.length)
  })

  test('缺列名：报可读错误且退出码 1', () => {
    const out = path.join(tmpDir, 'out-badcol.xlsx')
    const cfg = writeConfig('badcol.json', { where: [{ column: '不存在的列', op: 'eq', value: 'x' }] })
    const res = runCli(['--mode', 'filter', '--input', inputXlsx, '--out', out, '--config', cfg])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('不存在的列')
    expect(res.stderr).toContain('可用列')
    expect(res.json).toMatchObject({ ok: false })
  })

  test('输出文件已存在：默认报错，--overwrite 才覆盖', async () => {
    const out = path.join(tmpDir, 'out-exists.xlsx')
    const first = runCli(['--mode', 'summarize', '--input', inputXlsx, '--out', out])
    expect(first.exitCode).toBe(0)
    const second = runCli(['--mode', 'summarize', '--input', inputXlsx, '--out', out])
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain('--overwrite')
    const third = runCli(['--mode', 'summarize', '--input', inputXlsx, '--out', out, '--overwrite'])
    expect(third.exitCode).toBe(0)
  })

  test('参数缺失/mode 无效：退出码 1', () => {
    const missing = runCli(['--mode', 'summarize'])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('--input')
    const badMode = runCli(['--mode', 'explode', '--input', inputXlsx, '--out', path.join(tmpDir, 'x.xlsx')])
    expect(badMode.exitCode).toBe(1)
    expect(badMode.stderr).toContain('summarize|filter|pivot|split')
  })
})
