// office-doc spec（doc.json）的类型定义与校验，契约见 skills/office-doc/SKILL.md

export type DocStyle = 'report' | 'proposal' | 'plain'

export interface DocTableSpec {
  headers: string[]
  rows: string[][]
}

export interface DocSectionSpec {
  heading: string
  level: 1 | 2 | 3
  paragraphs: string[]
  bullets: string[]
  table?: DocTableSpec
}

export interface DocSpec {
  title: string
  style: DocStyle
  toc: boolean
  author?: string
  date: string
  sections: DocSectionSpec[]
}

const DOC_STYLES: readonly DocStyle[] = ['report', 'proposal', 'plain']

export class SpecValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`doc.json 校验失败：\n- ${issues.join('\n- ')}`)
    this.name = 'SpecValidationError'
    this.issues = issues
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatToday(): string {
  const now = new Date()
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
}

function toCellText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function readStringArray(value: unknown, path: string, issues: string[]): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是字符串数组`)
    return []
  }
  const result: string[] = []
  value.forEach((item, index) => {
    const text = toCellText(item)
    if (text === undefined) {
      issues.push(`${path}[${index}] 必须是字符串`)
    } else {
      result.push(text)
    }
  })
  return result
}

function readTable(value: unknown, path: string, issues: string[]): DocTableSpec | undefined {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    issues.push(`${path} 必须是对象，形如 {"headers":[...],"rows":[[...]]}`)
    return undefined
  }

  const headers = readStringArray(value.headers, `${path}.headers`, issues)
  if (!Array.isArray(value.headers) || headers.length === 0) {
    issues.push(`${path}.headers 必须是非空字符串数组`)
    return undefined
  }

  const rows: string[][] = []
  if (value.rows === undefined || value.rows === null) {
    issues.push(`${path}.rows 必须是二维字符串数组（可为空数组）`)
    return undefined
  }
  if (!Array.isArray(value.rows)) {
    issues.push(`${path}.rows 必须是二维字符串数组`)
    return undefined
  }
  value.rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      issues.push(`${path}.rows[${rowIndex}] 必须是字符串数组`)
      return
    }
    const cells: string[] = []
    row.forEach((cell, cellIndex) => {
      const text = toCellText(cell)
      if (text === undefined) {
        issues.push(`${path}.rows[${rowIndex}][${cellIndex}] 必须是字符串`)
        cells.push('')
      } else {
        cells.push(text)
      }
    })
    rows.push(cells)
  })

  return { headers, rows }
}

function readSection(value: unknown, index: number, issues: string[]): DocSectionSpec {
  const path = `sections[${index}]`
  const fallback: DocSectionSpec = { heading: '', level: 1, paragraphs: [], bullets: [] }

  if (!isPlainObject(value)) {
    issues.push(`${path} 必须是对象`)
    return fallback
  }

  let heading = ''
  if (typeof value.heading !== 'string' || value.heading.trim().length === 0) {
    issues.push(`${path}.heading 为必填字段，必须是非空字符串`)
  } else {
    heading = value.heading.trim()
  }

  let level: 1 | 2 | 3 = 1
  if (value.level !== undefined && value.level !== null) {
    if (value.level === 1 || value.level === 2 || value.level === 3) {
      level = value.level
    } else {
      issues.push(`${path}.level 必须是 1-3 的整数（收到 ${JSON.stringify(value.level)}），1/2/3 分别对应 Word 的 Heading1/2/3`)
    }
  }

  return {
    heading,
    level,
    paragraphs: readStringArray(value.paragraphs, `${path}.paragraphs`, issues),
    bullets: readStringArray(value.bullets, `${path}.bullets`, issues),
    table: readTable(value.table, `${path}.table`, issues),
  }
}

/** 校验并归一化 doc.json；校验失败抛出 SpecValidationError（聚合全部问题）。 */
export function validateSpec(raw: unknown): DocSpec {
  const issues: string[] = []

  if (!isPlainObject(raw)) {
    throw new SpecValidationError(['spec 根节点必须是 JSON 对象'])
  }

  let title = ''
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
    issues.push('title 为必填字段，必须是非空字符串')
  } else {
    title = raw.title.trim()
  }

  let style: DocStyle = 'report'
  if (raw.style !== undefined && raw.style !== null) {
    if (typeof raw.style === 'string' && (DOC_STYLES as readonly string[]).includes(raw.style)) {
      style = raw.style as DocStyle
    } else {
      issues.push(`style 只能是 ${DOC_STYLES.join(' / ')} 之一（收到 ${JSON.stringify(raw.style)}）`)
    }
  }

  let toc = false
  if (raw.toc !== undefined && raw.toc !== null) {
    if (typeof raw.toc === 'boolean') {
      toc = raw.toc
    } else {
      issues.push('toc 必须是布尔值')
    }
  }

  let author: string | undefined
  if (raw.author !== undefined && raw.author !== null) {
    if (typeof raw.author === 'string' && raw.author.trim().length > 0) {
      author = raw.author.trim()
    } else {
      issues.push('author 若提供必须是非空字符串')
    }
  }

  let date = formatToday()
  if (raw.date !== undefined && raw.date !== null) {
    if (typeof raw.date === 'string' && raw.date.trim().length > 0) {
      date = raw.date.trim()
    } else {
      issues.push('date 若提供必须是非空字符串')
    }
  }

  let sections: DocSectionSpec[] = []
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    issues.push('sections 为必填字段，必须是至少包含一个章节的数组')
  } else {
    sections = raw.sections.map((section, index) => readSection(section, index, issues))
  }

  if (issues.length > 0) {
    throw new SpecValidationError(issues)
  }

  return { title, style, toc, author, date, sections }
}
