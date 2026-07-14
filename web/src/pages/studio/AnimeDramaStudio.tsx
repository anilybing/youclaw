/**
 * AI 漫剧专用工作室（精致版）
 * 横向阶段轨 + 各阶段工作台（创意/剧本/形象/分镜/镜头/音画/成片）+ 门禁条。
 * 底层仍复用 anime-drama-studio-v1 工作流，不暴露通用节点编辑器。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  Sparkles,
  Lock,
  Unlock,
  LayoutGrid,
  ListVideo,
  AudioLines,
  Mic,
  Music,
  Captions,
  ChevronDown,
  Download,
  Clock3,
  CircleDollarSign,
  ChevronRight,
  FileUp,
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
  SCRIPT_IMPORT_ACCEPT,
  STUDIO_STAGE_ORDER,
  STEP_TO_STAGE,
  STYLE_PRESETS,
  extractMediaPaths,
  outputByStepId,
  parseScriptDoc,
  parseShotList,
  parseStillFrames,
  parseVideoPrompts,
  resolveActiveStylePresetId,
  type StudioStageId,
} from './anime-drama/parse'
import {
  RESOLUTION_PRESETS,
  analyzeLocalBrief,
  recommendStyles,
} from './anime-drama/brief'
import {
  buildDialogueTimeline,
  buildEmotionCurve,
  buildVoiceCast,
  suggestBgmMood,
  totalTimelineSeconds,
  type BgmMoodId,
  type VoiceToneId,
} from './anime-drama/audio'
import {
  CharacterScenePropTables,
  ClarificationCard,
  GateChecklist,
  LocalBriefPanel,
  ProductionLog,
  ScriptSummaryTable,
  StoryboardDetailTable,
} from './anime-drama/GuidedPanels'
import { AssetLibraryPanel, DraftExportPanel } from './anime-drama/AssetLibrary'

const SCRIPT_IMPORT_MAX_BYTES = 2 * 1024 * 1024

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
  const [episodeTitle, setEpisodeTitle] = useState('')
  const [importedFileName, setImportedFileName] = useState<string | null>(null)
  const [style, setStyle] = useState(locale === 'zh' ? '日漫' : 'Anime')
  const [episodeMins, setEpisodeMins] = useState('1')
  const [aspect, setAspect] = useState('9:16')
  const [resolution, setResolution] = useState('720p')
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
  const bibleParsed = useMemo(() => parseScriptDoc(bibleRaw), [bibleRaw])
  const bibleDoc = useMemo(() => {
    if (!scriptDoc && !bibleParsed) return null
    return {
      title: scriptDoc?.title ?? bibleParsed?.title,
      theme: scriptDoc?.theme ?? bibleParsed?.theme,
      hook: scriptDoc?.hook ?? bibleParsed?.hook,
      climax: scriptDoc?.climax ?? bibleParsed?.climax,
      cliffhanger: scriptDoc?.cliffhanger ?? bibleParsed?.cliffhanger,
      targetSeconds: scriptDoc?.targetSeconds ?? bibleParsed?.targetSeconds,
      style: scriptDoc?.style ?? bibleParsed?.style,
      characters: (bibleParsed?.characters?.length ? bibleParsed.characters : scriptDoc?.characters) ?? [],
      locations: (bibleParsed?.locations?.length ? bibleParsed.locations : scriptDoc?.locations) ?? [],
      props: (bibleParsed?.props?.length ? bibleParsed.props : scriptDoc?.props) ?? [],
      beats: scriptDoc?.beats ?? [],
      consistencyRules: bibleParsed?.consistencyRules ?? scriptDoc?.consistencyRules,
    }
  }, [scriptDoc, bibleParsed])
  const shots = useMemo(() => parseShotList(storyboardRaw), [storyboardRaw])
  const stillFrames = useMemo(() => parseStillFrames(stillsRaw), [stillsRaw])
  const localBrief = useMemo(
    () => analyzeLocalBrief(premise, episodeTitle),
    [premise, episodeTitle],
  )
  const styleRecommendations = useMemo(
    () => (localBrief ? recommendStyles(localBrief) : []),
    [localBrief],
  )
  const videoPrompts = useMemo(() => parseVideoPrompts(videoPromptsRaw), [videoPromptsRaw])
  const assetPaths = useMemo(() => extractMediaPaths(charSheetRaw), [charSheetRaw])
  const stillPaths = useMemo(() => {
    const fromFrames = stillFrames.flatMap((f) => [f.startPath, f.endPath].filter(Boolean) as string[])
    if (fromFrames.length > 0) return [...new Set(fromFrames)]
    return extractMediaPaths(stillsRaw)
  }, [stillFrames, stillsRaw])

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
      const title = episodeTitle.trim()
      const body = premise.trim()
      const premisePayload = title ? `【${title}】\n\n${body}` : body
      const { run: started } = await runWorkflow(ANIME_DRAMA_WORKFLOW_ID, {
        premise: premisePayload,
        style: style.trim() || (locale === 'zh' ? '自定义' : 'Custom'),
        episode_mins: episodeMins.trim(),
        aspect: aspect.trim() || '9:16',
        resolution: resolution.trim() || '720p',
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
                  'group relative min-w-[132px] flex-1 rounded-2xl border px-3 py-3 text-left transition-all duration-200 ease-[var(--ease-soft)]',
                  visual === 'active' && 'border-primary/50 bg-primary/10 shadow-[0_0_0_1px_oklch(0.635_0.19_50/0.2)]',
                  visual === 'gated' && 'border-amber-400/50 bg-amber-400/10',
                  visual === 'complete' && 'border-emerald-500/25 bg-emerald-500/5 hover:border-emerald-400/40',
                  visual === 'idle' && 'border-[var(--subtle-border)] bg-[var(--surface-raised)] hover:border-primary/30',
                  visual === 'locked' && 'cursor-not-allowed border-[var(--subtle-border)] bg-muted/20 opacity-55',
                  viewing === stageId && visual !== 'active' && visual !== 'gated' && visual !== 'locked' && 'ring-2 ring-primary/30',
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  {visual === 'complete' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : visual === 'gated' ? (
                    <ShieldCheck className="h-4 w-4 text-amber-300" />
                  ) : visual === 'active' ? (
                    run?.status === 'running' && stageId === pipelineStage
                      ? <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      : <Circle className="h-4 w-4 text-primary" />
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
              <GateChecklist
                copy={copy}
                stage={pipelineStage}
                scriptDoc={bibleDoc}
                shots={shots}
                stillCount={stillPaths.length}
              />
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
              episodeTitle={episodeTitle}
              setEpisodeTitle={setEpisodeTitle}
              importedFileName={importedFileName}
              setImportedFileName={setImportedFileName}
              style={style}
              setStyle={setStyle}
              episodeMins={episodeMins}
              setEpisodeMins={setEpisodeMins}
              aspect={aspect}
              setAspect={setAspect}
              resolution={resolution}
              setResolution={setResolution}
              localBrief={localBrief}
              styleRecommendations={styleRecommendations}
              canStart={canStart}
              starting={starting}
              workflowMissing={!workflow}
              onStart={() => void handleStart()}
              productionLog={
                <ProductionLog
                  copy={copy}
                  steps={steps.map((s, i) => ({ id: s.id ?? `step${i + 1}`, title: s.title }))}
                  currentStep={run?.currentStep ?? 0}
                  status={run?.status}
                />
              }
            />
          )}
          {viewing === 'script' && (
            <ScriptBench copy={copy} premise={premise} scriptDoc={scriptDoc} bibleDoc={bibleDoc} raw={scriptRaw} bibleRaw={bibleRaw} />
          )}
          {viewing === 'assets' && (
            <div className="space-y-5">
              <AssetsBench copy={copy} characters={bibleDoc?.characters ?? scriptDoc?.characters ?? []} locations={bibleDoc?.locations ?? []} props={bibleDoc?.props ?? []} paths={assetPaths} raw={charSheetRaw} gated={run?.status === 'awaiting_approval' && pipelineStage === 'assets'} />
              <AssetLibraryPanel
                copy={copy}
                runId={run?.id}
                agentId={workflow?.agentId}
                characters={bibleDoc?.characters ?? scriptDoc?.characters ?? []}
                locations={bibleDoc?.locations ?? scriptDoc?.locations ?? []}
                props={bibleDoc?.props ?? scriptDoc?.props ?? []}
                refCandidates={[...new Set([...assetPaths, ...stillPaths])]}
              />
            </div>
          )}
          {viewing === 'storyboard' && (
            <StoryboardBench copy={copy} shots={shots} stillPaths={stillPaths} locations={bibleDoc?.locations ?? scriptDoc?.locations ?? []} raw={storyboardRaw} />
          )}
          {viewing === 'clips' && (
            <ClipsBench copy={copy} prompts={videoPrompts} shots={shots} />
          )}
          {viewing === 'audio' && (
            <AudioBench
              copy={copy}
              locale={locale}
              aspect={aspect.trim() || '9:16'}
              characters={bibleDoc?.characters ?? scriptDoc?.characters ?? []}
              beats={bibleDoc?.beats ?? scriptDoc?.beats ?? []}
              shots={shots}
              raw={videoNotesRaw}
            />
          )}
          {viewing === 'final' && (
            <div className="space-y-5">
              <DraftExportPanel
                copy={copy}
                runId={run?.id}
                agentId={workflow?.agentId}
                title={episodeTitle.trim() || bibleDoc?.title || scriptDoc?.title || ''}
                aspect={aspect.trim() || '9:16'}
                resolution={resolution.trim() || '720p'}
                shots={shots}
                stillFrames={stillFrames}
                stillPaths={stillPaths}
              />
              <MarkdownBench icon={<Download className="h-4 w-4" />} title={copy.finalTitle} empty={copy.finalEmpty} body={assembleRaw || videoNotesRaw} />
            </div>
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
  episodeTitle,
  setEpisodeTitle,
  importedFileName,
  setImportedFileName,
  style,
  setStyle,
  episodeMins,
  setEpisodeMins,
  aspect,
  setAspect,
  resolution,
  setResolution,
  localBrief,
  styleRecommendations,
  canStart,
  starting,
  workflowMissing,
  onStart,
  productionLog,
}: {
  copy: Copy
  locale: string
  premise: string
  setPremise: (v: string) => void
  episodeTitle: string
  setEpisodeTitle: (v: string) => void
  importedFileName: string | null
  setImportedFileName: (v: string | null) => void
  style: string
  setStyle: (v: string) => void
  episodeMins: string
  setEpisodeMins: (v: string) => void
  aspect: string
  setAspect: (v: string) => void
  resolution: string
  setResolution: (v: string) => void
  localBrief: ReturnType<typeof analyzeLocalBrief>
  styleRecommendations: ReturnType<typeof recommendStyles>
  canStart: boolean
  starting: boolean
  workflowMissing: boolean
  onStart: () => void
  productionLog: ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const activeStyleId = resolveActiveStylePresetId(style, locale)
  const isCustomStyle = activeStyleId === 'custom'
  const charCount = [...premise].length
  const resolutionLabel =
    RESOLUTION_PRESETS.find((item) => item.id === resolution)?.[locale === 'zh' ? 'zh' : 'en'] ?? resolution

  const selectStylePreset = (preset: (typeof STYLE_PRESETS)[number]) => {
    if (preset.id === 'custom') {
      if (!isCustomStyle) setStyle('')
      return
    }
    setStyle(locale === 'zh' ? preset.zh : preset.en)
  }

  const importScriptFile = async (file: File) => {
    if (file.size > SCRIPT_IMPORT_MAX_BYTES) {
      toast.error(copy.importScriptTooLarge)
      return
    }
    try {
      let text = await file.text()
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (!text.trim()) {
        toast.error(copy.importScriptFailed)
        return
      }
      setPremise(text)
      setImportedFileName(file.name)
      if (!episodeTitle.trim()) {
        const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
        const heading = firstLine.match(/^#\s+(.+)$/)?.[1]?.trim()
        if (heading) setEpisodeTitle(heading)
      }
      toast.success(copy.importScriptSuccess)
    } catch {
      toast.error(copy.importScriptFailed)
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
      <div className="space-y-5">
        <section className="overflow-hidden rounded-[28px] border border-border/60 bg-card/50 shadow-sm">
          <div className="border-b border-border/50 bg-gradient-to-r from-sky-500/10 to-transparent px-5 py-4">
            <h2 className="text-lg font-medium">{copy.formTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{copy.formHint}</p>
          </div>
          <div className="space-y-4 p-5">
            <div>
              <label className="text-sm font-medium" htmlFor="anime-drama-episode-title">
                {copy.episodeTitleLabel}
              </label>
              <Input
                id="anime-drama-episode-title"
                className="mt-2 rounded-xl"
                value={episodeTitle}
                onChange={(e) => setEpisodeTitle(e.target.value)}
                placeholder={copy.episodeTitlePlaceholder}
              />
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-sm font-medium" htmlFor="anime-drama-premise">
                  {copy.premiseLabel}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {importedFileName && (
                    <Badge variant="secondary" className="max-w-[180px] truncate rounded-full font-normal" title={importedFileName}>
                      {copy.importedFile}: {importedFileName}
                      <button
                        type="button"
                        className="ml-1 inline-flex rounded-full p-0.5 hover:bg-background/60"
                        aria-label={copy.clearImport}
                        onClick={() => setImportedFileName(null)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => fileRef.current?.click()}
                  >
                    <FileUp className="mr-1.5 h-3.5 w-3.5" />
                    {copy.importScript}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept={SCRIPT_IMPORT_ACCEPT}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (file) void importScriptFile(file)
                    }}
                  />
                </div>
              </div>
              <Textarea
                id="anime-drama-premise"
                className="mt-2 min-h-[180px] rounded-2xl border-border/70 bg-background/40"
                value={premise}
                onChange={(e) => {
                  setPremise(e.target.value)
                  if (importedFileName) setImportedFileName(null)
                }}
                placeholder={copy.premisePlaceholder}
              />
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{copy.importScriptHint}</span>
                <span>{copy.wordCount.replace('{n}', String(charCount))}</span>
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm font-medium">{copy.styleLabel}</div>
              <div className="flex flex-wrap gap-2">
                {STYLE_PRESETS.map((preset) => {
                  const label = locale === 'zh' ? preset.zh : preset.en
                  const active = activeStyleId === preset.id
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => selectStylePreset(preset)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-sm transition-all duration-200 ease-[var(--ease-soft)]',
                        active
                          ? 'border-primary/60 bg-primary/12 font-medium text-primary'
                          : 'border-[var(--subtle-border)] bg-[var(--surface-raised)] text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {isCustomStyle && (
                <p className="mt-2 text-xs text-muted-foreground">{copy.styleCustomHint}</p>
              )}
              <Input
                className="mt-3 rounded-xl"
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                placeholder={copy.stylePlaceholder}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium" htmlFor="anime-drama-duration">
                  {copy.durationLabel}
                </label>
                <Input
                  id="anime-drama-duration"
                  className="mt-2 rounded-xl"
                  inputMode="decimal"
                  value={episodeMins}
                  onChange={(e) => setEpisodeMins(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">{copy.aspectLabel}</label>
                <div className="mt-2 flex gap-2" role="group" aria-label={copy.aspectLabel}>
                  {['9:16', '16:9', '1:1'].map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => setAspect(ratio)}
                      className={cn(
                        'flex-1 rounded-xl border py-2 text-sm font-medium transition-all duration-200 ease-[var(--ease-soft)]',
                        aspect === ratio
                          ? 'border-primary/60 bg-primary/12 text-primary'
                          : 'border-[var(--subtle-border)] bg-[var(--surface-raised)] text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                    >
                      {ratio}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">{copy.resolutionLabel}</label>
                <div className="mt-2 flex gap-2" role="group" aria-label={copy.resolutionLabel}>
                  {RESOLUTION_PRESETS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setResolution(item.id)}
                      className={cn(
                        'flex-1 rounded-xl border py-2 text-sm font-medium transition-all duration-200 ease-[var(--ease-soft)]',
                        resolution === item.id
                          ? 'border-primary/60 bg-primary/12 text-primary'
                          : 'border-[var(--subtle-border)] bg-[var(--surface-raised)] text-muted-foreground hover:border-primary/30 hover:text-foreground',
                      )}
                    >
                      {locale === 'zh' ? item.zh : item.en}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Button size="lg" className="w-full rounded-xl sm:w-auto" onClick={onStart} disabled={!canStart}>
                {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {copy.start}
              </Button>
              <p className="text-xs text-muted-foreground">{copy.startHint}</p>
              {workflowMissing && (
                <p className="text-sm text-amber-700 dark:text-amber-300">{copy.workflowMissing}</p>
              )}
            </div>
          </div>
        </section>

        {localBrief && (
          <LocalBriefPanel
            copy={copy}
            brief={localBrief}
            locale={locale}
            recommendations={styleRecommendations}
            onApplyStyle={setStyle}
          />
        )}
      </div>

      <div className="space-y-5">
        <ClarificationCard
          copy={copy}
          style={style}
          aspect={aspect}
          resolution={resolutionLabel}
          duration={episodeMins}
        />
        {productionLog}
        <aside className="rounded-[28px] border border-dashed border-border/70 bg-background/30 p-5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Film className="h-4 w-4 text-sky-600 dark:text-sky-300" />
            {copy.pipelineTitle}
          </div>
          <ol className="mt-4 space-y-3">
            {copy.pipelineBullets.map((line, index) => (
              <li key={line} className="flex gap-3 text-sm text-muted-foreground">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-xs font-medium text-sky-700 dark:bg-sky-400/10 dark:text-sky-200">
                  {index + 1}
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
          <p className="mt-5 border-t border-border/50 pt-4 text-xs leading-relaxed text-muted-foreground">
            {copy.pipelineNote}
          </p>
        </aside>
      </div>
    </div>
  )
}

function ScriptBench({
  copy,
  premise,
  scriptDoc,
  bibleDoc,
  raw,
  bibleRaw,
}: {
  copy: Copy
  premise: string
  scriptDoc: ReturnType<typeof parseScriptDoc>
  bibleDoc: ReturnType<typeof parseScriptDoc>
  raw?: string
  bibleRaw?: string
}) {
  const doc = bibleDoc ?? scriptDoc
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
          <h3 className="text-sm font-medium text-muted-foreground">{copy.scriptOutline}</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{premise || copy.scriptWaiting}</p>
        </section>
        <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
          {!doc ? (
            <EmptyState text={raw ? copy.scriptUnparsed : copy.scriptWaiting} />
          ) : (
            <ScriptSummaryTable copy={copy} doc={doc} />
          )}
          {raw && !scriptDoc && (
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl bg-black/20 p-3 text-xs text-muted-foreground">{raw}</pre>
          )}
        </section>
      </div>

      {doc && (
        <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
          <CharacterScenePropTables copy={copy} doc={doc} />
        </section>
      )}

      {scriptDoc && (
        <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium">{copy.scriptStructured}</h3>
            {scriptDoc.title && <Badge variant="secondary">{scriptDoc.title}</Badge>}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetaChip label={copy.scriptHook} value={scriptDoc.hook} />
            <MetaChip label={copy.scriptClimax} value={scriptDoc.climax} />
            <MetaChip label={copy.scriptCliff} value={scriptDoc.cliffhanger} />
          </div>
          <div className="mt-4 space-y-2">
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
          {!bibleRaw && (
            <p className="mt-3 text-xs text-muted-foreground">{copy.scriptWaiting}</p>
          )}
        </section>
      )}
    </div>
  )
}

function AssetsBench({
  copy,
  characters,
  locations,
  props,
  paths,
  raw,
  gated,
}: {
  copy: Copy
  characters: Array<{ id: string; name: string; role: string; appearance: string; personality?: string }>
  locations: Array<{ id: string; name: string; visualNotes: string; mood?: string }>
  props: Array<{ id: string; name: string; description: string }>
  paths: string[]
  raw?: string
  gated: boolean
}) {
  const tableDoc = {
    characters,
    locations,
    props,
    beats: [],
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-medium">{copy.assetsTitle}</h3>
          <p className="text-sm text-muted-foreground">{copy.assetsHint}</p>
        </div>
        <Badge className={cn('rounded-full', gated ? 'bg-amber-500/20 text-amber-800 dark:text-amber-200' : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200')}>
          {gated ? <><Unlock className="mr-1 h-3 w-3" />{copy.assetsAwaitingLock}</> : <><Lock className="mr-1 h-3 w-3" />{copy.assetsLockedHint}</>}
        </Badge>
      </div>
      {(characters.length > 0 || locations.length > 0 || props.length > 0) && (
        <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
          <CharacterScenePropTables copy={copy} doc={tableDoc} />
        </section>
      )}
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
                <p className="line-clamp-4 text-sm text-muted-foreground">{character.appearance || character.personality}</p>
              </div>
            </div>
          ))
        )}
      </div>
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
  locations,
  raw,
}: {
  copy: Copy
  shots: ReturnType<typeof parseShotList>
  stillPaths: string[]
  locations: Array<{ id: string; name: string; visualNotes?: string }>
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
          <StoryboardDetailTable copy={copy} shots={shots} locations={locations} />
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

const VOICE_TONE_LABEL: Record<VoiceToneId, keyof Copy> = {
  lead: 'audioToneLead',
  warm: 'audioToneWarm',
  cold: 'audioToneCold',
  energetic: 'audioToneEnergetic',
  serious: 'audioToneSerious',
  villain: 'audioToneVillain',
  neutral: 'audioToneNeutral',
}

const BGM_MOOD_LABEL: Record<BgmMoodId, keyof Copy> = {
  tense: 'audioBgmTense',
  warm: 'audioBgmWarm',
  sad: 'audioBgmSad',
  epic: 'audioBgmEpic',
  playful: 'audioBgmPlayful',
  calm: 'audioBgmCalm',
  neutral: 'audioBgmNeutral',
}

function AudioBench({
  copy,
  locale,
  aspect,
  characters,
  beats,
  shots,
  raw,
}: {
  copy: Copy
  locale: string
  aspect: string
  characters: Array<{ id: string; name: string; role: string; appearance: string; personality?: string }>
  beats: Array<{ beatId?: string; summary: string; dialogue?: string; emotion?: string; locationId?: string }>
  shots: ReturnType<typeof parseShotList>
  raw?: string
}) {
  const [showRaw, setShowRaw] = useState(false)
  const cast = useMemo(() => buildVoiceCast(characters, shots), [characters, shots])
  const timeline = useMemo(() => buildDialogueTimeline(shots), [shots])
  const emotionCurve = useMemo(() => buildEmotionCurve(shots, beats), [shots, beats])
  const totalSec = useMemo(() => totalTimelineSeconds(shots), [shots])
  const dialogueCues = timeline.filter((cue) => cue.dialogue)
  const toneLabel = (id: VoiceToneId) => copy[VOICE_TONE_LABEL[id]] as string
  const bgmLabel = (id: BgmMoodId) => copy[BGM_MOOD_LABEL[id]] as string

  if (cast.length === 0 && timeline.length === 0 && emotionCurve.length === 0 && !raw) {
    return <EmptyState text={copy.audioEmpty} />
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <AudioLines className="h-4 w-4 text-sky-300" />
        <h3 className="text-lg font-medium">{copy.audioTitle}</h3>
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">{copy.audioBrief}</p>

      {/* Voice cast */}
      <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Mic className="h-4 w-4 text-sky-300" />{copy.audioCastTitle}</div>
        {cast.length === 0 ? (
          <EmptyState text={copy.audioCastEmpty} />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/60">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 font-medium">{copy.tableName}</th>
                  <th className="px-3 py-2.5 font-medium">{copy.boardScene.replace(copy.boardScene, locale === 'zh' ? '定位' : 'Role')}</th>
                  <th className="px-3 py-2.5 font-medium">{copy.audioCastTone}</th>
                  <th className="px-3 py-2.5 font-medium">{copy.audioCastLines}</th>
                </tr>
              </thead>
              <tbody>
                {cast.map((row) => (
                  <tr key={row.id} className="border-t border-border/40 align-top">
                    <td className="px-3 py-2.5 font-medium">{row.name}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{row.role}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant="secondary" className="rounded-full">{toneLabel(row.toneId)}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{copy.audioCastLinesUnit.replace('{n}', String(row.lineCount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Dialogue timeline */}
      <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium"><Clock3 className="h-4 w-4 text-sky-300" />{copy.audioTimelineTitle}</div>
          {timeline.length > 0 && (
            <Badge variant="outline" className="rounded-full">
              {copy.audioTimelineTotal.replace('{sec}', String(totalSec)).replace('{shots}', String(timeline.length))}
            </Badge>
          )}
        </div>
        {timeline.length === 0 ? (
          <EmptyState text={copy.audioTimelineEmpty} />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/60">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 font-medium">{copy.audioTimelineTime}</th>
                  <th className="px-3 py-2.5 font-medium">{copy.audioTimelineShot}</th>
                  <th className="px-3 py-2.5 font-medium">{copy.audioTimelineText}</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((cue) => (
                  <tr key={cue.shotId} className="border-t border-border/40 align-top">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs text-muted-foreground">{cue.start}–{cue.end}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-medium">{cue.shotId}</td>
                    <td className="px-3 py-2.5">
                      {cue.dialogue
                        ? <span>“{cue.dialogue}”</span>
                        : <span className="text-muted-foreground">{copy.audioTimelineNoDialogue}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Emotion / score curve */}
      <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Music className="h-4 w-4 text-sky-300" />{copy.audioEmotionTitle}</div>
        {emotionCurve.length === 0 ? (
          <EmptyState text={copy.audioEmotionEmpty} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {emotionCurve.map((point, index) => {
              const mood = suggestBgmMood(point.emotion)
              return (
                <div key={`${point.label}-${index}`} className="rounded-2xl border border-border/50 bg-background/40 px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {point.at && <span className="font-mono">{point.at}</span>}
                    <span>{point.label}</span>
                  </div>
                  <div className="mt-1 text-sm font-medium">{point.emotion}</div>
                  <div className="mt-1 text-[11px] text-sky-600 dark:text-sky-300">{copy.audioBgmLabel}: {bgmLabel(mood)}</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Captions & safe area */}
      <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Captions className="h-4 w-4 text-sky-300" />{copy.audioCaptionTitle}</div>
        <p className="mb-3 rounded-2xl border border-border/50 bg-background/40 px-3 py-2 text-sm text-muted-foreground">
          {copy.audioSafeArea.replace('{aspect}', aspect)}
        </p>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          {copy.audioCaptionItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      {/* Raw AI checklist (collapsible) */}
      {raw && (
        <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 text-sm font-medium"
            onClick={() => setShowRaw((v) => !v)}
          >
            <span className="flex items-center gap-2"><AudioLines className="h-4 w-4 text-muted-foreground" />{copy.audioRawTitle}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {showRaw ? copy.audioRawHide : copy.audioRawShow}
              <ChevronDown className={cn('h-4 w-4 transition-transform', showRaw && 'rotate-180')} />
            </span>
          </button>
          {showRaw && (
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-2xl bg-black/20 p-4 text-sm leading-relaxed text-muted-foreground">{raw}</pre>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground">{dialogueCues.length > 0 ? '' : ''}</p>
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

function EmptyState({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('flex min-h-[160px] items-center justify-center rounded-[24px] border border-dashed border-border/60 bg-background/20 px-6 text-center text-sm text-muted-foreground', className)}>
      {text}
    </div>
  )
}
