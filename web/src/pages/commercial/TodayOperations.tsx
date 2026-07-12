// [XJC] “一人公司”试用入口：经营画像 + 今日自动化状态 + 可审计经营简报。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createDeliverable,
  deleteDeliverable,
  getDeliverables,
  getTodayBusinessDashboard,
  getWeeklyBusinessReview,
  runWorkflow,
  TODAY_BUSINESS_BRIEF_WORKFLOW_ID,
  updateBusinessProfile,
  updateDeliverableStatus,
  type BusinessProfileDTO,
  type DeliverableDTO,
  type DeliverableStatus,
  type TodayBusinessSnapshotDTO,
  type WeeklyBusinessReviewDTO,
} from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { formatApiError } from '@/lib/api-error'
import { notify } from '@/stores/app-runtime'
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Target,
  Workflow,
  Package,
  CalendarRange,
  Check,
  X,
  Trash2,
} from 'lucide-react'

interface ProfileDraft {
  businessName: string
  businessType: string
  offer: string
  targetCustomer: string
  channels: string
  currentGoals: string
  constraints: string
  timeZone: string
}

const EMPTY_DRAFT: ProfileDraft = {
  businessName: '',
  businessType: '',
  offer: '',
  targetCustomer: '',
  channels: '',
  currentGoals: '',
  constraints: '',
  timeZone: 'Asia/Shanghai',
}

function profileToDraft(profile: BusinessProfileDTO): ProfileDraft {
  return {
    businessName: profile.businessName,
    businessType: profile.businessType,
    offer: profile.offer,
    targetCustomer: profile.targetCustomer,
    channels: profile.channels.join('\n'),
    currentGoals: profile.currentGoals.join('\n'),
    constraints: profile.constraints,
    timeZone: profile.timeZone,
  }
}

function splitLines(value: string, max: number): string[] {
  return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))].slice(0, max)
}

export function TodayOperations() {
  const { t, locale } = useI18n()
  const navigate = useNavigate()
  const [snapshot, setSnapshot] = useState<TodayBusinessSnapshotDTO | null>(null)
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [runningBrief, setRunningBrief] = useState(false)
  const [deliverables, setDeliverables] = useState<DeliverableDTO[]>([])
  const [newDeliverableTitle, setNewDeliverableTitle] = useState('')
  const [addingDeliverable, setAddingDeliverable] = useState(false)
  const [review, setReview] = useState<WeeklyBusinessReviewDTO | null>(null)
  const [reviewBrief, setReviewBrief] = useState('')
  const [showBrief, setShowBrief] = useState(false)

  const loadDashboard = useCallback(async (preserveDraft = false) => {
    setLoadError(null)
    try {
      const next = await getTodayBusinessDashboard()
      setSnapshot(next)
      // best-effort：交付物与周复盘失败不阻断今日页
      void getDeliverables({ limit: 20 }).then((r) => setDeliverables(r.deliverables)).catch(() => {})
      void getWeeklyBusinessReview().then((r) => { setReview(r.review); setReviewBrief(r.brief) }).catch(() => {})
      if (!preserveDraft) {
        setDraft(profileToDraft(next.profile))
        setEditing(next.profile.completeness < 100)
      }
    } catch (error) {
      const formatted = formatApiError(error, t.todayOperations.loadFailed)
      setLoadError(formatted.title)
    } finally {
      setLoading(false)
    }
  }, [t.todayOperations.loadFailed])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const dateLabel = useMemo(() => {
    if (!snapshot) return ''
    const date = new Date(`${snapshot.localDate}T00:00:00`)
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(date)
  }, [locale, snapshot])

  async function handleSaveProfile() {
    setSaving(true)
    try {
      const profile = await updateBusinessProfile({
        businessName: draft.businessName,
        businessType: draft.businessType,
        offer: draft.offer,
        targetCustomer: draft.targetCustomer,
        channels: splitLines(draft.channels, 8),
        currentGoals: splitLines(draft.currentGoals, 3),
        constraints: draft.constraints,
        timeZone: draft.timeZone || 'Asia/Shanghai',
      })
      notify.success(t.todayOperations.profileSaved)
      setEditing(profile.completeness < 100)
      await loadDashboard()
    } catch (error) {
      const formatted = formatApiError(error, t.todayOperations.saveFailed)
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setSaving(false)
    }
  }

  async function handleRunBrief() {
    setRunningBrief(true)
    try {
      const { run } = await runWorkflow(TODAY_BUSINESS_BRIEF_WORKFLOW_ID, {})
      navigate(`/workflows?workflow=${TODAY_BUSINESS_BRIEF_WORKFLOW_ID}&run=${encodeURIComponent(run.id)}`)
    } catch (error) {
      const formatted = formatApiError(error, t.todayOperations.briefFailed)
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setRunningBrief(false)
    }
  }

  const refreshDeliverables = useCallback(async () => {
    try {
      const result = await getDeliverables({ limit: 20 })
      setDeliverables(result.deliverables)
    } catch {
      // 静默：交付物刷新失败不阻断经营页
    }
  }, [])

  async function handleAddDeliverable() {
    const title = newDeliverableTitle.trim()
    if (!title || addingDeliverable) return
    setAddingDeliverable(true)
    try {
      await createDeliverable({ title, type: 'other' })
      setNewDeliverableTitle('')
      await refreshDeliverables()
      notify.success(t.deliverables.added)
    } catch (error) {
      notify.error(formatApiError(error, t.deliverables.addFailed).title)
    } finally {
      setAddingDeliverable(false)
    }
  }

  async function handleSetDeliverableStatus(id: string, status: DeliverableStatus) {
    setDeliverables((prev) => prev.map((item) => (item.id === id ? { ...item, status } : item)))
    try {
      await updateDeliverableStatus(id, status)
    } catch (error) {
      notify.error(formatApiError(error, t.deliverables.updateFailed).title)
      await refreshDeliverables()
    }
  }

  async function handleDeleteDeliverable(id: string) {
    const previous = deliverables
    setDeliverables((current) => current.filter((item) => item.id !== id))
    try {
      await deleteDeliverable(id)
    } catch (error) {
      setDeliverables(previous)
      notify.error(formatApiError(error, t.deliverables.deleteFailed).title)
    }
  }

  async function handleRefreshReview() {
    try {
      const result = await getWeeklyBusinessReview()
      setReview(result.review)
      setReviewBrief(result.brief)
    } catch (error) {
      notify.error(formatApiError(error, t.weeklyReview.loadFailed).title)
    }
  }

  if (loading) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        data-testid="today-operations-loading"
        role="status"
        aria-label={t.common.loading}
      >
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (loadError || !snapshot) {
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="today-operations-error">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <AlertTriangle className="h-8 w-8 mx-auto text-amber-500" />
            <div>
              <p className="font-semibold">{t.todayOperations.loadFailed}</p>
              <p className="text-sm text-muted-foreground mt-1">{loadError}</p>
            </div>
            <Button variant="outline" onClick={() => { void loadDashboard(editing) }}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t.common.retry}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { profile, automation } = snapshot
  const topActions = snapshot.candidateActions.slice(0, 3)
  const deliverableTypeLabels: Record<DeliverableDTO['type'], string> = {
    report: t.deliverables.typeReport,
    image: t.deliverables.typeImage,
    video: t.deliverables.typeVideo,
    document: t.deliverables.typeDocument,
    notes: t.deliverables.typeNotes,
    other: t.deliverables.typeOther,
  }
  const deliverableStatusLabels: Record<DeliverableStatus, string> = {
    draft: t.deliverables.statusDraft,
    adopted: t.deliverables.statusAdopted,
    revised: t.deliverables.statusRevised,
    discarded: t.deliverables.statusDiscarded,
  }

  return (
    <div className="flex-1 overflow-auto" data-testid="today-operations-page">
      <div className="max-w-7xl mx-auto px-5 py-6 lg:px-8 space-y-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <BriefcaseBusiness className="h-4 w-4" />
              <span>{dateLabel}</span>
              <Badge variant="secondary">{t.todayOperations.localOnly}</Badge>
            </div>
            <h1 className="text-3xl font-bold tracking-tight mt-2">
              {profile.businessName
                ? t.todayOperations.greeting.replace('{name}', profile.businessName)
                : t.todayOperations.title}
            </h1>
            <p className="text-muted-foreground mt-1">{t.todayOperations.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setLoading(true); void loadDashboard() }}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t.todayOperations.refresh}
            </Button>
            <Button
              onClick={handleRunBrief}
              disabled={runningBrief}
              className="gap-2"
              data-testid="run-business-brief"
              title={t.todayOperations.modelDisclosure}
            >
              {runningBrief ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {runningBrief ? t.todayOperations.briefRunning : t.todayOperations.runBrief}
            </Button>
          </div>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t.todayOperations.workflowToday}</span>
                <Workflow className="h-4 w-4 text-primary" />
              </div>
              <div className="text-2xl font-bold mt-2">{automation.workflowRunsToday.total}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {t.todayOperations.workflowBreakdown
                  .replace('{success}', String(automation.workflowRunsToday.success))
                  .replace('{running}', String(automation.workflowRunsToday.runningNow))
                  .replace('{failed}', String(automation.workflowRunsToday.failed))}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t.todayOperations.activeAutomation}</span>
                <CalendarClock className="h-4 w-4 text-blue-500" />
              </div>
              <div className="text-2xl font-bold mt-2">{automation.scheduledTasks.active}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {automation.scheduledTasks.failing > 0
                  ? t.todayOperations.failingTasks.replace('{count}', String(automation.scheduledTasks.failing))
                  : t.todayOperations.noFailingTasks}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t.todayOperations.activePlans}</span>
                <ClipboardList className="h-4 w-4 text-violet-500" />
              </div>
              <div className="text-2xl font-bold mt-2">{automation.activePlans}</div>
              <p className="text-xs text-muted-foreground mt-1">{t.todayOperations.planHint}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t.todayOperations.aiCostToday}</span>
                <CircleDollarSign className="h-4 w-4 text-emerald-500" />
              </div>
              <div className="text-2xl font-bold mt-2">${automation.aiUsageToday.costUsd.toFixed(4)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {t.todayOperations.usageBreakdown
                  .replace('{calls}', String(automation.aiUsageToday.modelCalls))
                  .replace('{tokens}', automation.aiUsageToday.totalTokens.toLocaleString())}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" />
                {t.todayOperations.topActions}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {topActions.map((action, index) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => navigate(action.route)}
                  className="w-full text-left rounded-xl border bg-card p-4 hover:bg-accent/50 hover:border-primary/30 transition-colors group"
                  data-testid="today-action-card"
                >
                  <div className="flex items-start gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">
                      {index + 1}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold flex items-center justify-between gap-2">
                        <span>{action.title}</span>
                        <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0" />
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{action.reason}</p>
                    </div>
                  </div>
                </button>
              ))}
              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                {t.todayOperations.actionBasis}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-primary" />
                  {t.todayOperations.automationStatus}
                </span>
                <Button variant="ghost" size="sm" onClick={() => navigate('/workflows')}>
                  {t.todayOperations.viewAll}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t.todayOperations.runningWorkflows}</span>
                <Badge variant={automation.workflowRunsToday.runningNow > 0 ? 'default' : 'secondary'}>
                  {automation.workflowRunsToday.runningNow}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t.todayOperations.failedWorkflows}</span>
                <Badge variant={automation.workflowRunsToday.failed > 0 ? 'destructive' : 'secondary'}>
                  {automation.workflowRunsToday.failed}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t.todayOperations.pausedTasks}</span>
                <Badge variant="secondary">{automation.scheduledTasks.paused}</Badge>
              </div>
              <div className="border-t pt-4">
                <p className="text-muted-foreground">{t.todayOperations.nextRun}</p>
                <p className="font-medium mt-1">{automation.scheduledTasks.nextName || t.todayOperations.notScheduled}</p>
                {automation.scheduledTasks.nextRun && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
                      timeZone: snapshot.timeZone,
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZoneName: 'short',
                    }).format(new Date(automation.scheduledTasks.nextRun))}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className={profile.completeness < 100 ? 'border-amber-300/70' : ''}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                {profile.completeness === 100
                  ? <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  : <BriefcaseBusiness className="h-5 w-5 text-amber-500" />}
                {t.todayOperations.businessProfile}
              </span>
              {!editing && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  {t.common.edit}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 mb-5">
              <Progress value={profile.completeness} className="h-2 flex-1" />
              <span className="text-sm font-medium tabular-nums">{profile.completeness}%</span>
            </div>
            {editing ? (
              <div className="space-y-5" data-testid="business-profile-form">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm font-medium">
                    <span>{t.todayOperations.businessName}</span>
                    <Input
                      value={draft.businessName}
                      onChange={(event) => setDraft((current) => ({ ...current, businessName: event.target.value }))}
                      placeholder={t.todayOperations.businessNamePlaceholder}
                      maxLength={120}
                    />
                  </label>
                  <label className="space-y-2 text-sm font-medium">
                    <span>{t.todayOperations.businessType}</span>
                    <Input
                      value={draft.businessType}
                      onChange={(event) => setDraft((current) => ({ ...current, businessType: event.target.value }))}
                      placeholder={t.todayOperations.businessTypePlaceholder}
                      maxLength={120}
                    />
                  </label>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm font-medium">
                    <span>{t.todayOperations.offer}</span>
                    <Textarea
                      value={draft.offer}
                      onChange={(event) => setDraft((current) => ({ ...current, offer: event.target.value }))}
                      placeholder={t.todayOperations.offerPlaceholder}
                      maxLength={600}
                      rows={3}
                    />
                  </label>
                  <label className="space-y-2 text-sm font-medium">
                    <span>{t.todayOperations.targetCustomer}</span>
                    <Textarea
                      value={draft.targetCustomer}
                      onChange={(event) => setDraft((current) => ({ ...current, targetCustomer: event.target.value }))}
                      placeholder={t.todayOperations.targetCustomerPlaceholder}
                      maxLength={400}
                      rows={3}
                    />
                  </label>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm font-medium">
                    <span>{t.todayOperations.channels}</span>
                    <Textarea
                      value={draft.channels}
                      onChange={(event) => setDraft((current) => ({ ...current, channels: event.target.value }))}
                      placeholder={t.todayOperations.channelsPlaceholder}
                      rows={3}
                    />
                  </label>
                  <label className="space-y-2 text-sm font-medium">
                    <span>{t.todayOperations.currentGoals}</span>
                    <Textarea
                      value={draft.currentGoals}
                      onChange={(event) => setDraft((current) => ({ ...current, currentGoals: event.target.value }))}
                      placeholder={t.todayOperations.currentGoalsPlaceholder}
                      rows={3}
                    />
                  </label>
                </div>
                <label className="space-y-2 text-sm font-medium block">
                  <span>{t.todayOperations.constraints}</span>
                  <Textarea
                    value={draft.constraints}
                    onChange={(event) => setDraft((current) => ({ ...current, constraints: event.target.value }))}
                    placeholder={t.todayOperations.constraintsPlaceholder}
                    maxLength={600}
                    rows={2}
                  />
                </label>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <label className="space-y-2 text-sm font-medium sm:w-64">
                    <span>{t.todayOperations.timeZone}</span>
                    <Input
                      value={draft.timeZone}
                      onChange={(event) => setDraft((current) => ({ ...current, timeZone: event.target.value }))}
                      placeholder="Asia/Shanghai"
                      maxLength={64}
                    />
                  </label>
                  <div className="flex gap-2">
                    {profile.updatedAt && (
                      <Button
                        variant="ghost"
                        onClick={() => { setDraft(profileToDraft(profile)); setEditing(false) }}
                        disabled={saving}
                      >
                        {t.common.cancel}
                      </Button>
                    )}
                    <Button onClick={handleSaveProfile} disabled={saving}>
                      {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {saving ? t.todayOperations.saving : t.common.save}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t.todayOperations.profilePrivacy}</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">{t.todayOperations.businessType}</p>
                  <p className="text-sm font-medium mt-1">{profile.businessType}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t.todayOperations.channels}</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {profile.channels.map((channel) => <Badge variant="secondary" key={channel}>{channel}</Badge>)}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t.todayOperations.currentGoals}</p>
                  <ul className="text-sm mt-1 space-y-1">
                    {profile.currentGoals.map((goal) => <li key={goal}>• {goal}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="deliverables-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" />
              {t.deliverables.title}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t.deliverables.subtitle}</p>
            <div className="flex gap-2">
              <Input
                value={newDeliverableTitle}
                onChange={(event) => setNewDeliverableTitle(event.target.value)}
                placeholder={t.deliverables.addPlaceholder}
                maxLength={200}
                onKeyDown={(event) => { if (event.key === 'Enter') void handleAddDeliverable() }}
              />
              <Button onClick={handleAddDeliverable} disabled={addingDeliverable || !newDeliverableTitle.trim()}>
                {addingDeliverable ? <Loader2 className="h-4 w-4 animate-spin" /> : t.deliverables.add}
              </Button>
            </div>
            {deliverables.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t.deliverables.empty}</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-auto">
                {deliverables.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-lg border p-2 text-sm" data-testid="deliverable-row">
                    <Badge variant="secondary" className="shrink-0">{deliverableTypeLabels[item.type]}</Badge>
                    <span className="min-w-0 flex-1 truncate" title={item.summary ?? item.title}>{item.title}</span>
                    <Badge
                      variant={item.status === 'adopted' ? 'default' : item.status === 'discarded' ? 'secondary' : 'outline'}
                      className="shrink-0"
                    >
                      {deliverableStatusLabels[item.status]}
                    </Badge>
                    {item.status !== 'adopted' && (
                      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" title={t.deliverables.adopt} onClick={() => void handleSetDeliverableStatus(item.id, 'adopted')}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {item.status !== 'revised' && (
                      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" title={t.deliverables.revise} onClick={() => void handleSetDeliverableStatus(item.id, 'revised')}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {item.status !== 'discarded' && (
                      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" title={t.deliverables.discard} onClick={() => void handleSetDeliverableStatus(item.id, 'discarded')}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-destructive" title={t.deliverables.delete} onClick={() => void handleDeleteDeliverable(item.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="weekly-review-card">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <CalendarRange className="h-5 w-5 text-primary" />
                {t.weeklyReview.title}
              </span>
              <Button variant="ghost" size="sm" onClick={handleRefreshReview}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t.todayOperations.refresh}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {review ? (
              <>
                <p className="text-sm text-muted-foreground">{review.weekStartDate} ~ {review.weekEndDate}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <div className="text-xl font-bold">{review.deliverables.total}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.weeklyReview.deliverables}</div>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <div className="text-xl font-bold">{review.deliverables.adoptionRate}%</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.weeklyReview.adoptionRate}</div>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <div className="text-xl font-bold">{review.workflows.success}/{review.workflows.total}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.weeklyReview.workflows}</div>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-3 text-center">
                    <div className="text-xl font-bold">${review.aiUsage.costUsd.toFixed(2)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.weeklyReview.cost}</div>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowBrief((value) => !value)}>
                  {showBrief ? t.weeklyReview.hideFull : t.weeklyReview.viewFull}
                </Button>
                {showBrief && (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-xs font-sans" data-testid="weekly-review-brief">{reviewBrief}</pre>
                )}
              </>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">{t.weeklyReview.empty}</p>
            )}
          </CardContent>
        </Card>

        <div className="rounded-xl border border-blue-200/70 bg-blue-50/60 p-4 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-100">
          <p className="font-medium">{t.todayOperations.dataBoundaryTitle}</p>
          <p className="mt-1 opacity-80">{t.todayOperations.dataBoundary}</p>
          <p className="mt-1 opacity-80">{t.todayOperations.modelDisclosure}</p>
        </div>
      </div>
    </div>
  )
}
