// 数字员工工作台（T-D8，商业化专属）：任务卡片 → 表单 → 派发给预置
// office-assistant 的对话流。复用 Chat 的发送链路（useChatActions + 附件上传）。
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useChatActions } from '@/hooks/useChat'
import { uploadChatAttachment, reportTelemetry } from '@/api/client'
import { useAppPreferencesStore } from '@/stores/app-preferences'
import {
  WORKBENCH_AGENT_ID,
  WORKBENCH_TASKS,
  type WorkbenchLocale,
  type WorkbenchTask,
} from '@/config/workbench-tasks'
import type { Attachment } from '@/types/attachment'

function useWorkbenchLocale(): WorkbenchLocale {
  const locale = useAppPreferencesStore((s) => s.locale)
  return locale === 'en' ? 'en' : 'zh'
}

function TaskCard({ task, locale, onSelect }: { task: WorkbenchTask; locale: WorkbenchLocale; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col items-start gap-2 rounded-2xl border-2 border-border bg-background p-5 text-left transition-all hover:border-primary/50 hover:shadow-md"
    >
      <span className="text-2xl" aria-hidden>{task.icon}</span>
      <span className="text-sm font-semibold">{task.title[locale]}</span>
      <span className="text-xs text-muted-foreground leading-relaxed">{task.desc[locale]}</span>
    </button>
  )
}

function TaskForm({ task, locale, onBack }: { task: WorkbenchTask; locale: WorkbenchLocale; onBack: () => void }) {
  const navigate = useNavigate()
  const { send } = useChatActions(WORKBENCH_AGENT_ID)
  const [values, setValues] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const canSubmit = useMemo(() => (
    task.fields.every((field) => {
      if (!field.required) return true
      if (field.kind === 'file') return !!files[field.key]
      return !!(values[field.key] ?? '').trim()
    })
  ), [task, values, files])

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError('')
    try {
      // 1) 上传附件（走既有聊天附件通道）
      const attachments: Attachment[] = []
      for (const field of task.fields) {
        if (field.kind !== 'file') continue
        const file = files[field.key]
        if (!file) continue
        attachments.push(await uploadChatAttachment(file))
      }

      // 2) 模板插值（未填的可选项替换为「未指定」）
      let prompt = task.promptTemplate[locale]
      for (const field of task.fields) {
        if (field.kind === 'file') continue
        const raw = (values[field.key] ?? '').trim()
        prompt = prompt.replaceAll(`{{${field.key}}}`, raw || (locale === 'zh' ? '未指定，请按常规处理' : 'unspecified'))
      }

      // 3) 发给数字员工并跳到对话视图
      await send(prompt, attachments.length ? attachments : undefined)
      void reportTelemetry('skill_run', { skill: task.id, ok: true })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      void reportTelemetry('skill_run', { skill: task.id, ok: false })
    }
    setSubmitting(false)
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={14} />
        {locale === 'zh' ? '返回任务列表' : 'Back'}
      </button>

      <div>
        <h3 className="text-lg font-bold flex items-center gap-2"><span aria-hidden>{task.icon}</span>{task.title[locale]}</h3>
        <p className="text-sm text-muted-foreground mt-1">{task.desc[locale]}</p>
      </div>

      <div className="space-y-4">
        {task.fields.map((field) => (
          <label key={field.key} className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {field.label[locale]}{field.required && <span className="text-destructive ml-0.5">*</span>}
            </span>
            {field.kind === 'textarea' && (
              <textarea
                className="w-full min-h-24 rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder={field.placeholder?.[locale] ?? ''}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            )}
            {field.kind === 'text' && (
              <Input
                placeholder={field.placeholder?.[locale] ?? ''}
                value={values[field.key] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              />
            )}
            {field.kind === 'file' && (
              <input
                type="file"
                accept={field.accept}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-primary hover:file:bg-primary/20"
                onChange={(e) => setFiles((prev) => ({ ...prev, [field.key]: e.target.files?.[0] ?? null }))}
              />
            )}
          </label>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button className="w-full gap-2 rounded-xl h-11" disabled={!canSubmit || submitting} onClick={handleSubmit}>
        {submitting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
        {submitting
          ? (locale === 'zh' ? '正在派发给小橘办公助理…' : 'Dispatching…')
          : (locale === 'zh' ? '交给数字员工' : 'Run with digital staff')}
      </Button>
    </div>
  )
}

export function Workbench() {
  const locale = useWorkbenchLocale()
  const [activeTask, setActiveTask] = useState<WorkbenchTask | null>(null)

  return (
    <div className="h-full overflow-y-auto p-8">
      {activeTask ? (
        <TaskForm task={activeTask} locale={locale} onBack={() => setActiveTask(null)} />
      ) : (
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div>
            <h2 className="text-xl font-bold">{locale === 'zh' ? '数字员工' : 'Digital Staff'}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {locale === 'zh'
                ? '选一个任务，填两三个空，剩下交给小橘办公助理。产出文件在工作区「办公产出」目录。'
                : 'Pick a task, fill a couple of fields, and the office assistant handles the rest.'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {WORKBENCH_TASKS.map((task) => (
              <TaskCard key={task.id} task={task} locale={locale} onSelect={() => setActiveTask(task)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
