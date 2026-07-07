// office-excel 技能核心逻辑：读取 .xlsx/.csv，按 mode（summarize|filter|pivot|split）处理，写出 .xlsx。
// 契约与红线见 doc/技能包开发规范.md：零网络、零交互、错误信息人类可读、列名大小写敏感。

import ExcelJS from 'exceljs'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type CellValue = string | number | boolean | Date | null

export interface SheetData {
  name: string
  header: string[]
  /** 数据行（不含表头），每行与 header 等长对齐 */
  rows: CellValue[][]
}

export const MODES = ['summarize', 'filter', 'pivot', 'split'] as const
export type Mode = (typeof MODES)[number]

const WHERE_OPS = ['eq', 'ne', 'gt', 'lt', 'contains'] as const
export type WhereOp = (typeof WHERE_OPS)[number]

const AGGS = ['sum', 'count', 'avg'] as const
export type Agg = (typeof AGGS)[number]

export interface WhereCond {
  column: string
  op: WhereOp
  value: unknown
}

export interface FilterConfig {
  sheet?: string
  where: WhereCond[]
}

export interface PivotConfig {
  sheet?: string
  rowField: string
  valueField: string
  agg: Agg
}

export interface SplitConfig {
  sheet?: string
  byColumn: string
}

/** 预期内的调用方错误：CLI 只输出 message，不打印堆栈 */
export class UserError extends Error {}

export interface RunOptions {
  mode: Mode
  /** 输入文件绝对路径（.xlsx 或 .csv） */
  input: string
  /** 输出文件绝对路径（.xlsx） */
  out: string
  /** --config 文件解析后的 JSON（summarize 模式可省略） */
  configRaw?: unknown
}

export interface RunResult {
  out: string
  mode: Mode
  /** summarize=输入数据行总数；filter=命中行数；pivot=分组数；split=写出数据行总数 */
  rows: number
}

export async function runExcel(opts: RunOptions): Promise<RunResult> {
  const sheets = await readInput(opts.input)
  let result: { outSheets: SheetData[]; rows: number }
  switch (opts.mode) {
    case 'summarize':
      result = summarizeSheets(sheets)
      break
    case 'filter': {
      const cfg = parseFilterConfig(requireConfig(opts))
      result = filterSheet(pickSheet(sheets, cfg.sheet), cfg)
      break
    }
    case 'pivot': {
      const cfg = parsePivotConfig(requireConfig(opts))
      result = pivotSheet(pickSheet(sheets, cfg.sheet), cfg)
      break
    }
    case 'split': {
      const cfg = parseSplitConfig(requireConfig(opts))
      result = splitSheet(pickSheet(sheets, cfg.sheet), cfg)
      break
    }
  }
  await writeWorkbook(opts.out, result.outSheets)
  return { out: opts.out, mode: opts.mode, rows: result.rows }
}

// ---------- config 校验 ----------

function requireConfig(opts: RunOptions): unknown {
  if (opts.configRaw === undefined) {
    throw new UserError(`模式 ${opts.mode} 需要 --config 指定配置 JSON 文件`)
  }
  return opts.configRaw
}

function asConfigObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UserError('config 必须是 JSON 对象')
  }
  return raw as Record<string, unknown>
}

function optionalSheet(obj: Record<string, unknown>): string | undefined {
  if (obj.sheet === undefined) return undefined
  if (typeof obj.sheet !== 'string' || obj.sheet === '') {
    throw new UserError('config.sheet 必须是非空字符串（省略则默认第一个工作表）')
  }
  return obj.sheet
}

function requiredString(obj: Record<string, unknown>, key: string, mode: Mode): string {
  const v = obj[key]
  if (typeof v !== 'string' || v === '') {
    throw new UserError(`config.${key} 必须是非空字符串（${mode} 模式必填）`)
  }
  return v
}

export function parseFilterConfig(raw: unknown): FilterConfig {
  const obj = asConfigObject(raw)
  const where = obj.where
  if (!Array.isArray(where) || where.length === 0) {
    throw new UserError('config.where 必须是非空数组，例如 [{"column":"地区","op":"eq","value":"华东"}]')
  }
  const conds = where.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new UserError(`config.where[${i}] 必须是对象 {column, op, value}`)
    }
    const it = item as Record<string, unknown>
    if (typeof it.column !== 'string' || it.column === '') {
      throw new UserError(`config.where[${i}].column 必须是非空字符串`)
    }
    if (typeof it.op !== 'string' || !(WHERE_OPS as readonly string[]).includes(it.op)) {
      throw new UserError(`config.where[${i}].op 无效（"${String(it.op)}"），可选值: ${WHERE_OPS.join('|')}`)
    }
    if (!('value' in it)) {
      throw new UserError(`config.where[${i}] 缺少 value 字段`)
    }
    return { column: it.column, op: it.op as WhereOp, value: it.value }
  })
  return { sheet: optionalSheet(obj), where: conds }
}

export function parsePivotConfig(raw: unknown): PivotConfig {
  const obj = asConfigObject(raw)
  const rowField = requiredString(obj, 'rowField', 'pivot')
  const valueField = requiredString(obj, 'valueField', 'pivot')
  if (typeof obj.agg !== 'string' || !(AGGS as readonly string[]).includes(obj.agg)) {
    throw new UserError(`config.agg 无效（"${String(obj.agg)}"），可选值: ${AGGS.join('|')}`)
  }
  return { sheet: optionalSheet(obj), rowField, valueField, agg: obj.agg as Agg }
}

export function parseSplitConfig(raw: unknown): SplitConfig {
  const obj = asConfigObject(raw)
  return { sheet: optionalSheet(obj), byColumn: requiredString(obj, 'byColumn', 'split') }
}

// ---------- 读取 ----------

export async function readInput(inputPath: string): Promise<SheetData[]> {
  const ext = path.extname(inputPath).toLowerCase()
  if (ext === '.xlsx') return readXlsx(inputPath)
  if (ext === '.csv') return [readCsv(inputPath)]
  throw new UserError(`不支持的输入格式 "${ext || '(无扩展名)'}"，仅支持 .xlsx 与 .csv`)
}

async function readXlsx(file: string): Promise<SheetData[]> {
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.readFile(file)
  } catch (err) {
    throw new UserError(`读取 xlsx 失败（文件损坏或不是有效的 .xlsx）: ${err instanceof Error ? err.message : String(err)}`)
  }
  const sheets: SheetData[] = []
  wb.eachSheet((ws) => {
    const headerRow = ws.getRow(1)
    const header: string[] = []
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = normalizeCell(headerRow.getCell(c).value)
      header.push(v === null ? '' : cellToString(v))
    }
    while (header.length > 0 && header[header.length - 1].trim() === '') header.pop()
    const rows: CellValue[][] = []
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const vals: CellValue[] = []
      let hasAny = false
      for (let c = 1; c <= header.length; c++) {
        const v = normalizeCell(row.getCell(c).value)
        if (v !== null && v !== '') hasAny = true
        vals.push(v)
      }
      if (hasAny) rows.push(vals)
    }
    sheets.push({ name: ws.name, header, rows })
  })
  if (sheets.length === 0) throw new UserError('输入文件不包含任何工作表')
  return sheets
}

function readCsv(file: string): SheetData {
  let text = readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // UTF-8 BOM
  const records = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''))
  if (records.length === 0) throw new UserError('CSV 文件为空（没有表头行）')
  const header = records[0].map((h) => h.trim())
  while (header.length > 0 && header[header.length - 1] === '') header.pop()
  if (header.length === 0) throw new UserError('CSV 表头行为空')
  const rows = records.slice(1).map((r) => header.map((_, i) => coerceCsvCell(r[i] ?? '')))
  const name = path.basename(file, path.extname(file)) || 'Sheet1'
  return { name, header, rows }
}

/** 简单 CSV 解析：支持引号包裹（"" 转义）、逗号、\n 与 \r\n 行尾 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function coerceCsvCell(raw: string): CellValue {
  if (raw === '') return null
  const t = raw.trim()
  if (t !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  return raw
}

/** 把 exceljs 的富单元格值（公式/富文本/超链接等）归一化为标量 */
function normalizeCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>
    if (Array.isArray(obj.richText)) {
      return (obj.richText as Array<{ text?: unknown }>).map((r) => String(r.text ?? '')).join('')
    }
    if ('formula' in obj || 'sharedFormula' in obj) return normalizeCell(obj.result)
    if ('hyperlink' in obj) return normalizeCell(obj.text)
    if ('error' in obj) return null
    if ('text' in obj) return normalizeCell(obj.text)
    return String(v)
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
}

// ---------- 工作表/列定位 ----------

export function pickSheet(sheets: SheetData[], name?: string): SheetData {
  if (name === undefined) return sheets[0]
  const found = sheets.find((s) => s.name === name)
  if (!found) {
    throw new UserError(`找不到工作表 "${name}"；可用工作表: ${sheets.map((s) => s.name).join(', ')}`)
  }
  return found
}

export function colIndex(sheet: SheetData, column: string): number {
  if (sheet.header.length === 0) {
    throw new UserError(`工作表 "${sheet.name}" 没有表头行，无法按列名定位`)
  }
  const idx = sheet.header.indexOf(column)
  if (idx === -1) {
    throw new UserError(
      `在工作表 "${sheet.name}" 中找不到列 "${column}"（列名匹配大小写敏感）；可用列: ${sheet.header.join(', ')}`,
    )
  }
  return idx
}

// ---------- 四种模式 ----------

const STAT_HEADER = ['列名', '类型', '非空数', '唯一值数', 'sum', 'avg', 'min', 'max']

export function summarizeSheets(sheets: SheetData[]): { outSheets: SheetData[]; rows: number } {
  const outSheets: SheetData[] = []
  let total = 0
  for (const s of sheets) {
    total += s.rows.length
    const statRows: CellValue[][] = s.header.map((col, i) => {
      const values = s.rows
        .map((r) => r[i])
        .filter((v): v is Exclude<CellValue, null> => v !== null && v !== '')
      const nonEmpty = values.length
      const uniq = new Set(values.map((v) => cellToString(v))).size
      const numbers = values.filter((v): v is number => typeof v === 'number')
      const isNumeric = nonEmpty > 0 && numbers.length === nonEmpty
      if (isNumeric) {
        const sum = numbers.reduce((a, b) => a + b, 0)
        return [col, '数值', nonEmpty, uniq, sum, sum / numbers.length, Math.min(...numbers), Math.max(...numbers)]
      }
      return [col, nonEmpty === 0 ? '空' : '文本', nonEmpty, uniq, null, null, null, null]
    })
    outSheets.push({ name: withSuffix(s.name, '_统计'), header: STAT_HEADER, rows: statRows })
  }
  return { outSheets, rows: total }
}

export function filterSheet(sheet: SheetData, cfg: FilterConfig): { outSheets: SheetData[]; rows: number } {
  const conds = cfg.where.map((w) => ({ idx: colIndex(sheet, w.column), op: w.op, value: w.value }))
  const matched = sheet.rows.filter((row) => conds.every((c) => evalCond(row[c.idx], c.op, c.value)))
  return {
    outSheets: [{ name: sheet.name, header: sheet.header, rows: matched }],
    rows: matched.length,
  }
}

export function pivotSheet(sheet: SheetData, cfg: PivotConfig): { outSheets: SheetData[]; rows: number } {
  const rIdx = colIndex(sheet, cfg.rowField)
  const vIdx = colIndex(sheet, cfg.valueField)
  const groups = new Map<string, { sum: number; numCount: number; nonEmpty: number }>()
  for (const row of sheet.rows) {
    const key = groupKey(row[rIdx])
    let g = groups.get(key)
    if (!g) {
      g = { sum: 0, numCount: 0, nonEmpty: 0 }
      groups.set(key, g)
    }
    const v = row[vIdx]
    if (v !== null && v !== '') g.nonEmpty++
    if (typeof v === 'number') {
      g.sum += v
      g.numCount++
    }
  }
  const rows: CellValue[][] = [...groups.entries()].map(([key, g]) => {
    const val =
      cfg.agg === 'count' ? g.nonEmpty : cfg.agg === 'sum' ? g.sum : g.numCount > 0 ? g.sum / g.numCount : null
    return [key, val]
  })
  return {
    outSheets: [{ name: withSuffix(sheet.name, '_透视'), header: [cfg.rowField, `${cfg.agg}(${cfg.valueField})`], rows }],
    rows: rows.length,
  }
}

export function splitSheet(sheet: SheetData, cfg: SplitConfig): { outSheets: SheetData[]; rows: number } {
  const idx = colIndex(sheet, cfg.byColumn)
  if (sheet.rows.length === 0) {
    throw new UserError(`工作表 "${sheet.name}" 没有数据行，无法拆分`)
  }
  const groups = new Map<string, CellValue[][]>()
  for (const row of sheet.rows) {
    const key = groupKey(row[idx])
    let g = groups.get(key)
    if (!g) {
      g = []
      groups.set(key, g)
    }
    g.push(row)
  }
  const outSheets = [...groups.entries()].map(([key, rows]) => ({ name: key, header: sheet.header, rows }))
  return { outSheets, rows: sheet.rows.length }
}

function groupKey(v: CellValue): string {
  const s = cellToString(v)
  return s === '' ? '(空)' : s
}

function evalCond(cell: CellValue, op: WhereOp, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return isEqual(cell, value)
    case 'ne':
      return !isEqual(cell, value)
    case 'gt':
    case 'lt': {
      const a = toNumber(cell)
      const b = toNumber(value)
      if (a === null || b === null) return false
      return op === 'gt' ? a > b : a < b
    }
    case 'contains':
      return cellToString(cell).includes(String(value ?? ''))
  }
}

function isEqual(cell: CellValue, value: unknown): boolean {
  if (typeof cell === 'number') {
    const n = toNumber(value)
    if (n !== null) return cell === n
  }
  return cellToString(cell) === String(value ?? '')
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function cellToString(v: CellValue): string {
  if (v === null) return ''
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

// ---------- 写出 ----------

/** Excel 工作表名：替换非法字符 : \ / ? * [ ]，去首尾单引号，截断 31 字符 */
export function sanitizeSheetName(raw: string): string {
  let n = raw.replace(/[:\\/?*[\]]/g, '_').replace(/^'+|'+$/g, '')
  if (n.trim() === '') n = '_'
  if (n.length > 31) n = n.slice(0, 31)
  return n
}

/** 追加后缀并保证总长 ≤31（必要时截断 base，保留后缀） */
function withSuffix(base: string, suffix: string): string {
  const maxBase = 31 - suffix.length
  const b = base.length > maxBase ? base.slice(0, maxBase) : base
  return b + suffix
}

export async function writeWorkbook(outPath: string, sheets: SheetData[]): Promise<void> {
  if (sheets.length === 0) throw new UserError('没有可写出的工作表')
  const wb = new ExcelJS.Workbook()
  const used = new Set<string>()
  for (const s of sheets) {
    const base = sanitizeSheetName(s.name)
    let candidate = base
    let i = 2
    // Excel 工作表名大小写不敏感地要求唯一，冲突时追加 _2/_3...
    while (used.has(candidate.toLowerCase())) {
      const suffix = `_${i++}`
      candidate = base.slice(0, 31 - suffix.length) + suffix
    }
    used.add(candidate.toLowerCase())
    const ws = wb.addWorksheet(candidate)
    ws.addRow(s.header)
    for (const r of s.rows) ws.addRow(r)
    ws.getRow(1).font = { bold: true }
  }
  mkdirSync(path.dirname(outPath), { recursive: true })
  await wb.xlsx.writeFile(outPath)
}
