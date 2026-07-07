// office-doc 渲染核心：DocSpec -> .docx Buffer（基于 docx 库，纯 JS、零网络）

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx'
import type { DocSectionSpec, DocSpec, DocStyle, DocTableSpec } from './schema.ts'

const FONT = 'Microsoft YaHei'

interface StyleTheme {
  /** 是否生成封面页 */
  hasCover: boolean
  bodyColor: string
  bodySize: number
  lineSpacing: number
  /** 正文段落首行缩进（twip），仅正式公文风格使用 */
  firstLineIndent?: number
  headingColor: string
  /** Heading1/2/3 字号（半磅） */
  headingSizes: [number, number, number]
  coverTitleColor: string
  accentColor: string
  tableHeaderFill: string
  tableHeaderTextColor: string
  tableBorderColor: string
  headerFooterColor: string
}

const THEMES: Record<DocStyle, StyleTheme> = {
  // 正式黑蓝：深蓝标题 + 近黑正文 + 首行缩进
  report: {
    hasCover: true,
    bodyColor: '1A1A1A',
    bodySize: 22,
    lineSpacing: 340,
    firstLineIndent: 480,
    headingColor: '1F4E79',
    headingSizes: [36, 30, 26],
    coverTitleColor: '1F4E79',
    accentColor: '1F4E79',
    tableHeaderFill: '1F4E79',
    tableHeaderTextColor: 'FFFFFF',
    tableBorderColor: '8EAADB',
    headerFooterColor: '595959',
  },
  // 品牌提案：品牌橘 #f97316 标题
  proposal: {
    hasCover: true,
    bodyColor: '1F2937',
    bodySize: 22,
    lineSpacing: 320,
    headingColor: 'F97316',
    headingSizes: [36, 30, 26],
    coverTitleColor: 'F97316',
    accentColor: 'F97316',
    tableHeaderFill: 'F97316',
    tableHeaderTextColor: 'FFFFFF',
    tableBorderColor: 'FDBA74',
    headerFooterColor: '6B7280',
  },
  // 极简：全黑、无封面、紧凑行距
  plain: {
    hasCover: false,
    bodyColor: '000000',
    bodySize: 21,
    lineSpacing: 280,
    headingColor: '000000',
    headingSizes: [32, 27, 24],
    coverTitleColor: '000000',
    accentColor: '000000',
    tableHeaderFill: 'F3F4F6',
    tableHeaderTextColor: '000000',
    tableBorderColor: 'BFBFBF',
    headerFooterColor: '808080',
  },
}

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
} as const

function bodyRun(text: string, theme: StyleTheme): TextRun {
  return new TextRun({
    text,
    font: FONT,
    size: theme.bodySize,
    color: theme.bodyColor,
  })
}

function buildCover(spec: DocSpec, theme: StyleTheme): Paragraph[] {
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 3800, after: 360 },
      children: [
        new TextRun({ text: spec.title, font: FONT, size: 52, bold: true, color: theme.coverTitleColor }),
      ],
    }),
    // 标题下的装饰分隔线
    new Paragraph({
      indent: { left: 2400, right: 2400 },
      spacing: { after: 2600 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: theme.accentColor, space: 1 } },
      children: [],
    }),
  ]

  if (spec.author) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: spec.author, font: FONT, size: 26, color: theme.bodyColor })],
      }),
    )
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: spec.date, font: FONT, size: 22, color: theme.headerFooterColor })],
    }),
  )

  return children
}

function buildTocBlock(theme: StyleTheme): (Paragraph | TableOfContents)[] {
  return [
    new Paragraph({
      spacing: { before: 200, after: 240 },
      children: [new TextRun({ text: '目录', font: FONT, size: 32, bold: true, color: theme.headingColor })],
    }),
    new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }),
  ]
}

function normalizeRow(row: string[], width: number): string[] {
  if (row.length === width) return row
  if (row.length > width) return row.slice(0, width)
  return [...row, ...new Array<string>(width - row.length).fill('')]
}

function buildTable(table: DocTableSpec, theme: StyleTheme): Table {
  const width = table.headers.length
  const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: theme.tableBorderColor }

  const headerRow = new TableRow({
    tableHeader: true,
    children: table.headers.map(
      (header) =>
        new TableCell({
          verticalAlign: VerticalAlign.CENTER,
          shading: { type: ShadingType.CLEAR, fill: theme.tableHeaderFill, color: 'auto' },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 0, line: 276 },
              children: [
                new TextRun({ text: header, font: FONT, size: theme.bodySize, bold: true, color: theme.tableHeaderTextColor }),
              ],
            }),
          ],
        }),
    ),
  })

  const dataRows = table.rows.map(
    (row) =>
      new TableRow({
        children: normalizeRow(row, width).map(
          (cell) =>
            new TableCell({
              verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({
                  spacing: { after: 0, line: 276 },
                  children: [bodyRun(cell, theme)],
                }),
              ],
            }),
        ),
      }),
  )

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    margins: { top: 100, bottom: 100, left: 150, right: 150 },
    borders: {
      top: cellBorder,
      bottom: cellBorder,
      left: cellBorder,
      right: cellBorder,
      insideHorizontal: cellBorder,
      insideVertical: cellBorder,
    },
    rows: [headerRow, ...dataRows],
  })
}

function buildSection(section: DocSectionSpec, theme: StyleTheme): (Paragraph | Table)[] {
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      heading: HEADING_LEVELS[section.level],
      children: [new TextRun({ text: section.heading, font: FONT })],
    }),
  ]

  for (const text of section.paragraphs) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        indent: theme.firstLineIndent ? { firstLine: theme.firstLineIndent } : undefined,
        spacing: { after: 160, line: theme.lineSpacing },
        children: [bodyRun(text, theme)],
      }),
    )
  }

  for (const text of section.bullets) {
    children.push(
      new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80, line: theme.lineSpacing },
        children: [bodyRun(text, theme)],
      }),
    )
  }

  if (section.table) {
    children.push(buildTable(section.table, theme))
    // 表格后补一个空段，避免表格与后续标题贴死
    children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
  }

  return children
}

function buildBodyHeader(spec: DocSpec, theme: StyleTheme): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9', space: 2 } },
        children: [new TextRun({ text: spec.title, font: FONT, size: 18, color: theme.headerFooterColor })],
      }),
    ],
  })
}

function buildBodyFooter(theme: StyleTheme): Footer {
  const runProps = { font: FONT, size: 18, color: theme.headerFooterColor }
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: '第 ', ...runProps }),
          new TextRun({ children: [PageNumber.CURRENT], ...runProps }),
          new TextRun({ text: ' 页 / 共 ', ...runProps }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], ...runProps }),
          new TextRun({ text: ' 页', ...runProps }),
        ],
      }),
    ],
  })
}

/** plain 风格无封面页，文档顶部放标题与作者/日期信息行 */
function buildPlainTitleBlock(spec: DocSpec, theme: StyleTheme): Paragraph[] {
  const children: Paragraph[] = [
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: spec.title, font: FONT, size: 36, bold: true, color: theme.bodyColor })],
    }),
  ]
  const metaText = spec.author ? `${spec.author} · ${spec.date}` : spec.date
  children.push(
    new Paragraph({
      spacing: { after: 280 },
      children: [new TextRun({ text: metaText, font: FONT, size: 20, color: theme.headerFooterColor })],
    }),
  )
  return children
}

export async function renderDoc(spec: DocSpec): Promise<Buffer> {
  const theme = THEMES[spec.style]

  const bodyChildren: (Paragraph | Table | TableOfContents)[] = []

  if (!theme.hasCover) {
    bodyChildren.push(...buildPlainTitleBlock(spec, theme))
  }

  if (spec.toc) {
    bodyChildren.push(...buildTocBlock(theme))
    if (theme.hasCover) {
      bodyChildren.push(new Paragraph({ children: [new PageBreak()] }))
    }
  }

  for (const section of spec.sections) {
    bodyChildren.push(...buildSection(section, theme))
  }

  const bodySection = {
    properties: { page: { pageNumbers: { start: 1 } } },
    headers: { default: buildBodyHeader(spec, theme) },
    footers: { default: buildBodyFooter(theme) },
    children: bodyChildren,
  }

  const sections: (typeof bodySection)[] = []
  if (theme.hasCover) {
    sections.push({
      properties: { page: { pageNumbers: { start: 1 } } },
      // 封面页不出现页眉页脚
      headers: { default: new Header({ children: [] }) },
      footers: { default: new Footer({ children: [] }) },
      children: buildCover(spec, theme),
    })
  }
  sections.push(bodySection)

  const doc = new Document({
    creator: spec.author ?? 'XiaoJuClaw',
    title: spec.title,
    description: `Generated by XiaoJuClaw office-doc skill (style: ${spec.style})`,
    // toc=true 时让 Word 打开文档时提示更新域，目录页码即自动填充
    features: spec.toc ? { updateFields: true } : undefined,
    styles: {
      default: {
        document: {
          run: { font: FONT, size: theme.bodySize, color: theme.bodyColor },
        },
        heading1: {
          run: { font: FONT, size: theme.headingSizes[0], bold: true, color: theme.headingColor },
          paragraph: { spacing: { before: 360, after: 200 } },
        },
        heading2: {
          run: { font: FONT, size: theme.headingSizes[1], bold: true, color: theme.headingColor },
          paragraph: { spacing: { before: 280, after: 160 } },
        },
        heading3: {
          run: { font: FONT, size: theme.headingSizes[2], bold: true, color: theme.headingColor },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
      },
    },
    sections,
  })

  return Packer.toBuffer(doc)
}
