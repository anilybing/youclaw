// [XJC] 知识库页面（通用能力对齐 · T-A1）
// 上传 txt/md/pdf/docx → 文档列表（大小/分块数/时间，删除带确认）→ 搜索预览（来源+摘录）。
// 布局风格对齐 pages/Memory.tsx（标题栏 + useDragRegion），文案全部走 t.knowledge.*。
import { useState, useEffect, useCallback, useRef } from 'react'
import { BookOpen, FileText, Loader2, Search, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  getKnowledgeDocs,
  uploadKnowledgeDoc,
  deleteKnowledgeDoc,
  searchKnowledge,
  type KnowledgeDocDTO,
  type KnowledgeSearchHitDTO,
} from '../api/client'
import { formatApiErrorMessage } from '../lib/api-error'
import { useI18n } from '../i18n'
import { useDragRegion } from '@/hooks/useDragRegion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog'

const ACCEPTED_EXTENSIONS = '.txt,.md,.pdf,.docx'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(bytes / 1024, 0.1).toFixed(1)} KB`
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

export function Knowledge() {
  const { t } = useI18n()
  const drag = useDragRegion()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [docs, setDocs] = useState<KnowledgeDocDTO[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDocDTO | null>(null)
  // 拖拽上传态：dragenter/leave 成对计数，避免子元素冒泡导致高亮闪烁
  const [isDragOver, setIsDragOver] = useState(false)
  const dragDepthRef = useRef(0)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeSearchHitDTO[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const loadDocs = useCallback(() => {
    getKnowledgeDocs()
      .then((res) => setDocs(res.docs))
      .catch(() => setDocs([]))
  }, [])

  useEffect(() => {
    loadDocs()
  }, [loadDocs])

  // 输入防抖搜索：在事件处理器内调度（而非 effect 内同步 setState，规避 react-hooks/set-state-in-effect），
  // 300ms 无新输入才发请求；清空输入即清空结果。
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    const trimmed = value.trim()
    if (!trimmed) {
      setHits([])
      setIsSearching(false)
      setHasSearched(false)
      return
    }
    setIsSearching(true)
    searchTimerRef.current = setTimeout(() => {
      searchKnowledge(trimmed, 8)
        .then((res) => {
          setHits(res.hits)
          setHasSearched(true)
        })
        .catch(() => {
          setHits([])
          setHasSearched(true)
        })
        .finally(() => setIsSearching(false))
    }, 300)
  }, [])

  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  // 多文件上传（选择/拖拽共用）：逐个上传，成功/失败分别计数提示
  const handleUpload = async (files: File[]) => {
    const accepted = files.filter((f) => /\.(txt|md|pdf|docx)$/i.test(f.name))
    if (accepted.length === 0 || isUploading) return
    setIsUploading(true)
    let okCount = 0
    let firstError = ''
    for (const file of accepted) {
      try {
        await uploadKnowledgeDoc(file)
        okCount++
      } catch (err) {
        if (!firstError) firstError = formatApiErrorMessage(err, t.knowledge.uploadFailed)
      }
    }
    if (okCount > 0) {
      toast.success(accepted.length > 1 ? `${t.knowledge.uploadSuccess} (${okCount}/${accepted.length})` : t.knowledge.uploadSuccess)
      loadDocs()
    }
    if (firstError) toast.error(firstError)
    setIsUploading(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDragOver(false)
    void handleUpload(Array.from(e.dataTransfer.files || []))
  }

  const handleDelete = async (doc: KnowledgeDocDTO) => {
    try {
      await deleteKnowledgeDoc(doc.id)
      toast.success(t.knowledge.deleted)
      setDocs((prev) => prev.filter((item) => item.id !== doc.id))
      setHits((prev) => prev.filter((hit) => hit.docId !== doc.id))
    } catch (err) {
      toast.error(formatApiErrorMessage(err))
    }
  }

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        dragDepthRef.current += 1
        setIsDragOver(true)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setIsDragOver(false)
      }}
      onDrop={handleDrop}
    >
      {/* 拖拽上传遮罩 */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary/50 px-10 py-8">
            <Upload className="h-8 w-8 text-primary" />
            <p className="text-sm font-medium">{t.knowledge.dropHint}</p>
            <p className="text-xs text-muted-foreground">{t.knowledge.uploadHint}</p>
          </div>
        </div>
      )}
      {/* 标题栏（可拖拽区域，风格同 Memory.tsx） */}
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-[var(--subtle-border)]" {...drag}>
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold text-sm">{t.knowledge.title}</h2>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || [])
            e.currentTarget.value = ''
            void handleUpload(files)
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {isUploading ? t.knowledge.uploading : t.knowledge.upload}
        </Button>
      </div>

      {/* 说明区 */}
      <div className="px-4 py-3 border-b border-[var(--subtle-border)] bg-muted/20">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span>{t.knowledge.subtitle}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t.knowledge.uploadHint}</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 搜索预览 */}
        <div className="px-4 pt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={t.knowledge.searchPlaceholder}
              className="pl-9 pr-9"
              data-testid="knowledge-search-input"
            />
            {query && (
              <button
                onClick={() => handleQueryChange('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={t.common.close}
              >
                {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              </button>
            )}
          </div>

          {query.trim() && hasSearched && (
            <div className="mt-3 space-y-2" data-testid="knowledge-search-results">
              {hits.length === 0 && !isSearching ? (
                <p className="text-xs text-muted-foreground py-2 text-center">{t.knowledge.searchEmpty}</p>
              ) : (
                hits.map((hit) => (
                  <div
                    key={`${hit.docId}:${hit.chunkIndex}`}
                    className="rounded-lg border border-[var(--subtle-border)] bg-muted/10 px-3 py-2"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t.knowledge.searchSource}: {hit.docTitle}</span>
                    </div>
                    <p className="mt-1 text-xs text-foreground/80 leading-relaxed break-words">{hit.snippet}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 文档列表 */}
        <div className="px-4 py-4">
          {docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <BookOpen className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">{t.knowledge.empty}</p>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--subtle-border)] overflow-hidden">
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/20 border-b border-[var(--subtle-border)]">
                <span>{t.knowledge.docTitle}</span>
                <span className="w-20 text-right">{t.knowledge.docSize}</span>
                <span className="w-16 text-right">{t.knowledge.docChunks}</span>
                <span className="w-36 text-right">{t.knowledge.docCreatedAt}</span>
                <span className="w-8" />
              </div>
              {docs.map((doc) => (
                <div
                  key={doc.id}
                  className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center px-3 py-2.5 text-sm border-b border-[var(--subtle-border)] last:border-b-0 hover:bg-[var(--surface-hover)] transition-colors"
                  data-testid="knowledge-doc-row"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={doc.title}>{doc.title}</span>
                  </div>
                  <span className="hidden sm:block w-20 text-right text-xs text-muted-foreground tabular-nums">
                    {formatSize(doc.sizeBytes)}
                  </span>
                  <span className="hidden sm:block w-16 text-right text-xs text-muted-foreground tabular-nums">
                    {doc.chunkCount}
                  </span>
                  <span className="hidden sm:block w-36 text-right text-xs text-muted-foreground">
                    {formatDate(doc.createdAt)}
                  </span>
                  <button
                    onClick={() => setDeleteTarget(doc)}
                    className="w-8 flex justify-center text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={t.common.delete}
                    data-testid="knowledge-doc-delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.knowledge.deleteConfirm}</AlertDialogTitle>
            <AlertDialogDescription>{deleteTarget?.title ?? ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) void handleDelete(deleteTarget)
                setDeleteTarget(null)
              }}
            >
              {t.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
