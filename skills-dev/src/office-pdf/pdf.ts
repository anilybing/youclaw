import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb } from 'pdf-lib'

/** 预期内的输入/环境错误：message 面向调用方，直接输出到 stderr */
export class UserError extends Error {}

export interface PdfOpResult {
  outPath: string
  pages: number
}

/** WinAnsi（Windows-1252）0x80-0x9F 区段实际映射的 Unicode 码点 */
const WINANSI_EXTRA_CODEPOINTS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

/** 返回文本中第一个内置标准字体（WinAnsi 编码）无法表示的字符；全部可表示则返回 null */
export function findWinAnsiUnsupportedChar(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const supported =
      (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA_CODEPOINTS.has(cp)
    if (!supported) return ch
  }
  return null
}

async function loadPdf(filePath: string): Promise<PDFDocument> {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) throw new UserError(`输入文件不存在：${resolved}`)
  const bytes = fs.readFileSync(resolved)
  try {
    return await PDFDocument.load(bytes)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    if (/encrypt/i.test(raw)) {
      throw new UserError(`输入文件已加密，无法处理：${resolved}。请先解除 PDF 的密码保护再试`)
    }
    throw new UserError(`输入文件不是有效的 PDF 或已损坏：${resolved}（${raw}）`)
  }
}

/**
 * 校验输出路径（红线）：
 * 1. --out 与任何输入文件相同 => 直接报错，禁止覆盖原文件；
 * 2. --out 已存在的其他文件 => 需要显式 --overwrite。
 */
function resolveOutPath(outArg: string, inputPaths: string[], overwrite: boolean): string {
  const outPath = path.resolve(outArg)
  // Windows 文件系统大小写不敏感，统一小写比较，宁可误报也不覆盖原文件
  const outKey = outPath.toLowerCase()
  for (const input of inputPaths) {
    if (path.resolve(input).toLowerCase() === outKey) {
      throw new UserError(`--out 不能与输入文件相同：${outPath}。禁止覆盖原文件，请输出到一个新路径`)
    }
  }
  if (fs.existsSync(outPath)) {
    if (fs.statSync(outPath).isDirectory()) {
      throw new UserError(`--out 指向的是一个目录：${outPath}，请指定输出文件路径`)
    }
    if (!overwrite) {
      throw new UserError(`输出文件已存在：${outPath}。请换一个新的输出路径，或显式加 --overwrite 允许覆盖`)
    }
  }
  return outPath
}

function writeOutput(outPath: string, bytes: Uint8Array): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, bytes)
}

/** 解析 --pages（1 起始，支持 "5"、"1-3"、逗号组合），返回按书写顺序展开的页码列表 */
export function parsePagesSpec(spec: string, pageCount: number): number[] {
  const tokens = spec
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) throw new UserError('--pages 不能为空，示例：--pages 1-3,5（页码从 1 开始）')
  const pages: number[] = []
  for (const token of tokens) {
    const match = token.match(/^(\d+)\s*(?:-\s*(\d+))?$/)
    if (!match) {
      throw new UserError(`--pages 中的「${token}」格式不正确：只支持单页（如 5）或区间（如 1-3），页码从 1 开始，用英文逗号分隔`)
    }
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (start < 1) throw new UserError(`--pages 中的「${token}」无效：页码从 1 开始，不存在第 ${start} 页`)
    if (end < start) throw new UserError(`--pages 中的「${token}」无效：区间结束页不能小于起始页`)
    if (end > pageCount) {
      throw new UserError(`--pages 中的「${token}」超出范围：该 PDF 共 ${pageCount} 页（页码从 1 开始，最大可用 ${pageCount}）`)
    }
    for (let p = start; p <= end; p++) pages.push(p)
  }
  return pages
}

/** merge：按 --input 顺序合并所有页 */
export async function mergePdfs(inputPaths: string[], outArg: string, overwrite: boolean): Promise<PdfOpResult> {
  if (inputPaths.length < 2) {
    throw new UserError(`merge 模式至少需要 2 个输入文件（--input 用英文逗号分隔多个路径，如 a.pdf,b.pdf），当前只收到 ${inputPaths.length} 个`)
  }
  const outPath = resolveOutPath(outArg, inputPaths, overwrite)
  const merged = await PDFDocument.create()
  for (const inputPath of inputPaths) {
    const src = await loadPdf(inputPath)
    const copied = await merged.copyPages(src, src.getPageIndices())
    for (const page of copied) merged.addPage(page)
  }
  writeOutput(outPath, await merged.save())
  return { outPath, pages: merged.getPageCount() }
}

/** split：抽取 --pages 指定的页组成新 PDF */
export async function splitPdf(inputPath: string, pagesSpec: string, outArg: string, overwrite: boolean): Promise<PdfOpResult> {
  const outPath = resolveOutPath(outArg, [inputPath], overwrite)
  const src = await loadPdf(inputPath)
  const pageNumbers = parsePagesSpec(pagesSpec, src.getPageCount())
  const outDoc = await PDFDocument.create()
  const copied = await outDoc.copyPages(src, pageNumbers.map((n) => n - 1))
  for (const page of copied) outDoc.addPage(page)
  writeOutput(outPath, await outDoc.save())
  return { outPath, pages: outDoc.getPageCount() }
}

/**
 * watermark：每页 45° 对角线平铺半透明文字水印。
 * 内置 StandardFonts 仅支持 WinAnsi 编码，含中文等 CJK 字符时直接报错
 * （报错文案与 SKILL.md 的说明保持一致）。
 */
export async function watermarkPdf(
  inputPath: string,
  text: string,
  outArg: string,
  opacity: number,
  overwrite: boolean,
): Promise<PdfOpResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new UserError('--text 不能为空：请提供水印文本（建议英文或数字，如 CONFIDENTIAL）')
  const unsupported = findWinAnsiUnsupportedChar(trimmed)
  if (unsupported) {
    throw new UserError(
      `水印文本包含内置标准字体不支持的字符「${unsupported}」（中文等 CJK 字符不支持）。请改用英文或数字水印文本，例如 CONFIDENTIAL、DRAFT、INTERNAL USE ONLY`,
    )
  }
  const outPath = resolveOutPath(outArg, [inputPath], overwrite)
  const doc = await loadPdf(inputPath)
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  for (const page of doc.getPages()) {
    drawWatermarkOnPage(page, trimmed, font, opacity)
  }
  writeOutput(outPath, await doc.save())
  return { outPath, pages: doc.getPageCount() }
}

function drawWatermarkOnPage(page: PDFPage, text: string, font: PDFFont, opacity: number): void {
  const { width, height } = page.getSize()
  // 基准字号取短边的 1/6，过长的文本逐步缩小到不超过对角线的 55%
  let fontSize = Math.max(12, Math.min(width, height) / 6)
  const maxTextWidth = Math.hypot(width, height) * 0.55
  while (fontSize > 12 && font.widthOfTextAtSize(text, fontSize) > maxTextWidth) fontSize -= 2
  const textWidth = font.widthOfTextAtSize(text, fontSize)
  const stepX = textWidth + fontSize * 2
  const stepY = fontSize * 5
  // 平铺范围向四周各外扩一个对角线长度，保证 45° 旋转后整页仍被覆盖
  const diagonal = Math.hypot(width, height)
  for (let y = -diagonal; y <= height + diagonal; y += stepY) {
    for (let x = -diagonal; x <= width + diagonal; x += stepX) {
      page.drawText(text, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(0.55, 0.55, 0.55),
        opacity,
        rotate: degrees(45),
      })
    }
  }
}
