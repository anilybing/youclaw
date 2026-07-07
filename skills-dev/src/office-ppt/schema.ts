// deck.json 契约类型与校验（office-ppt）
// 校验失败时返回人类可读的中文错误列表，CLI 汇总后经 stderr 输出

export const THEME_NAMES = ['business', 'minimal', 'orange'] as const
export type ThemeName = (typeof THEME_NAMES)[number]

export const SLIDE_TYPES = ['cover', 'toc', 'section', 'content', 'two-column', 'table', 'end'] as const
export type SlideType = (typeof SLIDE_TYPES)[number]

export interface TableSpec {
  headers: string[]
  rows: string[][]
}

export interface SlideSpec {
  type: SlideType
  title?: string
  bullets?: string[]
  left?: string[]
  right?: string[]
  table?: TableSpec
  notes?: string
}

export interface DeckSpec {
  title: string
  subtitle?: string
  author?: string
  theme: ThemeName
  slides: SlideSpec[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function coerceCell(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return ''
  return null
}

function toStringList(v: unknown, label: string, errors: string[]): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    errors.push(`${label} 必须是字符串数组`)
    return undefined
  }
  const out: string[] = []
  v.forEach((item, i) => {
    const s = coerceCell(item)
    if (s === null) errors.push(`${label}[${i}] 必须是字符串`)
    else out.push(s)
  })
  return out
}

const TYPE_HINT = SLIDE_TYPES.join(' / ')
const THEME_HINT = THEME_NAMES.join(' / ')

export function isThemeName(v: string): v is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(v)
}

/** 校验并归一化 deck spec；errors 非空时 deck 为 null */
export function validateDeck(raw: unknown): { deck: DeckSpec | null; errors: string[] } {
  const errors: string[] = []

  if (!isRecord(raw)) {
    return { deck: null, errors: ['spec 根节点必须是 JSON 对象（{ "title": ..., "slides": [...] }）'] }
  }

  let title = ''
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    errors.push('deck.title 缺失或为空（必填，string）')
  } else {
    title = raw.title.trim()
  }

  let subtitle: string | undefined
  if (raw.subtitle !== undefined) {
    if (typeof raw.subtitle !== 'string') errors.push('deck.subtitle 必须是 string')
    else subtitle = raw.subtitle
  }

  let author: string | undefined
  if (raw.author !== undefined) {
    if (typeof raw.author !== 'string') errors.push('deck.author 必须是 string')
    else author = raw.author
  }

  let theme: ThemeName = 'business'
  if (raw.theme !== undefined) {
    if (typeof raw.theme !== 'string' || !isThemeName(raw.theme)) {
      errors.push(`deck.theme 取值 ${JSON.stringify(raw.theme)} 非法，支持：${THEME_HINT}`)
    } else {
      theme = raw.theme
    }
  }

  const slides: SlideSpec[] = []
  if (!Array.isArray(raw.slides) || raw.slides.length === 0) {
    errors.push('deck.slides 缺失或为空（必填，至少 1 页）')
  } else {
    raw.slides.forEach((s, i) => {
      const at = `slides[${i}]`
      if (!isRecord(s)) {
        errors.push(`${at} 必须是对象`)
        return
      }
      const t = s.type
      if (typeof t !== 'string' || t === '') {
        errors.push(`${at}.type 缺失（必填），支持：${TYPE_HINT}`)
        return
      }
      if (!(SLIDE_TYPES as readonly string[]).includes(t)) {
        errors.push(`${at}.type "${t}" 为未知版式，支持：${TYPE_HINT}`)
        return
      }
      const type = t as SlideType

      let sTitle: string | undefined
      if (s.title !== undefined) {
        if (typeof s.title !== 'string') errors.push(`${at}.title 必须是 string`)
        else sTitle = s.title
      }
      if (
        (type === 'section' || type === 'content' || type === 'two-column' || type === 'table') &&
        (!sTitle || sTitle.trim() === '')
      ) {
        errors.push(`${at}.title 缺失或为空（${type} 版式必填）`)
      }

      const bullets = toStringList(s.bullets, `${at}.bullets`, errors)
      const left = toStringList(s.left, `${at}.left`, errors)
      const right = toStringList(s.right, `${at}.right`, errors)

      if (type === 'two-column') {
        if (!left || left.length === 0) errors.push(`${at}.left 缺失或为空（two-column 版式必填）`)
        if (!right || right.length === 0) errors.push(`${at}.right 缺失或为空（two-column 版式必填）`)
      }

      let table: TableSpec | undefined
      if (type === 'table') {
        if (!isRecord(s.table)) {
          errors.push(`${at}.table 缺失（table 版式必填，形如 { "headers": [...], "rows": [[...]] }）`)
        } else {
          const headers = toStringList(s.table.headers, `${at}.table.headers`, errors)
          if (!headers || headers.length === 0) {
            errors.push(`${at}.table.headers 必须是非空字符串数组`)
          }
          const rowsRaw = s.table.rows
          const rows: string[][] = []
          if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
            errors.push(`${at}.table.rows 必须是非空数组（每行是一个字符串数组）`)
          } else {
            rowsRaw.forEach((row, ri) => {
              if (!Array.isArray(row)) {
                errors.push(`${at}.table.rows[${ri}] 必须是字符串数组`)
                return
              }
              const cells: string[] = []
              row.forEach((cell, ci) => {
                const c = coerceCell(cell)
                if (c === null) errors.push(`${at}.table.rows[${ri}][${ci}] 必须是字符串`)
                else cells.push(c)
              })
              rows.push(cells)
            })
          }
          if (headers && headers.length > 0 && rows.length > 0) {
            table = { headers, rows }
          }
        }
      }

      let notes: string | undefined
      if (s.notes !== undefined) {
        if (typeof s.notes !== 'string') errors.push(`${at}.notes 必须是 string`)
        else notes = s.notes
      }

      slides.push({ type, title: sTitle, bullets, left, right, table, notes })
    })
  }

  if (errors.length > 0) return { deck: null, errors }
  return { deck: { title, subtitle, author, theme, slides }, errors: [] }
}
