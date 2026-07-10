import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import './setup.ts'
import {
  assertReadableDocumentPath,
  createDocumentTools,
  ingestDocumentAttachments,
} from '../src/agent/document-mcp.ts'
import { documentService } from '../src/document/service.ts'

const originalIngestAttachment = documentService.ingestAttachment.bind(documentService)

afterEach(() => {
  documentService.ingestAttachment = originalIngestAttachment
})

describe('ingestDocumentAttachments', () => {
  test('emits parsing and parsed status callbacks for supported document attachments', async () => {
    const callback = mock(() => {})
    documentService.ingestAttachment = mock(async () => ({
      docId: 'doc_123',
      chatId: 'chat-1',
      sourcePath: '/tmp/report.pdf',
      sourceType: 'docx' as const,
      status: 'parsed' as const,
      markdown: 'parsed text',
      text: 'parsed text',
      chunks: [],
      meta: { filename: 'report.docx', parser: 'test' },
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
    }))

    const result = await ingestDocumentAttachments('chat-1', [
      { filename: 'report.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filePath: '/tmp/report.docx' },
    ], callback)

    expect(result.parsedDocuments).toEqual([
      { docId: 'doc_123', filename: 'report.docx', status: 'parsed', error: undefined },
    ])
    expect(callback.mock.calls).toHaveLength(2)
    expect(callback.mock.calls[0]?.[0]).toEqual({
      documentId: 'pending',
      filename: 'report.docx',
      status: 'parsing',
    })
    expect(callback.mock.calls[1]?.[0]).toEqual({
      documentId: 'doc_123',
      filename: 'report.docx',
      status: 'parsed',
      error: undefined,
    })
  })

  test('passes through non-document attachments untouched', async () => {
    const result = await ingestDocumentAttachments('chat-1', [
      { filename: 'notes.txt', mediaType: 'text/plain', filePath: '/tmp/notes.txt' },
    ])

    expect(result.parsedDocuments).toEqual([])
    expect(result.remainingAttachments).toEqual([
      { filename: 'notes.txt', mediaType: 'text/plain', filePath: '/tmp/notes.txt' },
    ])
  })
})

describe('document MCP path policy', () => {
  test('allows current workspace and exact current-turn attachments only', () => {
    const root = resolve(tmpdir(), `xjc-document-policy-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    const attachments = resolve(root, 'attachments')
    const outside = resolve(root, 'outside')
    const workspaceFile = resolve(workspace, 'report.pdf')
    const attachedFile = resolve(attachments, 'current.docx')
    const siblingAttachment = resolve(attachments, 'other.docx')
    const outsideFile = resolve(outside, 'secret.xlsx')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(attachments, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(workspaceFile, 'workspace')
    writeFileSync(attachedFile, 'current')
    writeFileSync(siblingAttachment, 'sibling')
    writeFileSync(outsideFile, 'secret')

    try {
      const policy = { workspaceDir: workspace, attachmentPaths: [attachedFile] }
      expect(assertReadableDocumentPath(workspaceFile, policy)).toBe(workspaceFile)
      expect(assertReadableDocumentPath(attachedFile, policy)).toBe(attachedFile)
      expect(() => assertReadableDocumentPath(siblingAttachment, policy)).toThrow(/当前消息/)
      expect(() => assertReadableDocumentPath(outsideFile, policy)).toThrow(/当前员工工作区/)
      expect(() => assertReadableDocumentPath(resolve(outside, 'secret.txt'), policy)).toThrow(/仅支持/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('resolves junctions/symlinks before checking workspace containment', () => {
    const root = resolve(tmpdir(), `xjc-document-link-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    const outside = resolve(root, 'outside')
    const linkedDir = resolve(workspace, 'linked')
    const secret = resolve(outside, 'secret.pdf')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(secret, 'secret')

    try {
      symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => assertReadableDocumentPath(resolve(linkedDir, 'secret.pdf'), {
        workspaceDir: workspace,
        attachmentPaths: [],
      })).toThrow(/当前员工工作区/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('parse tools enforce the path policy before document ingestion', async () => {
    const root = resolve(tmpdir(), `xjc-document-tool-${process.pid}-${Date.now()}`)
    const workspace = resolve(root, 'workspace')
    const outside = resolve(root, 'outside')
    const outsidePdf = resolve(outside, 'secret.pdf')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(outsidePdf, 'not a real pdf')

    try {
      const tools = createDocumentTools('chat-policy', {
        workspaceDir: workspace,
        attachmentPaths: [],
      })
      const parse = tools.find((tool) => tool.name === 'mcp__document__parse_document')!
      await expect(parse.execute('call-1', { file_path: outsidePdf }))
        .rejects.toThrow(/当前员工工作区/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
