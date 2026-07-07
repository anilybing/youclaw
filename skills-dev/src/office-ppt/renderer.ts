// deck spec -> pptxgenjs 渲染（16:9，Microsoft YaHei，三主题）
import PptxGenJS from 'pptxgenjs'
import type { DeckSpec, SlideSpec, TableSpec } from './schema.ts'
import { THEMES, type ThemeColors } from './themes.ts'

const FONT = 'Microsoft YaHei'

// LAYOUT_16x9：10in x 5.625in
const PAGE_W = 10
const PAGE_H = 5.625
const MARGIN_X = 0.6
const CONTENT_W = PAGE_W - MARGIN_X * 2
const BODY_Y = 1.4
const BODY_H = 3.55
const FOOTER_Y = PAGE_H - 0.38

interface RenderContext {
  deck: DeckSpec
  colors: ThemeColors
  total: number
  sectionCount: number
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 中日韩字符按 2 个单位估宽，用于表格自动列宽 */
function textUnits(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    w += cp > 0xff ? 2 : 1
  }
  return w
}

/** 目录条目：优先显式 bullets；否则取 section 标题，无 section 再取内容页标题 */
export function tocEntries(deck: DeckSpec, slide: SlideSpec): string[] {
  if (slide.bullets && slide.bullets.length > 0) return slide.bullets
  const sections = deck.slides.filter((s) => s.type === 'section' && s.title).map((s) => s.title as string)
  if (sections.length > 0) return sections
  return deck.slides
    .filter((s) => (s.type === 'content' || s.type === 'two-column' || s.type === 'table') && s.title)
    .map((s) => s.title as string)
}

/** 表格自动列宽：按各列最长内容占比分配，最窄 0.9in */
export function autoColumnWidths(table: TableSpec, totalWidth: number): number[] {
  const cols = table.headers.length
  const weights: number[] = []
  for (let c = 0; c < cols; c++) {
    let max = textUnits(table.headers[c] ?? '')
    for (const row of table.rows) {
      max = Math.max(max, textUnits(row[c] ?? ''))
    }
    weights.push(Math.min(Math.max(max, 4), 40))
  }
  const sum = weights.reduce((a, b) => a + b, 0)
  const raw = weights.map((w) => (w / sum) * totalWidth)

  const MIN_W = 0.9
  if (totalWidth / cols <= MIN_W) {
    return weights.map(() => totalWidth / cols)
  }
  // 窄列提升到下限，剩余宽度按权重分给其他列
  const narrow = raw.map((w) => w < MIN_W)
  const narrowCount = narrow.filter(Boolean).length
  if (narrowCount === 0) return raw.map((w) => Math.round(w * 100) / 100)
  const restWidth = totalWidth - narrowCount * MIN_W
  const restSum = weights.reduce((a, b, i) => (narrow[i] ? a : a + b), 0)
  return weights.map((w, i) => (narrow[i] ? MIN_W : Math.round((w / restSum) * restWidth * 100) / 100))
}

function addFooter(slide: PptxGenJS.Slide, ctx: RenderContext, pageNo: number, onDark: boolean): void {
  const color = onDark ? ctx.colors.onPrimarySub : ctx.colors.footer
  slide.addText(ctx.deck.title, {
    x: MARGIN_X,
    y: FOOTER_Y,
    w: 6,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color,
    align: 'left',
    valign: 'middle',
  })
  slide.addText(`${pageNo} / ${ctx.total}`, {
    x: PAGE_W - MARGIN_X - 1.4,
    y: FOOTER_Y,
    w: 1.4,
    h: 0.3,
    fontFace: FONT,
    fontSize: 10,
    color,
    align: 'right',
    valign: 'middle',
  })
}

/** 内容类页面的标题条：左侧强调色块 + 标题 + 下划分隔线 */
function addTitleBar(slide: PptxGenJS.Slide, ctx: RenderContext, title: string): void {
  slide.addShape('rect', {
    x: MARGIN_X,
    y: 0.46,
    w: 0.14,
    h: 0.46,
    fill: { color: ctx.colors.accent },
  })
  slide.addText(title, {
    x: MARGIN_X + 0.28,
    y: 0.32,
    w: CONTENT_W - 0.28,
    h: 0.72,
    fontFace: FONT,
    fontSize: 32,
    bold: true,
    color: ctx.colors.text,
    align: 'left',
    valign: 'middle',
    fit: 'shrink',
  })
  slide.addShape('rect', {
    x: MARGIN_X,
    y: 1.16,
    w: CONTENT_W,
    h: 0.018,
    fill: { color: ctx.colors.border },
  })
}

function bulletRuns(items: string[], fontSize: number, color: string): PptxGenJS.TextProps[] {
  return items.map((text) => ({
    text,
    options: {
      bullet: { characterCode: '2022', indent: 12 },
      color,
      fontSize,
      breakLine: true,
    },
  }))
}

function renderCover(slide: PptxGenJS.Slide, ctx: RenderContext): void {
  slide.background = { color: ctx.colors.primary }
  slide.addShape('rect', {
    x: (PAGE_W - 1.2) / 2,
    y: 1.52,
    w: 1.2,
    h: 0.055,
    fill: { color: ctx.colors.onPrimarySub },
  })
  slide.addText(ctx.deck.title, {
    x: 0.7,
    y: 1.85,
    w: PAGE_W - 1.4,
    h: 1.15,
    fontFace: FONT,
    fontSize: 40,
    bold: true,
    color: ctx.colors.onPrimary,
    align: 'center',
    valign: 'middle',
    fit: 'shrink',
  })
  if (ctx.deck.subtitle) {
    slide.addText(ctx.deck.subtitle, {
      x: 1.2,
      y: 3.1,
      w: PAGE_W - 2.4,
      h: 0.6,
      fontFace: FONT,
      fontSize: 18,
      color: ctx.colors.onPrimarySub,
      align: 'center',
      valign: 'middle',
    })
  }
  if (ctx.deck.author) {
    slide.addText(ctx.deck.author, {
      x: 1.2,
      y: 4.55,
      w: PAGE_W - 2.4,
      h: 0.4,
      fontFace: FONT,
      fontSize: 14,
      color: ctx.colors.onPrimarySub,
      align: 'center',
      valign: 'middle',
    })
  }
}

function renderToc(slide: PptxGenJS.Slide, ctx: RenderContext, spec: SlideSpec): void {
  addTitleBar(slide, ctx, spec.title && spec.title.trim() !== '' ? spec.title : '目录')
  const entries = tocEntries(ctx.deck, spec)
  if (entries.length === 0) return

  const makeRuns = (items: string[], startIndex: number): PptxGenJS.TextProps[] =>
    items.flatMap((text, i) => [
      {
        text: pad2(startIndex + i + 1),
        options: { color: ctx.colors.accent, bold: true, fontSize: 20 },
      },
      {
        text: `   ${text}`,
        options: { color: ctx.colors.text, fontSize: 20, breakLine: true },
      },
    ])

  if (entries.length <= 7) {
    slide.addText(makeRuns(entries, 0), {
      x: MARGIN_X + 0.3,
      y: BODY_Y + 0.1,
      w: CONTENT_W - 0.6,
      h: BODY_H - 0.2,
      fontFace: FONT,
      valign: 'top',
      paraSpaceAfter: 14,
      fit: 'shrink',
    })
  } else {
    const half = Math.ceil(entries.length / 2)
    const columns: Array<{ items: string[]; start: number; x: number }> = [
      { items: entries.slice(0, half), start: 0, x: MARGIN_X + 0.3 },
      { items: entries.slice(half), start: half, x: PAGE_W / 2 + 0.15 },
    ]
    for (const col of columns) {
      slide.addText(makeRuns(col.items, col.start), {
        x: col.x,
        y: BODY_Y + 0.1,
        w: CONTENT_W / 2 - 0.45,
        h: BODY_H - 0.2,
        fontFace: FONT,
        valign: 'top',
        paraSpaceAfter: 12,
        fit: 'shrink',
      })
    }
  }
}

function renderSection(slide: PptxGenJS.Slide, ctx: RenderContext, spec: SlideSpec, sectionIndex: number): void {
  slide.background = { color: ctx.colors.band }
  slide.addText(pad2(sectionIndex), {
    x: 0.6,
    y: 1.5,
    w: PAGE_W - 1.2,
    h: 0.6,
    fontFace: FONT,
    fontSize: 28,
    bold: true,
    color: ctx.colors.accent,
    align: 'center',
    valign: 'middle',
  })
  slide.addText(spec.title ?? '', {
    x: 0.9,
    y: 2.15,
    w: PAGE_W - 1.8,
    h: 0.95,
    fontFace: FONT,
    fontSize: 36,
    bold: true,
    color: ctx.colors.text,
    align: 'center',
    valign: 'middle',
    fit: 'shrink',
  })
  slide.addShape('rect', {
    x: (PAGE_W - 1.2) / 2,
    y: 3.28,
    w: 1.2,
    h: 0.055,
    fill: { color: ctx.colors.accent },
  })
  if (spec.bullets && spec.bullets.length > 0) {
    slide.addText(spec.bullets.join('　·　'), {
      x: 1.4,
      y: 3.55,
      w: PAGE_W - 2.8,
      h: 0.9,
      fontFace: FONT,
      fontSize: 16,
      color: ctx.colors.subText,
      align: 'center',
      valign: 'top',
      fit: 'shrink',
    })
  }
}

function renderContent(slide: PptxGenJS.Slide, ctx: RenderContext, spec: SlideSpec): void {
  addTitleBar(slide, ctx, spec.title ?? '')
  if (spec.bullets && spec.bullets.length > 0) {
    slide.addText(bulletRuns(spec.bullets, 20, ctx.colors.text), {
      x: MARGIN_X,
      y: BODY_Y,
      w: CONTENT_W,
      h: BODY_H,
      fontFace: FONT,
      valign: 'top',
      paraSpaceAfter: 10,
      fit: 'shrink',
    })
  }
}

function renderTwoColumn(slide: PptxGenJS.Slide, ctx: RenderContext, spec: SlideSpec): void {
  addTitleBar(slide, ctx, spec.title ?? '')
  const colW = (CONTENT_W - 0.5) / 2
  slide.addShape('rect', {
    x: PAGE_W / 2 - 0.01,
    y: BODY_Y + 0.15,
    w: 0.02,
    h: BODY_H - 0.45,
    fill: { color: ctx.colors.border },
  })
  const columns: Array<{ items: string[]; x: number }> = [
    { items: spec.left ?? [], x: MARGIN_X },
    { items: spec.right ?? [], x: MARGIN_X + colW + 0.5 },
  ]
  for (const col of columns) {
    if (col.items.length === 0) continue
    slide.addText(bulletRuns(col.items, 18, ctx.colors.text), {
      x: col.x,
      y: BODY_Y,
      w: colW,
      h: BODY_H,
      fontFace: FONT,
      valign: 'top',
      paraSpaceAfter: 9,
      fit: 'shrink',
    })
  }
}

function renderTable(slide: PptxGenJS.Slide, ctx: RenderContext, spec: SlideSpec): void {
  addTitleBar(slide, ctx, spec.title ?? '')
  const table = spec.table
  if (!table) return

  const cols = table.headers.length
  const border: PptxGenJS.BorderProps = { type: 'solid', color: ctx.colors.border, pt: 0.5 }

  const headerRow: PptxGenJS.TableRow = table.headers.map((h) => ({
    text: h,
    options: {
      fill: { color: ctx.colors.primary },
      color: ctx.colors.onPrimary,
      bold: true,
      fontSize: 14,
      align: 'center',
      valign: 'middle',
      border,
    },
  }))

  const bodyRows: PptxGenJS.TableRow[] = table.rows.map((row, ri) => {
    const cells: PptxGenJS.TableCell[] = []
    for (let c = 0; c < cols; c++) {
      cells.push({
        text: row[c] ?? '',
        options: {
          fill: { color: ri % 2 === 1 ? ctx.colors.rowAlt : ctx.colors.bg },
          color: ctx.colors.text,
          fontSize: 13,
          align: 'left',
          valign: 'middle',
          border,
        },
      })
    }
    return cells
  })

  slide.addTable([headerRow, ...bodyRows], {
    x: MARGIN_X,
    y: BODY_Y,
    w: CONTENT_W,
    colW: autoColumnWidths(table, CONTENT_W),
    fontFace: FONT,
    autoPage: false,
    rowH: 0.42,
  })
}

function renderEnd(slide: PptxGenJS.Slide, ctx: RenderContext, spec: SlideSpec): void {
  slide.background = { color: ctx.colors.primary }
  slide.addShape('rect', {
    x: (PAGE_W - 1.2) / 2,
    y: 1.72,
    w: 1.2,
    h: 0.055,
    fill: { color: ctx.colors.onPrimarySub },
  })
  slide.addText(spec.title && spec.title.trim() !== '' ? spec.title : '谢谢观看', {
    x: 0.7,
    y: 2.05,
    w: PAGE_W - 1.4,
    h: 1.0,
    fontFace: FONT,
    fontSize: 40,
    bold: true,
    color: ctx.colors.onPrimary,
    align: 'center',
    valign: 'middle',
    fit: 'shrink',
  })
  const subParts = [ctx.deck.title, ctx.deck.author].filter((s): s is string => !!s && s.trim() !== '')
  if (subParts.length > 0) {
    slide.addText(subParts.join('　·　'), {
      x: 1.2,
      y: 3.25,
      w: PAGE_W - 2.4,
      h: 0.5,
      fontFace: FONT,
      fontSize: 16,
      color: ctx.colors.onPrimarySub,
      align: 'center',
      valign: 'middle',
    })
  }
  if (spec.bullets && spec.bullets.length > 0) {
    slide.addText(spec.bullets.join('　·　'), {
      x: 1.2,
      y: 3.85,
      w: PAGE_W - 2.4,
      h: 0.5,
      fontFace: FONT,
      fontSize: 13,
      color: ctx.colors.onPrimarySub,
      align: 'center',
      valign: 'top',
    })
  }
}

/** 渲染整份 deck，返回 pptx 二进制与页数 */
export async function renderDeck(deck: DeckSpec): Promise<{ buffer: Buffer; slides: number }> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.title = deck.title
  if (deck.subtitle) pptx.subject = deck.subtitle
  if (deck.author) pptx.author = deck.author
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }

  const ctx: RenderContext = {
    deck,
    colors: THEMES[deck.theme],
    total: deck.slides.length,
    sectionCount: 0,
  }

  deck.slides.forEach((spec, i) => {
    const slide = pptx.addSlide()
    const pageNo = i + 1

    switch (spec.type) {
      case 'cover':
        renderCover(slide, ctx)
        break
      case 'toc':
        renderToc(slide, ctx, spec)
        break
      case 'section':
        ctx.sectionCount += 1
        renderSection(slide, ctx, spec, ctx.sectionCount)
        break
      case 'content':
        renderContent(slide, ctx, spec)
        break
      case 'two-column':
        renderTwoColumn(slide, ctx, spec)
        break
      case 'table':
        renderTable(slide, ctx, spec)
        break
      case 'end':
        renderEnd(slide, ctx, spec)
        break
    }

    // 页脚页码：封面除外；深色底页面用浅色页脚
    if (spec.type !== 'cover') {
      addFooter(slide, ctx, pageNo, spec.type === 'end')
    }
    if (spec.notes) {
      slide.addNotes(spec.notes)
    }
  })

  const data = await pptx.write({ outputType: 'nodebuffer' })
  return { buffer: data as Buffer, slides: deck.slides.length }
}
