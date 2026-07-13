/**
 * AI 漫剧专用工作室（精致版）
 * 横向阶段轨 + 各阶段工作台（创意/剧本/形象/分镜/镜头/音画/成片）+ 门禁条。
 * 底层仍复用 anime-drama-studio-v1 工作流，不暴露通用节点编辑器。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Clapperboard,
  Loader2,
  Play,
  CheckCircle2,
  Circle,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  X,
  Film,
  Users,
  MapPin,
  Sparkles,
  Lock,
  Unlock,
  LayoutGrid,
  ListVideo,
  AudioLines,
  Download,
  Clock3,
  CircleDollarSign,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  runWorkflow,
  getWorkflows,
  getWorkflowRunDetail,
  getWorkflowRuns,
  approveWorkflowRunById,
  rejectWorkflowRunById,
  type WorkflowDTO,
  type WorkflowRunDTO,
} from '@/api/client'
import { formatApiErrorMessage } from '@/lib/api-error'
import { useI18n } from '@/i18n'
import { useDragRegion } from '@/hooks/useDragRegion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  STUDIO_STAGE_ORDER,
  STEP_TO_STAGE,
  STYLE_PRESETS,
  extractMediaPaths,
  outputByStepId,
  parseScriptDoc,
  parseShotList,
  parseVideoPrompts,
  type StudioStageId,
} from './anime-drama/parse'

export const ANIME_DRAMA_WORKFLOW_ID = 'anime-drama-studio-v1'

const POLL_MS = 4_000

type StageVisual = 'idle' | 'active' | 'complete' | 'gated' | 'locked'

function resolvePipelineStage(run: WorkflowRunDTO | null, workflow: WorkflowDTO | null): StudioStageId {
  if (!run) return 'idea'
  if (run.status === 'success') return 'final'
  const stepId = workflow?.steps[run.currentStep]?.id
  if (stepId && STEP_TO_STAGE[stepId]) return STEP_TO_STAGE[stepId]
  return 'script'
}

function visualForStage(
  stageId: StudioStageId,
  pipelineStage: StudioStageId,
  run: WorkflowRunDTO | null,
): StageVisual {
  const pIdx = STUDIO_STAGE_ORDER.indexOf(pipelineStage)
  const idx = STUDIO_STAGE_ORDER.indexOf(stageId)
  // Pipeline focus wins over browsing selection — never mark two stages as "active".
  if (run?.status === 'awaiting_approval' && stageId === pipelineStage) return 'gated'
  if (idx === pIdx && (run || stageId === 'idea')) return 'active'
  if (run?.status === 'success' || idx < pIdx) return 'complete'
  if (!run && stageId === 'idea') return 'active'
  if (idx > pIdx) return 'locked'
  return 'idle'
}

function formatUsd(value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `$${value.toFixed(3)}`
}

export function AnimeDramaStudio() {
  const { t, locale } = useI18n()
  const drag = useDragRegion()
  const [params, setParams] = useSearchParams()
  const copy = t.animeDramaStudio

  const [premise, setPremise] = useState('')
  const [style, setStyle] = useState(locale === 'zh' ? '日漫' : 'Anime')
  const [episodeMins, setEpisodeMins] = useState('1')
  const [aspect, setAspect] = useState('9:16')
  const [starting, setStarting] = useState(false)
  const [workflow, setWorkflow] = useState<WorkflowDTO | null>(null)
  const [run, setRun] = useState<WorkflowRunDTO | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [acting, setActing] = useState(false)
  const [viewing, setViewing] = useState<StudioStageId>('idea')

  const pipelineStage = resolvePipelineStage(run, workflow)

  useEffect(() => {
    setViewing(pipelineStage)
  }, [pipelineStage, run?.id])

  useEffect(() => {
    void (async () => {
      try {
        const { workflows } = await getWorkflows()
        setWorkflow(workflows.find((item) => item.id === ANIME_DRAMA_WORKFLOW_ID) ?? null)
      } catch (error) {
        toast.error(formatApiErrorMessage(error, copy.loadWorkflowFailed))
      }
    })()
  }, [copy.loadWorkflowFailed])

  const refreshRun = useCallback(async (runId: string) => {
    try {
      const { run: detail } = await getWorkflowRunDetail(runId)
      setRun(detail)
      return detail
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.pollFailed))
      return null
    }
  }, [copy.pollFailed])

  useEffect(() => {
    const runId = params.get('run')
    if (!runId) return
    void refreshRun(runId)
  }, [params, refreshRun])

  useEffect(() => {
    if (!run || (run.status !== 'running' && run.status !== 'awaiting_approval')) return
    const timer = window.setInterval(() => {
      void refreshRun(run.id)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [run, refreshRun])

  const steps = workflow?.steps ?? []
  const outputs = run?.outputs ?? []
  const scriptRaw = outputByStepId(steps, outputs, 'script')
  const bibleRaw = outputByStepId(steps, outputs, 'bible')
  const charSheetRaw = outputByStepId(steps, outputs, 'char_sheet')
  const storyboardRaw = outputByStepId(steps, outputs, 'storyboard')
  const stillsRaw = outputByStepId(steps, outputs, 'stills')
  const videoPromptsRaw = outputByStepId(steps, outputs, 'video_prompts')
  const videoNotesRaw = outputByStepId(steps, outputs, 'video_notes')
  const assembleRaw = outputByStepId(steps, outputs, 'assemble')

  const scriptDoc = useMemo(() => parseScriptDoc(scriptRaw), [scriptRaw])
  const bibleDoc = useMemo(() => parseScriptDoc(bibleRaw) ?? scriptDoc, [bibleRaw, scriptDoc])
  const shots = useMemo(() => parseShotList(storyboardRaw), [storyboardRaw])
  const videoPrompts = useMemo(() => parseVideoPrompts(videoPromptsRaw), [videoPromptsRaw])
  const assetPaths = useMemo(() => extractMediaPaths(charSheetRaw), [charSheetRaw])
  const stillPaths = useMemo(() => extractMediaPaths(stillsRaw), [stillsRaw])

  const progressPct = useMemo(() => {
    if (!run || steps.length === 0) return 0
    if (run.status === 'success') return 100
    return Math.min(99, Math.round((run.currentStep / steps.length) * 100))
  }, [run, steps.length])

  const canStart = premise.trim().length >= 8 && !starting && !!workflow
  const currentStep = steps[Math.min(run?.currentStep ?? 0, Math.max(0, steps.length - 1))]

  const handleStart = async () => {
    if (!canStart) return
    setStarting(true)
    try {
      const { run: started } = await runWorkflow(ANIME_DRAMA_WORKFLOW_ID, {
        premise: premise.trim(),
        style: style.trim(),
        episode_mins: episodeMins.trim(),
        aspect: aspect.trim() || '9:16',
      })
      setRun(started)
      setParams({ run: started.id })
      setViewing('script')
      toast.success(copy.started)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.startFailed))
    } finally {
      setStarting(false)
    }
  }

  const handleApprove = async () => {
    if (!run || acting) return
    setActing(true)
    try {
      const { run: next } = await approveWorkflowRunById(run.id)
      setRun(next)
      toast.success(copy.approved)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.approveFailed))
    } finally {
      setActing(false)
    }
  }

  const handleReject = async () => {
    if (!run || acting) return
    setActing(true)
    try {
      const { run: next } = await rejectWorkflowRunById(run.id, rejectReason.trim() || copy.defaultRejectReason)
      setRun(next)
      toast.success(copy.rejected)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.rejectFailed))
    } finally {
      setActing(false)
    }
  }

  const loadLatest = async () => {
    try {
      const { runs } = await getWorkflowRuns(ANIME_DRAMA_WORKFLOW_ID)
      if (runs[0]) {
        setRun(runs[0])
        setParams({ run: runs[0].id })
      } else {
        toast.message(copy.noRuns)
      }
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.pollFailed))
    }
  }

  const selectStage = (stageId: StudioStageId, visual: StageVisual) => {
    if (visual === 'locked') return
    setViewing(stageId)
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,_rgba(56,189,248,0.08),_transparent_55%),radial-gradient(ellipse_at_bottom_right,_rgba(251,146,60,0.06),_transparent_45%)]">
      {/* Header */}
      <div className="relative border-b border-border/50 px-6 py-4 backdrop-blur-sm" {...drag}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400/20 to-orange-300/20 ring-1 ring-white/10">
            <Clapperboard className="h-5 w-5 text-sky-300" />
          </div>
          <div className="min-w-[220px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
              <Badge variant="secondary" className="rounded-full">{aspect.trim() || '9:16'}</Badge>
              {run && (
                <Badge
                  className={cn(
                    'rounded-full',
                    run.status === 'awaiting_approval' && 'bg-amber-500/20 text-amber-200',
                    run.status === 'running' && 'bg-sky-500/20 text-sky-200',
                    run.status === 'success' && 'bg-emerald-500/20 text-emerald-200',
                    run.status === 'failed' && 'bg-destructive/20 text-destructive',
                  )}
                >
                  {run.status === 'running'
                    ? copy.statusRunning
                    : run.status === 'awaiting_approval'
                      ? copy.statusGated
                      : run.status === 'success'
                        ? copy.statusSuccess
                        : copy.statusFailed}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{copy.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadLatest()}>{copy.loadLatest}</Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/workflows?workflow=${encodeURIComponent(ANIME_DRAMA_WORKFLOW_ID)}${run ? `&run=${encodeURIComponent(run.id)}` : ''}`}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {copy.openWorkflow}
              </Link>
            </Button>
          </div>
        </div>

        {/* Overview metrics */}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" />{copy.metricProgress}</span>
              <span>{progressPct}%</span>
            </div>
            <Progress value={progressPct} className="h-1.5" />
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">{copy.metricGate}</div>
            <div className="mt-1 truncate text-sm font-medium">
              {run?.status === 'awaiting_approval'
                ? (currentStep?.title ?? copy.gateTitle)
                : run
                  ? (copy.stages[pipelineStage].title)
                  : copy.metricGateIdle}
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">{copy.metricCost}</div>
            <div className="mt-1 flex items-center gap-3 text-sm font-medium">
              <span className="inline-flex items-center gap-1"><CircleDollarSign className="h-3.5 w-3.5 text-orange-300" />{formatUsd(run?.usage?.costUsd)}</span>
              <span className="inline-flex items-center gap-1 text-muted-foreground"><Clock3 className="h-3.5 w-3.5" />{run ? `${Math.round((run.usage?.activeDurationMs ?? 0) / 1000)}s` : '—'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stage rail */}
      <div className="border-b border-border/40 px-4 py-3">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {STUDIO_STAGE_ORDER.map((stageId, index) => {
            const visual = visualForStage(stageId, pipelineStage, run)
            const meta = copy.stages[stageId]
            return (
              <button
                key={stageId}
                type="button"
                disabled={visual === 'locked'}
                onClick={() => selectStage(stageId, visual)}
                className={cn(
                  'group relative min-w-[132px] flex-1 rounded-2xl border px-3 py-3 text-left transition-all duration-200',
                  visual === 'active' && 'border-sky-400/50 bg-sky-400/10 shadow-[0_0_0_1px_rgba(56,189,248,0.15)]',
                  visual === 'gated' && 'border-amber-400/50 bg-amber-400/10',
                  visual === 'complete' && 'border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-400/40',
                  visual === 'idle' && 'border-border/70 bg-card/30 hover:border-border',
                  visual === 'locked' && 'cursor-not-allowed border-border/40 bg-muted/20 opacity-55',
                  viewing === stageId && visual !== 'active' && visual !== 'gated' && visual !== 'locked' && 'ring-2 ring-sky-400/35',
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  {visual === 'complete' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : visual === 'gated' ? (
                    <ShieldCheck className="h-4 w-4 text-amber-300" />
                  ) : visual === 'active' ? (
                    run?.status === 'running' && stageId === pipelineStage
                      ? <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
                      : <Circle className="h-4 w-4 text-sky-300" />
                  ) : visual === 'locked' ? (
                    <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                </div>
                <div className="text-sm font-medium">{meta.title}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">{meta.description}</p>
                {index < STUDIO_STAGE_ORDER.length - 1 && (
                  <ChevronRight className="pointer-events-none absolute -right-1 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-muted-foreground/40 lg:block" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Gate sticky */}
      {run?.status === 'awaiting_approval' && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{copy.gateTitle} · {currentStep?.title}</div>
              <p className="mt-1 text-sm text-muted-foreground">{currentStep?.prompt || copy.gateHint}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  className="max-w-md bg-background/50"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder={copy.rejectPlaceholder}
                />
                <Button size="sm" onClick={() => void handleApprove()} disabled={acting}>
                  <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                  {copy.approve}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void handleReject()} disabled={acting}>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  {copy.reject}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stage workspace */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-5">
          {viewing === 'idea' && (
            <IdeaBench
              copy={copy}
              locale={locale}
              premise={premise}
              setPremise={setPremise}
              style={style}
              setStyle={setStyle}
              episodeMins={episodeMins}
              setEpisodeMins={setEpisodeMins}
              aspect={aspect}
              setAspect={setAspect}
              canStart={canStart}
              starting={starting}
              workflowMissing={!workflow}
              onStart={() => void handleStart()}
            />
          )}
          {viewing === 'script' && (
            <ScriptBench copy={copy} premise={premise} scriptDoc={scriptDoc} raw={scriptRaw} bibleRaw={bibleRaw} />
          )}
          {viewing === 'assets' && (
            <AssetsBench copy={copy} characters={bibleDoc?.characters ?? scriptDoc?.characters ?? []} locations={bibleDoc?.locations ?? []} paths={assetPaths} raw={charSheetRaw} gated={run?.status === 'awaiting_approval' && pipelineStage === 'assets'} />
          )}
          {viewing === 'storyboard' && (
            <StoryboardBench copy={copy} shots={shots} stillPaths={stillPaths} raw={storyboardRaw} />
          )}
          {viewing === 'clips' && (
            <ClipsBench copy={copy} prompts={videoPrompts} shots={shots} />
          )}
          {viewing === 'audio' && (
            <MarkdownBench icon={<AudioLines className="h-4 w-4" />} title={copy.audioTitle} empty={copy.audioEmpty} body={videoNotesRaw} />
          )}
          {viewing === 'final' && (
            <MarkdownBench icon={<Download className="h-4 w-4" />} title={copy.finalTitle} empty={copy.finalEmpty} body={assembleRaw || videoNotesRaw} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

type Copy = ReturnType<typeof useI18n>['t']['animeDramaStudio']

function IdeaBench({
  copy,
  locale,
  premise,
  setPremise,
  style,
  setStyle,
  episodeMins,
  setEpisodeMins,
  aspect,
  setAspect,
  canStart,
  starting,
  workflowMissing,
  onStart,
}: {
  copy: Copy
  locale: string
  premise: string
  setPremise: (v: string) => void
  style: string
  setStyle: (v: string) => void
  episodeMins: string
  setEpisodeMins: (v: string) => void
  aspect: string
  setAspect: (v: string) => void
  canStart: boolean
  starting: boolean
  workflowMissing: boolean
  onStart: () => void
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
      <section className="overflow-hidden rounded-[28px] border border-border/60 bg-card/50 shadow-sm">
        <div className="border-b border-border/50 bg-gradient-to-r from-sky-500/10 to-transparent px-5 py-4">
          <h2 className="text-lg font-medium">{copy.formTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.formHint}</p>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <label className="text-sm font-medium">{copy.premiseLabel}</label>
            <Textarea
              className="mt-2 min-h-[160px] rounded-2xl border-border/70 bg-background/40"
              value={premise}
              onChange={(e) => setPremise(e.target.value)}
              placeholder={copy.premisePlaceholder}
            />
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">{copy.styleLabel}</div>
            <div className="flex flex-wrap gap-2">
              {STYLE_PRESETS.map((preset) => {
                const label = locale === 'zh' ? preset.zh : preset.en
                const active = style === label || style === preset.zh || style === preset.en
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setStyle(label)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-sm transition-colors',
                      active
                        ? 'border-sky-400/60 bg-sky-400/15 text-sky-100'
                        : 'border-border/70 bg-background/30 text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            <Input className="mt-3 rounded-xl" value={style} onChange={(e) => setStyle(e.target.value)} placeholder={copy.stylePlaceholder} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">{copy.durationLabel}</label>
              <Input className="mt-2 rounded-xl" value={episodeMins} onChange={(e) => setEpisodeMins(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium">{copy.aspectLabel}</label>
              <div className="mt-2 flex gap-2">
                {['9:16', '16:9', '1:1'].map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => setAspect(ratio)}
                    className={cn(
                      'flex-1 rounded-xl border py-2 text-sm',
                      aspect === ratio ? 'border-sky-400/60 bg-sky-400/15' : 'border-border/70 bg-background/30',
                    )}
                  >
                    {ratio}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Button size="lg" className="rounded-xl" onClick={onStart} disabled={!canStart}>
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {copy.start}
          </Button>
          {workflowMissing && <p className="text-sm text-amber-300">{copy.workflowMissing}</p>}
        </div>
      </section>

      <aside className="rounded-[28px] border border-dashed border-border/70 bg-background/30 p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Film className="h-4 w-4 text-sky-300" />
          {copy.pipelineTitle}
        </div>
        <ol className="mt-4 space-y-3">
          {copy.pipelineBullets.map((line, index) => (
            <li key={line} className="flex gap-3 text-sm text-muted-foreground">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-400/10 text-xs text-sky-200">{index + 1}</span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  )
}

function ScriptBench({
  copy,
  premise,
  scriptDoc,
  raw,
  bibleRaw,
}: {
  copy: Copy
  premise: string
  scriptDoc: ReturnType<typeof parseScriptDoc>
  raw?: string
  bibleRaw?: string
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_240px]">
      <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
        <h3 className="text-sm font-medium text-muted-foreground">{copy.scriptOutline}</h3>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{premise || copy.scriptWaiting}</p>
      </section>
      <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">{copy.scriptStructured}</h3>
          {scriptDoc?.title && <Badge variant="secondary">{scriptDoc.title}</Badge>}
        </div>
        {!scriptDoc ? (
          <EmptyState text={raw ? copy.scriptUnparsed : copy.scriptWaiting} />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <MetaChip label={copy.scriptHook} value={scriptDoc.hook} />
              <MetaChip label={copy.scriptClimax} value={scriptDoc.climax} />
              <MetaChip label={copy.scriptCliff} value={scriptDoc.cliffhanger} />
            </div>
            <div className="space-y-2">
              {scriptDoc.beats.map((beat, index) => (
                <div key={beat.beatId ?? index} className="rounded-2xl border border-border/50 bg-background/30 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>BEAT {index + 1}</span>
                    {beat.emotion && <Badge variant="outline" className="rounded-full text-[10px]">{beat.emotion}</Badge>}
                  </div>
                  <div className="mt-1 text-sm font-medium">{beat.summary}</div>
                  {beat.dialogue && <p className="mt-1 text-sm text-muted-foreground">“{beat.dialogue}”</p>}
                </div>
              ))}
            </div>
          </div>
        )}
        {raw && !scriptDoc && (
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl bg-black/20 p-3 text-xs text-muted-foreground">{raw}</pre>
        )}
      </section>
      <aside className="space-y-3">
        <SideBlock icon={<Users className="h-3.5 w-3.5" />} title={copy.scriptCharacters}>
          {(scriptDoc?.characters ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{copy.scriptWaiting}</p>
          ) : (
            scriptDoc!.characters.map((c) => (
              <div key={c.id} className="rounded-xl border border-border/50 px-3 py-2">
                <div className="text-sm font-medium">{c.name}</div>
                <div className="text-[11px] text-muted-foreground">{c.role}</div>
              </div>
            ))
          )}
        </SideBlock>
        <SideBlock icon={<MapPin className="h-3.5 w-3.5" />} title={copy.scriptLocations}>
          {(scriptDoc?.locations ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{bibleRaw ? copy.scriptUnparsed : copy.scriptWaiting}</p>
          ) : (
            scriptDoc!.locations.map((l) => (
              <div key={l.id} className="rounded-xl border border-border/50 px-3 py-2">
                <div className="text-sm font-medium">{l.name}</div>
                <div className="line-clamp-2 text-[11px] text-muted-foreground">{l.visualNotes}</div>
              </div>
            ))
          )}
        </SideBlock>
      </aside>
    </div>
  )
}

function AssetsBench({
  copy,
  characters,
  locations,
  paths,
  raw,
  gated,
}: {
  copy: Copy
  characters: Array<{ id: string; name: string; role: string; appearance: string; personality?: string }>
  locations: Array<{ id: string; name: string; visualNotes: string }>
  paths: string[]
  raw?: string
  gated: boolean
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-medium">{copy.assetsTitle}</h3>
          <p className="text-sm text-muted-foreground">{copy.assetsHint}</p>
        </div>
        <Badge className={cn('rounded-full', gated ? 'bg-amber-500/20 text-amber-200' : 'bg-emerald-500/15 text-emerald-200')}>
          {gated ? <><Unlock className="mr-1 h-3 w-3" />{copy.assetsAwaitingLock}</> : <><Lock className="mr-1 h-3 w-3" />{copy.assetsLockedHint}</>}
        </Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {characters.length === 0 && !raw ? (
          <EmptyState text={copy.assetsEmpty} className="md:col-span-2 xl:col-span-3" />
        ) : (
          characters.map((character, index) => (
            <div key={character.id} className="overflow-hidden rounded-[24px] border border-border/60 bg-card/50">
              <div className="relative flex h-40 items-center justify-center bg-gradient-to-br from-sky-500/15 via-transparent to-orange-400/10">
                <Users className="h-10 w-10 text-sky-200/70" />
                <Badge className="absolute left-3 top-3 rounded-full bg-black/40">{character.role}</Badge>
                {paths[index] && (
                  <Badge variant="secondary" className="absolute bottom-3 left-3 right-3 truncate rounded-full text-[10px]">
                    {paths[index]}
                  </Badge>
                )}
              </div>
              <div className="space-y-2 p-4">
                <div className="text-base font-medium">{character.name}</div>
                <p className="line-clamp-3 text-sm text-muted-foreground">{character.appearance || character.personality}</p>
              </div>
            </div>
          ))
        )}
      </div>
      {locations.length > 0 && (
        <div>
          <h4 className="mb-3 text-sm font-medium">{copy.assetsLocations}</h4>
          <div className="grid gap-3 md:grid-cols-3">
            {locations.map((location) => (
              <div key={location.id} className="rounded-2xl border border-border/50 bg-background/30 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium"><MapPin className="h-3.5 w-3.5" />{location.name}</div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{location.visualNotes}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {raw && characters.length === 0 && (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-2xl border border-border/50 bg-black/20 p-4 text-xs text-muted-foreground">{raw}</pre>
      )}
    </div>
  )
}

function StoryboardBench({
  copy,
  shots,
  stillPaths,
  raw,
}: {
  copy: Copy
  shots: ReturnType<typeof parseShotList>
  stillPaths: string[]
  raw?: string
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <LayoutGrid className="h-4 w-4 text-sky-300" />
        <h3 className="text-lg font-medium">{copy.boardTitle}</h3>
        <Badge variant="secondary" className="rounded-full">{shots.length || 0} shots</Badge>
      </div>
      {shots.length === 0 ? (
        <>
          <EmptyState text={raw ? copy.boardUnparsed : copy.boardEmpty} />
          {raw && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-2xl border border-border/50 bg-black/20 p-4 text-xs text-muted-foreground">{raw}</pre>}
        </>
      ) : (
        <>
          <div className="overflow-hidden rounded-[24px] border border-border/60">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">{copy.boardShot}</th>
                  <th className="px-4 py-3 font-medium">{copy.boardDuration}</th>
                  <th className="px-4 py-3 font-medium">{copy.boardCamera}</th>
                  <th className="px-4 py-3 font-medium">{copy.boardPrompt}</th>
                </tr>
              </thead>
              <tbody>
                {shots.map((shot) => (
                  <tr key={shot.shotId} className="border-t border-border/40 align-top">
                    <td className="px-4 py-3 text-muted-foreground">{shot.index}</td>
                    <td className="px-4 py-3 font-medium">{shot.shotId}</td>
                    <td className="px-4 py-3">{shot.durationSec}s</td>
                    <td className="px-4 py-3 text-muted-foreground">{[shot.shotSize, shot.cameraMove].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="line-clamp-2 max-w-xl">{shot.visualPrompt}</div>
                      {shot.dialogue && <div className="mt-1 text-xs text-muted-foreground">“{shot.dialogue}”</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h4 className="mb-3 text-sm font-medium">{copy.boardStills}</h4>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {shots.slice(0, 8).map((shot, index) => (
                <div key={shot.shotId} className="overflow-hidden rounded-2xl border border-border/50 bg-card/40">
                  <div className="flex h-28 items-center justify-center bg-gradient-to-br from-orange-400/10 to-sky-400/10">
                    <Film className="h-6 w-6 text-muted-foreground/70" />
                  </div>
                  <div className="space-y-1 p-3">
                    <div className="text-sm font-medium">{shot.shotId}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{stillPaths[index] || copy.boardStillPending}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ClipsBench({
  copy,
  prompts,
  shots,
}: {
  copy: Copy
  prompts: ReturnType<typeof parseVideoPrompts>
  shots: ReturnType<typeof parseShotList>
}) {
  const items = prompts.length > 0
    ? prompts
    : shots.map((shot) => ({
        shotId: shot.shotId,
        durationSec: shot.durationSec,
        i2vPrompt: shot.visualPrompt,
        cameraMove: shot.cameraMove,
      }))

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <ListVideo className="h-4 w-4 text-sky-300" />
        <h3 className="text-lg font-medium">{copy.clipsTitle}</h3>
      </div>
      {items.length === 0 ? (
        <EmptyState text={copy.clipsEmpty} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <div key={item.shotId} className="rounded-[24px] border border-border/60 bg-card/50 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="font-medium">{item.shotId}</div>
                <Badge variant="outline" className="rounded-full">{item.durationSec ? `${item.durationSec}s` : 'I2V'}</Badge>
              </div>
              <div className="mb-3 flex h-28 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/10 to-orange-400/10">
                <Play className="h-7 w-7 text-sky-200/80" />
              </div>
              <p className="line-clamp-4 text-sm text-muted-foreground">{item.i2vPrompt}</p>
              {item.cameraMove && <div className="mt-2 text-xs text-muted-foreground">{copy.boardCamera}: {item.cameraMove}</div>}
              {'riskNotes' in item && item.riskNotes && (
                <div className="mt-2 text-xs text-amber-300">{item.riskNotes}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MarkdownBench({
  icon,
  title,
  empty,
  body,
}: {
  icon: React.ReactNode
  title: string
  empty: string
  body?: string
}) {
  return (
    <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
      <div className="mb-4 flex items-center gap-2 text-lg font-medium">{icon}{title}</div>
      {!body ? (
        <EmptyState text={empty} />
      ) : (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-2xl bg-black/20 p-4 text-sm leading-relaxed text-muted-foreground">{body}</pre>
      )}
    </section>
  )
}

function MetaChip({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-2xl border border-border/50 bg-background/30 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 line-clamp-3 text-sm">{value || '—'}</div>
    </div>
  )
}

function SideBlock({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[22px] border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{icon}{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function EmptyState({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('flex min-h-[160px] items-center justify-center rounded-[24px] border border-dashed border-border/60 bg-background/20 px-6 text-center text-sm text-muted-foreground', className)}>
      {text}
    </div>
  )
}
