// 数字员工工作台（T-D8，商业化专属）：任务卡片 → 表单 → 派发给预置
// office-assistant 的对话流。复用 Chat 的发送链路（useChatActions + 附件上传）。
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Clock, Loader2, Send, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TaskDeliveryFields } from '@/components/tasks/TaskDeliveryFields'
import { isDeliveryTargetComplete, type TaskDeliveryMode } from '@/lib/task-delivery'
import { useChatActions } from '@/hooks/useChat'
import { uploadChatAttachment, reportTelemetry, createScheduledTask } from '@/api/client'
import { useAppPreferencesStore } from '@/stores/app-preferences'
import { useWorkbenchCardsStore } from '@/stores/workbench-cards'
import { useI18n } from '@/i18n'
import {
  WORKBENCH_AGENT_ID,
  WORKBENCH_TASKS,
  WORKBENCH_CRON_PRESETS,
  WORKBENCH_CATEGORIES,
  getTaskCategory,
  mergeWorkbenchTasks,
  type WorkbenchLocale,
  type WorkbenchTask,
  type WorkbenchCategoryId,
} from '@/config/workbench-tasks'
import type { Attachment } from '@/types/attachment'

/** 把任务卡表单模板插值成最终 prompt（一次性发送与定时任务共用） */
function fillPrompt(task: WorkbenchTask, locale: WorkbenchLocale, values: Record<string, string>): string {
  let prompt = task.promptTemplate[locale]
  for (const field of task.fields) {
    if (field.kind === 'file') continue
    const raw = (values[field.key] ?? '').trim()
    prompt = prompt.replaceAll(`{{${field.key}}}`, raw || (locale === 'zh' ? '未指定，请按常规处理' : 'unspecified'))
  }
  return prompt
}

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
  const { t } = useI18n()
  // 每张卡可绑定不同数字员工（电商卡→电商助理），缺省用工作台默认（办公助理）
  const agentId = task.agentId ?? WORKBENCH_AGENT_ID
  const { send, newChat } = useChatActions(agentId)
  const [values, setValues] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // T-G5：定时执行——'' 表示立即执行，否则为选中的 cron 预设 id
  const [cronPreset, setCronPreset] = useState('')
  const [scheduled, setScheduled] = useState(false)
  // 定时任务的结果投递：默认仅记录到会话，选推送时需填渠道会话 ID
  const [deliveryMode, setDeliveryMode] = useState<TaskDeliveryMode>('none')
  const [deliveryTarget, setDeliveryTarget] = useState('')

  const canSubmit = useMemo(() => (
    task.fields.every((field) => {
      if (!field.required) return true
      if (field.kind === 'file') return !!files[field.key]
      return !!(values[field.key] ?? '').trim()
    })
    && (!cronPreset || deliveryMode !== 'push' || isDeliveryTargetComplete(deliveryTarget))
  ), [task, values, files, cronPreset, deliveryMode, deliveryTarget])

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const prompt = fillPrompt(task, locale, values)

      // 定时执行：落 scheduler 持久任务，不走即时对话
      if (task.schedulable && cronPreset) {
        const preset = WORKBENCH_CRON_PRESETS.find((p) => p.id === cronPreset)
        if (!preset) throw new Error('invalid schedule preset')
        if (deliveryMode === 'push' && !isDeliveryTargetComplete(deliveryTarget)) {
          throw new Error(t.tasks.deliveryTargetRequired)
        }
        await createScheduledTask({
          agentId,
          chatId: `workbench:${task.id}`,
          prompt,
          scheduleType: 'cron',
          scheduleValue: preset.cron,
          name: `${task.title[locale]} · ${preset.label[locale]}`,
          description: locale === 'zh' ? '数字员工定时任务（工作台创建）' : 'Digital staff scheduled task',
          deliveryMode,
          deliveryTarget: deliveryMode === 'push' ? deliveryTarget.trim() : undefined,
        })
        void reportTelemetry('skill_run', { skill: task.id, ok: true, scheduled: true })
        setScheduled(true)
        setSubmitting(false)
        return
      }

      // 立即执行：上传附件 → 发给数字员工 → 跳对话视图
      const attachments: Attachment[] = []
      for (const field of task.fields) {
        if (field.kind !== 'file') continue
        const file = files[field.key]
        if (!file) continue
        attachments.push(await uploadChatAttachment(file))
      }
      // 每次派发都开一个「全新对话」再发送：避免复用当前(常是第一个)会话，
      // 否则不同任务/技能的上下文会互相污染。newChat() 把 activeChatId 置空，
      // send() 随即创建独立的新会话并绑定该数字员工。
      newChat()
      await send(prompt, attachments.length ? attachments : undefined)
      void reportTelemetry('skill_run', { skill: task.id, ok: true })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      void reportTelemetry('skill_run', { skill: task.id, ok: false })
    }
    setSubmitting(false)
  }

  if (scheduled) {
    return (
      <div className="mx-auto w-full max-w-xl space-y-5 text-center py-16">
        <div className="text-4xl" aria-hidden>⏰</div>
        <h3 className="text-lg font-bold">{locale === 'zh' ? '定时任务已创建' : 'Scheduled task created'}</h3>
        <p className="text-sm text-muted-foreground">
          {locale === 'zh'
            ? '小橘办公助理会按计划自动执行，产物放入「办公产出」目录并通知你。可在「定时任务」页查看或取消。'
            : 'The office assistant will run it on schedule. Manage it in the Cron Jobs page.'}
        </p>
        {deliveryMode === 'push' && deliveryTarget.trim() && (
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Send size={12} />
            {t.tasks.deliveryPushShort} → <span className="font-mono">{deliveryTarget.trim()}</span>
          </p>
        )}
        <div className="flex justify-center gap-3">
          <Button variant="outline" className="rounded-xl" onClick={onBack}>{locale === 'zh' ? '返回任务列表' : 'Back'}</Button>
          <Button className="rounded-xl" onClick={() => navigate('/cron')}>{locale === 'zh' ? '查看定时任务' : 'View schedule'}</Button>
        </div>
      </div>
    )
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

      {/* T-G5：可定时任务提供"定时执行"选项 */}
      {task.schedulable && (
        <div className="rounded-xl border border-border p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Clock size={14} />
            {locale === 'zh' ? '执行方式' : 'Run mode'}
          </div>
          <select
            className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={cronPreset}
            onChange={(e) => setCronPreset(e.target.value)}
          >
            <option value="">{locale === 'zh' ? '立即执行一次' : 'Run once now'}</option>
            {WORKBENCH_CRON_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {locale === 'zh' ? `定时：${preset.label.zh}` : `Schedule: ${preset.label.en}`}
              </option>
            ))}
          </select>
          {cronPreset && (
            <p className="text-xs text-muted-foreground">
              {locale === 'zh'
                ? '数字员工会按计划自动执行，附件类输入在定时模式下不生效。'
                : 'Runs automatically on schedule; file inputs are ignored in scheduled mode.'}
            </p>
          )}
          {/* 定时执行时可选：把每次运行结果推送到 IM 渠道 */}
          {cronPreset && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Send size={14} />
                {t.tasks.delivery}
              </div>
              <TaskDeliveryFields
                mode={deliveryMode}
                target={deliveryTarget}
                onModeChange={setDeliveryMode}
                onTargetChange={setDeliveryTarget}
                disabled={submitting}
              />
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button className="w-full gap-2 rounded-xl h-11" disabled={!canSubmit || submitting} onClick={handleSubmit}>
        {submitting ? <Loader2 size={16} className="animate-spin" /> : (cronPreset ? <Clock size={16} /> : <Sparkles size={16} />)}
        {submitting
          ? (locale === 'zh' ? '处理中…' : 'Working…')
          : cronPreset
            ? (locale === 'zh' ? '创建定时任务' : 'Create scheduled task')
            : (locale === 'zh' ? '交给数字员工' : 'Run with digital staff')}
      </Button>
    </div>
  )
}

function CategoryTab({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all ${
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      }`}
    >
      <span>{label}</span>
      <span className={`text-xs tabular-nums ${active ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{count}</span>
    </button>
  )
}

export function Workbench() {
  const locale = useWorkbenchLocale()
  const [activeTask, setActiveTask] = useState<WorkbenchTask | null>(null)
  const [activeCategory, setActiveCategory] = useState<'all' | WorkbenchCategoryId>('all')

  // 有效任务卡 = 内置卡 ∪ 服务端下发卡（远程同 id 覆盖、新 id 追加）。
  // 未加载或无远程卡时用内置卡（离线兜底）。
  const remoteCards = useWorkbenchCardsStore((s) => s.remoteCards)
  const cardsLoaded = useWorkbenchCardsStore((s) => s.loaded)
  const allTasks = useMemo(
    () => (cardsLoaded && remoteCards.length > 0 ? mergeWorkbenchTasks(remoteCards) : WORKBENCH_TASKS),
    [cardsLoaded, remoteCards],
  )

  const countFor = (id: WorkbenchCategoryId) =>
    allTasks.filter((task) => getTaskCategory(task) === id).length

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
                ? '选一个任务，填两三个空，剩下交给数字员工。每次派发会开一个独立对话，产出文件在对应产出目录。'
                : 'Pick a task, fill a couple of fields, and the digital staff handles the rest in a dedicated conversation.'}
            </p>
          </div>

          {/* 分类 Tab —— 按类型划分，未来新增能力自动出现在对应 tab */}
          <div className="flex flex-wrap items-center gap-2">
            <CategoryTab
              active={activeCategory === 'all'}
              label={locale === 'zh' ? '全部' : 'All'}
              count={allTasks.length}
              onClick={() => setActiveCategory('all')}
            />
            {WORKBENCH_CATEGORIES.map((cat) => (
              <CategoryTab
                key={cat.id}
                active={activeCategory === cat.id}
                label={`${cat.icon} ${cat.label[locale]}`}
                count={countFor(cat.id)}
                onClick={() => setActiveCategory(cat.id)}
              />
            ))}
          </div>

          {/* 全部：按类型分组展示；单类：平铺该类 */}
          {activeCategory === 'all' ? (
            <div className="space-y-8">
              {WORKBENCH_CATEGORIES.map((cat) => {
                const tasks = allTasks.filter((task) => getTaskCategory(task) === cat.id)
                if (tasks.length === 0) return null
                return (
                  <section key={cat.id} className="space-y-3">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                      <span aria-hidden>{cat.icon}</span>
                      {cat.label[locale]}
                      <span className="text-xs font-normal text-muted-foreground/60">{tasks.length}</span>
                    </h3>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                      {tasks.map((task) => (
                        <TaskCard key={task.id} task={task} locale={locale} onSelect={() => setActiveTask(task)} />
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {allTasks.filter((task) => getTaskCategory(task) === activeCategory).map((task) => (
                <TaskCard key={task.id} task={task} locale={locale} onSelect={() => setActiveTask(task)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
