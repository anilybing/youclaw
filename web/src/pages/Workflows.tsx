// [XJC] 工作流管理页（扣子对标 · 可见性补齐）
// 列表（步骤构成/执行员工/运行统计）→ 运行（输入表单）→ 运行历史（进度/产出/失败续跑）。
// 编辑走对话式（agent 沉淀）或 REST；本页聚焦"看得见、跑得动、失败能续"。
import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Workflow as WorkflowIcon,
  Play,
  History,
  Trash2,
  RefreshCw,
  RotateCcw,
  Loader2,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Bot,
  BrainCircuit,
  Wrench,
  Repeat2,
  GitBranch,
  Copy,
  Download,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getWorkflows,
  runWorkflow,
  deleteWorkflowById,
  getWorkflowRuns,
  getWorkflowRunDetail,
  resumeWorkflowRunById,
  approveWorkflowRunById,
  rejectWorkflowRunById,
  type WorkflowDTO,
  type WorkflowRunDTO,
} from '../api/client'
import { formatApiErrorMessage } from '../lib/api-error'
import { useI18n } from '../i18n'
import { useDragRegion } from '@/hooks/useDragRegion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
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

type WorkflowCollectionViewState = 'loading' | 'error' | 'empty' | 'content'
type LoadState = 'loading' | 'ready' | 'error'

const WORKFLOW_RUN_POLL_MS = 4_000

function resolveWorkflowCollectionViewState(
  state: LoadState,
  itemCount: number,
): WorkflowCollectionViewState {
  if (state === 'loading') return 'loading'
  if (state === 'error') return 'error'
  return itemCount === 0 ? 'empty' : 'content'
}

function hasRunningWorkflowRuns(runs: WorkflowRunDTO[]): boolean {
  return runs.some((run) => run.status === 'running' || run.status === 'awaiting_approval')
}

function canDeleteWorkflow(workflow: Pick<WorkflowDTO, 'source'>): boolean {
  return workflow.source !== 'builtin'
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

interface PipelineLabels {
  pipeline: string
  kindAgent: string
  kindLlm: string
  kindTool: string
  loop: string
  condition: string
}

function kindLabel(kind: WorkflowDTO['steps'][number]['kind'], labels: PipelineLabels): string {
  if (kind === 'tool') return labels.kindTool
  if (kind === 'llm') return labels.kindLlm
  return labels.kindAgent
}

function kindSummary(wf: WorkflowDTO, labels: PipelineLabels): string {
  const counts: Record<string, number> = {}
  for (const s of wf.steps) {
    const k = s.kind ?? 'agent'
    counts[k] = (counts[k] ?? 0) + 1
  }
  return Object.entries(counts)
    .map(([k, n]) => `${kindLabel(k as WorkflowDTO['steps'][number]['kind'], labels)}×${n}`)
    .join(' ')
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

function stepState(run: WorkflowRunDTO | null, index: number): 'done' | 'active' | 'failed' | 'pending' {
  if (!run) return 'pending'
  if (run.status === 'success') return 'done'
  if (index < run.currentStep) return 'done'
  if (index === run.currentStep) return run.status === 'failed' ? 'failed' : 'active'
  return 'pending'
}

function StepPipeline({
  workflow,
  run,
  labels,
}: {
  workflow: WorkflowDTO
  run: WorkflowRunDTO | null
  labels: PipelineLabels
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{labels.pipeline}</div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {workflow.steps.map((step, index) => {
          const kind = step.kind ?? 'agent'
          const state = stepState(run, index)
          const KindIcon = kind === 'tool' ? Wrench : kind === 'llm' ? BrainCircuit : Bot
          const StateIcon = state === 'done'
            ? CheckCircle2
            : state === 'active'
              ? Loader2
              : state === 'failed'
                ? AlertTriangle
                : Circle
          return (
            <div
              key={step.id ?? index}
              className={`min-w-44 flex-1 rounded-lg border p-2.5 ${
                state === 'active'
                  ? 'border-primary/50 bg-primary/5'
                  : state === 'failed'
                    ? 'border-destructive/40 bg-destructive/5'
                    : 'border-[var(--subtle-border)] bg-background'
              }`}
              data-testid="workflow-step-card"
            >
              <div className="flex items-start gap-2">
                <StateIcon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                  state === 'done'
                    ? 'text-emerald-500'
                    : state === 'active'
                      ? 'animate-spin text-primary'
                      : state === 'failed'
                        ? 'text-destructive'
                        : 'text-muted-foreground/40'
                }`} />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{index + 1}. {step.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                      <KindIcon className="h-2.5 w-2.5" />
                      {kindLabel(kind, labels)}
                    </span>
                    {step.tool && <code className="rounded bg-muted px-1.5 py-0.5">{step.tool}</code>}
                    {step.forEach && (
                      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                        <Repeat2 className="h-2.5 w-2.5" />{labels.loop} ≤ {step.forEach.maxItems ?? 5}
                      </span>
                    )}
                    {step.when && (
                      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                        <GitBranch className="h-2.5 w-2.5" />{labels.condition}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Workflows() {
  const { t } = useI18n()
  const location = useLocation()
  const drag = useDragRegion()
  const pipelineLabels: PipelineLabels = {
    pipeline: t.workflows.pipeline,
    kindAgent: t.workflows.kindAgent,
    kindLlm: t.workflows.kindLlm,
    kindTool: t.workflows.kindTool,
    loop: t.workflows.loop,
    condition: t.workflows.condition,
  }

  const [workflows, setWorkflows] = useState<WorkflowDTO[]>([])
  const [workflowLoadState, setWorkflowLoadState] = useState<LoadState>('loading')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [runsByWf, setRunsByWf] = useState<Record<string, WorkflowRunDTO[]>>({})
  const [runLoadStateByWf, setRunLoadStateByWf] = useState<Record<string, LoadState>>({})
  const runLoadsInFlight = useRef(new Set<string>())

  // 运行对话框
  const [runTarget, setRunTarget] = useState<WorkflowDTO | null>(null)
  const [runInputs, setRunInputs] = useState<Record<string, string>>({})
  const [isStarting, setIsStarting] = useState(false)

  // 产出查看 / 删除确认 / 续跑中
  const [outputRun, setOutputRun] = useState<WorkflowRunDTO | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkflowDTO | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const focusedRunRef = useRef('')

  const loadWorkflows = useCallback(async () => {
    setWorkflowLoadState('loading')
    try {
      const res = await getWorkflows()
      setWorkflows(res.workflows)
      setWorkflowLoadState('ready')
    } catch {
      setWorkflowLoadState('error')
    }
  }, [])

  const loadRuns = useCallback(async (wfId: string, showLoading = true) => {
    if (runLoadsInFlight.current.has(wfId)) return
    runLoadsInFlight.current.add(wfId)
    if (showLoading) {
      setRunLoadStateByWf((prev) => ({ ...prev, [wfId]: 'loading' }))
    }
    try {
      const res = await getWorkflowRuns(wfId)
      setRunsByWf((prev) => ({ ...prev, [wfId]: res.runs }))
      setOutputRun((prev) => {
        if (!prev) return prev
        return res.runs.find((run) => run.id === prev.id) ?? prev
      })
      setRunLoadStateByWf((prev) => ({ ...prev, [wfId]: 'ready' }))
    } catch {
      setRunLoadStateByWf((prev) => ({ ...prev, [wfId]: 'error' }))
    } finally {
      runLoadsInFlight.current.delete(wfId)
    }
  }, [])

  useEffect(() => {
    void loadWorkflows()
  }, [loadWorkflows])

  useEffect(() => {
    if (workflowLoadState !== 'ready') return
    const params = new URLSearchParams(location.search)
    const workflowId = params.get('workflow')
    const runId = params.get('run')
    if (!workflowId || !workflows.some((workflow) => workflow.id === workflowId)) return
    const focusKey = `${workflowId}:${runId ?? ''}`
    if (focusedRunRef.current === focusKey) return
    focusedRunRef.current = focusKey
    setExpandedId(workflowId)
    void loadRuns(workflowId)
    if (runId) {
      void getWorkflowRunDetail(runId)
        .then(({ run }) => setOutputRun(run))
        .catch(() => undefined)
    }
  }, [loadRuns, location.search, workflowLoadState, workflows])

  const expandedRuns = expandedId ? (runsByWf[expandedId] ?? []) : []
  const expandedHasRunningRun = hasRunningWorkflowRuns(expandedRuns)

  useEffect(() => {
    if (!expandedId || !expandedHasRunningRun) return
    const interval = window.setInterval(() => {
      void loadRuns(expandedId, false)
    }, WORKFLOW_RUN_POLL_MS)
    return () => window.clearInterval(interval)
  }, [expandedHasRunningRun, expandedId, loadRuns])

  const toggleExpand = (wf: WorkflowDTO) => {
    const next = expandedId === wf.id ? null : wf.id
    setExpandedId(next)
    if (next) void loadRuns(wf.id)
  }

  const openRunDialog = (wf: WorkflowDTO) => {
    setRunTarget(wf)
    setRunInputs({})
  }

  const handleStart = async () => {
    if (!runTarget || isStarting) return
    setIsStarting(true)
    try {
      const { run } = await runWorkflow(runTarget.id, runInputs)
      toast.success(t.workflows.started)
      const wfId = runTarget.id
      setRunsByWf((prev) => ({
        ...prev,
        [wfId]: [run, ...(prev[wfId] ?? []).filter((item) => item.id !== run.id)],
      }))
      setRunLoadStateByWf((prev) => ({ ...prev, [wfId]: 'ready' }))
      setRunTarget(null)
      setExpandedId(wfId)
      void loadRuns(wfId, false)
      void loadWorkflows()
    } catch (err) {
      toast.error(formatApiErrorMessage(err, t.workflows.startFailed))
    } finally {
      setIsStarting(false)
    }
  }

  const handleDelete = async (wf: WorkflowDTO) => {
    if (!canDeleteWorkflow(wf)) return
    try {
      await deleteWorkflowById(wf.id)
      toast.success(t.workflows.deleted)
      setExpandedId((prev) => (prev === wf.id ? null : prev))
      void loadWorkflows()
    } catch (err) {
      toast.error(formatApiErrorMessage(err))
    }
  }

  const handleResume = async (run: WorkflowRunDTO) => {
    if (resumingId) return
    setResumingId(run.id)
    try {
      const { run: resumedRun } = await resumeWorkflowRunById(run.id)
      toast.success(t.workflows.resumed)
      setRunsByWf((prev) => ({
        ...prev,
        [run.workflowId]: [
          resumedRun,
          ...(prev[run.workflowId] ?? []).filter((item) => item.id !== resumedRun.id),
        ],
      }))
      setRunLoadStateByWf((prev) => ({ ...prev, [run.workflowId]: 'ready' }))
      void loadRuns(run.workflowId, false)
    } catch (err) {
      toast.error(formatApiErrorMessage(err, t.workflows.resumeFailed))
    } finally {
      setResumingId(null)
    }
  }

  const handleApprove = async (run: WorkflowRunDTO) => {
    if (approvingId) return
    setApprovingId(run.id)
    try {
      const { run: approvedRun } = await approveWorkflowRunById(run.id)
      toast.success(t.workflows.approved)
      setRunsByWf((prev) => ({
        ...prev,
        [run.workflowId]: [
          approvedRun,
          ...(prev[run.workflowId] ?? []).filter((item) => item.id !== approvedRun.id),
        ],
      }))
      setRunLoadStateByWf((prev) => ({ ...prev, [run.workflowId]: 'ready' }))
      void loadRuns(run.workflowId, false)
    } catch (err) {
      toast.error(formatApiErrorMessage(err, t.workflows.approveFailed))
    } finally {
      setApprovingId(null)
    }
  }

  const handleReject = async (run: WorkflowRunDTO) => {
    if (approvingId) return
    setApprovingId(run.id)
    try {
      const { run: rejectedRun } = await rejectWorkflowRunById(run.id)
      toast.success(t.workflows.rejected)
      setRunsByWf((prev) => ({
        ...prev,
        [run.workflowId]: [
          rejectedRun,
          ...(prev[run.workflowId] ?? []).filter((item) => item.id !== rejectedRun.id),
        ],
      }))
      setRunLoadStateByWf((prev) => ({ ...prev, [run.workflowId]: 'ready' }))
      void loadRuns(run.workflowId, false)
    } catch (err) {
      toast.error(formatApiErrorMessage(err, t.workflows.rejectFailed))
    } finally {
      setApprovingId(null)
    }
  }

  const handleCopyFinal = async () => {
    const finalOutput = outputRun?.outputs.at(-1)
    if (!finalOutput) return
    await navigator.clipboard.writeText(finalOutput)
    toast.success(t.workflows.copied)
  }

  const handleDownload = () => {
    if (!outputRun) return
    const workflow = workflows.find((item) => item.id === outputRun.workflowId)
    const sections = outputRun.outputs.map((output, index) => {
      const title = workflow?.steps[index]?.title ?? t.workflows.stepLabel.replace('{n}', String(index + 1))
      return `## ${index + 1}. ${title}\n\n${output}`
    })
    const body = `# ${workflow?.name ?? outputRun.workflowId}\n\n${sections.join('\n\n')}\n`
    const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${outputRun.workflowId}-${outputRun.id.slice(0, 8)}.md`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const statusBadge = (run: WorkflowRunDTO, total: number) => {
    if (run.status === 'running') {
      return <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"><Loader2 className="h-3 w-3 animate-spin" />{t.workflows.statusRunning} {Math.min(run.currentStep, total)}/{total}</span>
    }
    if (run.status === 'success') {
      return <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">{t.workflows.statusSuccess}</span>
    }
    if (run.status === 'awaiting_approval') {
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">{t.workflows.statusAwaitingApproval} {Math.min(run.currentStep + 1, total)}/{total}</span>
    }
    return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{t.workflows.statusFailed} {Math.min(run.currentStep + 1, total)}/{total}</span>
  }

  const workflowViewState = resolveWorkflowCollectionViewState(workflowLoadState, workflows.length)
  const canDeleteTarget = deleteTarget ? canDeleteWorkflow(deleteTarget) : false
  const outputWorkflow = outputRun
    ? workflows.find((workflow) => workflow.id === outputRun.workflowId) ?? null
    : null

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* 标题栏（可拖拽区域） */}
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-[var(--subtle-border)]" {...drag}>
        <div className="flex items-center gap-2">
          <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold text-sm">{t.workflows.title}</h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          disabled={workflowLoadState === 'loading'}
          onClick={() => void loadWorkflows()}
        >
          {workflowLoadState === 'loading'
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
          {t.workflows.refresh}
        </Button>
      </div>

      {/* 说明区 */}
      <div className="px-4 py-3 border-b border-[var(--subtle-border)] bg-muted/20">
        <div className="flex items-center gap-2 text-sm font-medium">
          <WorkflowIcon className="h-4 w-4 text-muted-foreground" />
          <span>{t.workflows.subtitle}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t.workflows.hint}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {workflowViewState === 'loading' ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" data-testid="workflows-loading">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t.common.loading}
          </div>
        ) : workflowViewState === 'error' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" data-testid="workflows-error">
            <AlertTriangle className="h-10 w-10 text-destructive/60" />
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void loadWorkflows()}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t.common.retry}
            </Button>
          </div>
        ) : workflowViewState === 'empty' ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <WorkflowIcon className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">{t.workflows.empty}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {workflows.map((wf) => {
              const expanded = expandedId === wf.id
              const runs = runsByWf[wf.id] ?? []
              const runLoadState = runLoadStateByWf[wf.id] ?? 'loading'
              const runViewState = resolveWorkflowCollectionViewState(runLoadState, runs.length)
              return (
                <div key={wf.id} className="rounded-lg border border-[var(--subtle-border)] overflow-hidden">
                  <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--surface-hover)] transition-colors" data-testid="workflow-row">
                    <button onClick={() => toggleExpand(wf)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-sm">{wf.name}</span>
                          {wf.source === 'builtin' && (
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t.workflows.builtin}</span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {wf.steps.length} {t.workflows.stepsUnit} · {kindSummary(wf, pipelineLabels)} · {wf.agentId}
                          {wf.runCount > 0 && ` · ${t.workflows.ranTimes.replace('{n}', String(wf.runCount))}`}
                        </div>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openRunDialog(wf)}>
                        <Play className="h-3.5 w-3.5" />
                        {t.workflows.run}
                      </Button>
                      <button
                        onClick={() => toggleExpand(wf)}
                        className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        title={t.workflows.history}
                      >
                        <History className="h-4 w-4" />
                      </button>
                      {canDeleteWorkflow(wf) && (
                        <button
                          onClick={() => setDeleteTarget(wf)}
                          className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
                          title={t.common.delete}
                          data-testid="workflow-delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-[var(--subtle-border)] bg-muted/10 px-3 py-2">
                      {wf.description && <p className="mb-2 text-xs text-muted-foreground">{wf.description}</p>}
                      <div className="mb-3">
                        <StepPipeline workflow={wf} run={null} labels={pipelineLabels} />
                      </div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">{t.workflows.recentRuns}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={runLoadState === 'loading'}
                          onClick={() => void loadRuns(wf.id)}
                        >
                          {runLoadState === 'loading'
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <RefreshCw className="h-3 w-3" />}
                        </Button>
                      </div>
                      {runViewState === 'loading' ? (
                        <div className="flex items-center justify-center gap-1.5 py-3 text-xs text-muted-foreground" data-testid="workflow-runs-loading">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t.common.loading}
                        </div>
                      ) : runViewState === 'error' ? (
                        <div className="flex items-center justify-center gap-2 py-3" data-testid="workflow-runs-error">
                          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                          <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={() => void loadRuns(wf.id)}>
                            <RefreshCw className="h-3 w-3" />
                            {t.common.retry}
                          </Button>
                        </div>
                      ) : runViewState === 'empty' ? (
                        <p className="py-3 text-center text-xs text-muted-foreground">{t.workflows.noRuns}</p>
                      ) : (
                        <div className="space-y-1">
                          {runs.map((run) => (
                            <div key={run.id} className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 text-xs" data-testid="workflow-run-row">
                              {statusBadge(run, wf.steps.length)}
                              {run.status === 'running' && wf.steps.length > 0 && (
                                <span className="max-w-36 truncate font-medium text-primary">
                                  {t.workflows.currentStep.replace(
                                    '{name}',
                                    wf.steps[Math.min(run.currentStep, wf.steps.length - 1)]?.title ?? '-',
                                  )}
                                </span>
                              )}
                              {run.status === 'awaiting_approval' && wf.steps.length > 0 && (
                                <span
                                  className="max-w-48 truncate font-medium text-amber-600 dark:text-amber-400"
                                  title={wf.steps[Math.min(run.currentStep, wf.steps.length - 1)]?.prompt}
                                >
                                  {wf.steps[Math.min(run.currentStep, wf.steps.length - 1)]?.title ?? '-'}
                                </span>
                              )}
                              <span className="text-muted-foreground">{formatDate(run.startedAt)}</span>
                              {run.error && <span className="min-w-0 flex-1 truncate text-destructive" title={run.error}>{run.error}</span>}
                              {!run.error && <span className="flex-1" />}
                              {(run.status === 'running' || run.outputs.length > 0) && (
                                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setOutputRun(run)}>
                                  {run.status === 'running' ? t.workflows.partialOutput : t.workflows.viewOutput}
                                </Button>
                              )}
                              {run.status === 'failed' && (
                                <Button
                                  size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs"
                                  disabled={resumingId === run.id}
                                  onClick={() => void handleResume(run)}
                                >
                                  {resumingId === run.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                  {t.workflows.resume}
                                </Button>
                              )}
                              {run.status === 'awaiting_approval' && (
                                <>
                                  <Button
                                    size="sm" variant="default" className="h-6 gap-1 px-2 text-xs"
                                    disabled={approvingId === run.id}
                                    onClick={() => void handleApprove(run)}
                                  >
                                    {approvingId === run.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                    {t.workflows.approve}
                                  </Button>
                                  <Button
                                    size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs"
                                    disabled={approvingId === run.id}
                                    onClick={() => void handleReject(run)}
                                  >
                                    <X className="h-3 w-3" />
                                    {t.workflows.reject}
                                  </Button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 运行对话框：按 inputs 定义生成表单 */}
      <Dialog open={!!runTarget} onOpenChange={(open) => !open && setRunTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.workflows.runTitle.replace('{name}', runTarget?.name ?? '')}</DialogTitle>
            <DialogDescription>{t.workflows.runDesc}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {(runTarget?.inputs ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">{t.workflows.noInputs}</p>
            )}
            {(runTarget?.inputs ?? []).map((field) => (
              <div key={field.key}>
                <label className="mb-1 block text-xs font-medium">{field.label}</label>
                <Input
                  value={runInputs[field.key] ?? ''}
                  onChange={(e) => setRunInputs((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.key}
                  data-testid={`workflow-input-${field.key}`}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunTarget(null)}>{t.common.cancel}</Button>
            <Button onClick={() => void handleStart()} disabled={isStarting}>
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {t.workflows.run}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 产出查看：逐步展示 */}
      <Dialog open={!!outputRun} onOpenChange={(open) => !open && setOutputRun(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{outputWorkflow?.name ?? t.workflows.outputTitle}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <span>{formatDate(outputRun?.startedAt ?? null)}</span>
              {outputRun && outputWorkflow && statusBadge(outputRun, outputWorkflow.steps.length)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {outputWorkflow && outputRun && (
              <StepPipeline workflow={outputWorkflow} run={outputRun} labels={pipelineLabels} />
            )}

            {outputRun && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">{t.workflows.usageTitle}</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {[
                    [t.workflows.modelCalls, String(outputRun.usage.modelCalls)],
                    [t.workflows.totalTokens, outputRun.usage.totalTokens.toLocaleString()],
                    [t.workflows.cost, `$${outputRun.usage.costUsd.toFixed(4)}`],
                    [t.workflows.toolCalls, String(outputRun.usage.toolCalls)],
                    [t.workflows.duration, formatDuration(outputRun.usage.activeDurationMs)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-[var(--subtle-border)] bg-muted/10 px-2.5 py-2">
                      <div className="text-[10px] text-muted-foreground">{label}</div>
                      <div className="mt-0.5 text-xs font-semibold tabular-nums">{value}</div>
                    </div>
                  ))}
                </div>
                {outputRun.traceId && (
                  <div className="truncate font-mono text-[10px] text-muted-foreground" title={outputRun.traceId}>
                    {t.workflows.traceId}: {outputRun.traceId}
                  </div>
                )}
              </div>
            )}

            {outputRun?.error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {outputRun.error}
              </div>
            )}

            {outputRun?.status === 'running' && outputRun.outputs.length === 0 && (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.workflows.currentStep.replace(
                  '{name}',
                  outputWorkflow?.steps[Math.min(outputRun.currentStep, Math.max(0, outputWorkflow.steps.length - 1))]?.title ?? '-',
                )}
              </div>
            )}

            {(outputRun?.outputs ?? []).map((out, i) => (
              <div key={i}>
                <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span>{i + 1}. {outputWorkflow?.steps[i]?.title ?? t.workflows.stepLabel.replace('{n}', String(i + 1))}</span>
                  {outputWorkflow?.steps[i] && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal">
                      {kindLabel(outputWorkflow.steps[i].kind ?? 'agent', pipelineLabels)}
                    </span>
                  )}
                </div>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--subtle-border)] bg-muted/20 p-2 text-xs leading-relaxed">{out}</pre>
              </div>
            ))}

            {(outputRun?.outputs.length ?? 0) > 0 && (
              <div className="flex justify-end gap-2 border-t border-[var(--subtle-border)] pt-3">
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void handleCopyFinal()}>
                  <Copy className="h-3.5 w-3.5" />
                  {t.workflows.copyFinal}
                </Button>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={handleDownload}>
                  <Download className="h-3.5 w-3.5" />
                  {t.workflows.downloadMarkdown}
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={canDeleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.workflows.deleteConfirm}</AlertDialogTitle>
            <AlertDialogDescription>{deleteTarget?.name ?? ''} — {t.workflows.deleteConfirmDesc}</AlertDialogDescription>
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
