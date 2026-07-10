// [XJC-PATCH] bounded compatibility extractor for legacy attachment callers.
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import type { Attachment } from '../types/attachment.ts'

export const MAX_OFFICE_INPUT_BYTES = 25 * 1024 * 1024
export const MAX_OFFICE_ARCHIVE_BYTES = 64 * 1024 * 1024
export const MAX_OFFICE_ENTRY_BYTES = 16 * 1024 * 1024
export const MAX_OFFICE_ARCHIVE_ENTRIES = 1_000
export const MAX_EXTRACTED_TEXT_BYTES = 8 * 1024 * 1024

type OfficeInput = string | Buffer | Uint8Array

function assertSafeArchivePath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (
    normalized.startsWith('/')
    || /^[a-zA-Z]:/.test(normalized)
    || segments.some((segment) => segment === '..')
  ) {
    throw new Error(`Office archive contains an unsafe path: ${path}`)
  }
  return normalized
}

function readOfficeInput(input: OfficeInput): Buffer {
  if (typeof input !== 'string') {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (buffer.byteLength > MAX_OFFICE_INPUT_BYTES) {
      throw new Error(`Office input exceeds ${MAX_OFFICE_INPUT_BYTES} bytes`)
    }
    return buffer
  }

  if (!isAbsolute(input)) {
    throw new Error('Office input path must be absolute')
  }
  const candidate = resolve(input)
  const linkStat = lstatSync(candidate)
  if (linkStat.isSymbolicLink()) {
    throw new Error('Office input path must not be a symbolic link')
  }
  const realPath = realpathSync(candidate)
  const stat = statSync(realPath)
  if (!stat.isFile()) {
    throw new Error('Office input path must be a regular file')
  }
  if (stat.size > MAX_OFFICE_INPUT_BYTES) {
    throw new Error(`Office input exceeds ${MAX_OFFICE_INPUT_BYTES} bytes`)
  }
  return readFileSync(realPath)
}

function unzipSelected(
  input: OfficeInput,
  select: (normalizedPath: string) => boolean,
): Record<string, Uint8Array> {
  const buffer = readOfficeInput(input)
  let entryCount = 0
  let expandedBytes = 0

  return unzipSync(buffer, {
    filter(info: UnzipFileInfo) {
      const normalizedPath = assertSafeArchivePath(info.name)
      entryCount += 1
      if (entryCount > MAX_OFFICE_ARCHIVE_ENTRIES) {
        throw new Error(`Office archive contains more than ${MAX_OFFICE_ARCHIVE_ENTRIES} entries`)
      }
      if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0) {
        throw new Error(`Office archive entry has an invalid size: ${info.name}`)
      }
      if (info.originalSize > MAX_OFFICE_ENTRY_BYTES) {
        throw new Error(`Office archive entry exceeds ${MAX_OFFICE_ENTRY_BYTES} bytes: ${info.name}`)
      }
      expandedBytes += info.originalSize
      if (expandedBytes > MAX_OFFICE_ARCHIVE_BYTES) {
        throw new Error(`Office archive expands beyond ${MAX_OFFICE_ARCHIVE_BYTES} bytes`)
      }
      return select(normalizedPath)
    },
  })
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractXmlTextRuns(xml: string): string[] {
  const values: string[] = []
  const regex = /<(?:[a-z]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-z]+:)?t>/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    values.push(decodeXmlEntities(match[1] ?? ''))
  }
  return values
}

function assertTextSize(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') > MAX_EXTRACTED_TEXT_BYTES) {
    throw new Error(`Extracted office text exceeds ${MAX_EXTRACTED_TEXT_BYTES} bytes`)
  }
  return text
}

export function extractDocxText(input: OfficeInput): string {
  const files = unzipSelected(input, (path) => path === 'word/document.xml')
  const documentXml = files['word/document.xml']
  if (!documentXml) return ''

  const xml = new TextDecoder().decode(documentXml)
  const paragraphs: string[] = []
  const paragraphRegex = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi
  let match: RegExpExecArray | null
  while ((match = paragraphRegex.exec(xml)) !== null) {
    const paragraph = extractXmlTextRuns(match[1] ?? '').join('').trim()
    if (paragraph) paragraphs.push(paragraph)
  }

  const text = paragraphs.length > 0
    ? paragraphs.join('\n')
    : extractXmlTextRuns(xml).join('').trim()
  return assertTextSize(text)
}

function extractSharedStrings(xml: string): string[] {
  const strings: string[] = []
  const itemRegex = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(xml)) !== null) {
    strings.push(extractXmlTextRuns(match[1] ?? '').join(''))
  }
  return strings
}

function extractSheetRows(xml: string, sharedStrings: string[]): string[] {
  const rows: string[] = []
  const rowRegex = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gi
  let rowMatch: RegExpExecArray | null

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const cells: string[] = []
    const cellRegex = /<c(\s[^>]*)?>([\s\S]*?)<\/c>/gi
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRegex.exec(rowMatch[1] ?? '')) !== null) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const type = /\bt="([^"]+)"/i.exec(attributes)?.[1]
      const rawValue = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? ''
      if (type === 's') {
        const index = Number.parseInt(rawValue, 10)
        cells.push(Number.isInteger(index) ? (sharedStrings[index] ?? '') : '')
      } else if (type === 'inlineStr') {
        cells.push(extractXmlTextRuns(body).join(''))
      } else {
        cells.push(decodeXmlEntities(rawValue))
      }
    }
    if (cells.length > 0) rows.push(cells.join('\t'))
  }

  return rows
}

export function extractXlsxText(input: OfficeInput): string {
  const files = unzipSelected(input, (path) =>
    path === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
  const sharedXml = files['xl/sharedStrings.xml']
  const sharedStrings = sharedXml
    ? extractSharedStrings(new TextDecoder().decode(sharedXml))
    : []

  const sheetPaths = Object.keys(files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((left, right) => {
      const leftIndex = Number.parseInt(/sheet(\d+)\.xml$/i.exec(left)?.[1] ?? '0', 10)
      const rightIndex = Number.parseInt(/sheet(\d+)\.xml$/i.exec(right)?.[1] ?? '0', 10)
      return leftIndex - rightIndex
    })
  const sheets = sheetPaths
    .map((path) => extractSheetRows(new TextDecoder().decode(files[path]), sharedStrings).join('\n'))
    .filter(Boolean)

  return assertTextSize(sheets.length > 0 ? sheets.join('\n\n') : sharedStrings.join('\n'))
}

export async function extractPdfText(input: OfficeInput): Promise<string> {
  const buffer = readOfficeInput(input)
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const result = await parser.getText()
    return assertTextSize(result.text)
  } finally {
    await parser.destroy()
  }
}

function isConvertibleAttachment(attachment: Attachment): 'docx' | 'xlsx' | 'pdf' | null {
  const extension = extname(attachment.filename).toLowerCase()
  if (
    attachment.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || extension === '.docx'
  ) return 'docx'
  if (
    attachment.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || extension === '.xlsx'
  ) return 'xlsx'
  if (attachment.mediaType === 'application/pdf' || extension === '.pdf') return 'pdf'
  return null
}

function assertSafeOutputPath(sourcePath: string, outputPath: string): void {
  const resolvedSource = resolve(sourcePath)
  const resolvedOutput = resolve(outputPath)
  if (dirname(resolvedSource) !== dirname(resolvedOutput)) {
    throw new Error('Extracted text path must remain beside the source attachment')
  }
  if (existsSync(resolvedOutput)) {
    const outputStat = lstatSync(resolvedOutput)
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      throw new Error('Extracted text output must be a regular file')
    }
  }
}

export async function preprocessAttachments(attachments: Attachment[]): Promise<Attachment[]> {
  const results: Attachment[] = []

  for (const attachment of attachments) {
    const kind = isConvertibleAttachment(attachment)
    if (!kind) {
      results.push(attachment)
      continue
    }

    try {
      const outputPath = `${attachment.filePath}.extracted.txt`
      assertSafeOutputPath(attachment.filePath, outputPath)
      const text = kind === 'docx'
        ? extractDocxText(attachment.filePath)
        : kind === 'xlsx'
          ? extractXlsxText(attachment.filePath)
          : await extractPdfText(attachment.filePath)
      writeFileSync(resolve(outputPath), text, { encoding: 'utf-8', flag: 'w' })
      results.push({
        filename: attachment.filename,
        mediaType: 'text/plain',
        filePath: outputPath,
      })
    } catch {
      // Preserve the original attachment when a malformed, oversized, linked,
      // or otherwise unsafe document cannot be converted.
      results.push(attachment)
    }
  }

  return results
}
