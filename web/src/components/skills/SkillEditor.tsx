import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createSkill,
  deleteManagedSkill,
  discardSkillDraft,
  getAgents,
  getSkillDraft,
  publishSkill,
  saveSkillDraft,
  validateSkillDraft,
  type ManagedSkillDetail,
  type SkillAuthoringDraft,
  type SkillValidationResult,
} from '@/api/client'
import { AuthoringShell, ConfirmDestructiveDialog } from '@/components/skills/authoring-shell'
import { MarkdownAuthoringEditor } from '@/components/skills/MarkdownAuthoringEditor'
import { Field, SectionCard } from '@/components/skills/authoring-shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { bumpDraftVersion, normalizeSlug, stringifySkillMarkdownLocal } from '@/components/skills/authoring-helpers'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { notify } from '@/stores/app'
import { CheckCircle2, PencilLine, Rocket, Trash2 } from 'lucide-react'

interface SkillEditorProps {
  mode: 'create' | 'edit'
  skillName?: string | null
  onBack: () => void
  onSkillSelected: (name: string | null) => void
  onSkillsChanged: () => void
}

type BindingViewState = 'bound' | 'wildcard' | 'unbound'
type BindingRow = {
  id: string
  name: string
  state: 'bound' | 'bound_via_wildcard' | 'unbound'
  selected: boolean
}

function resolveBindingViewState(binding: BindingRow): BindingViewState {
  if (binding.state === 'bound_via_wildcard') return 'wildcard'
  return binding.selected ? 'bound' : 'unbound'
}

function createEmptyDraft(locale: 'en' | 'zh'): SkillAuthoringDraft {
  const content = locale === 'zh'
    ? `# 技能目标

# 适用场景

# 执行要求
`
    : `# Goal

# When to Use

# Execution Rules
`

  return {
    frontmatter: {
      name: '',
      description: '',
      version: '1',
    },
    content,
    rawMarkdown: '',
  }
}

function resolveSelectedBindingIds(detail: ManagedSkillDetail | null) {
  return (detail?.bindingStates ?? [])
    .filter((binding) => binding.state !== 'unbound')
    .map((binding) => binding.id)
}

export function SkillEditor({ mode, skillName, onBack, onSkillSelected, onSkillsChanged }: SkillEditorProps) {
  const { t, locale } = useI18n()
  const [detail, setDetail] = useState<ManagedSkillDetail | null>(null)
  const [draft, setDraft] = useState<SkillAuthoringDraft>(createEmptyDraft(locale))
  const [, setValidation] = useState<SkillValidationResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [activeSkillName, setActiveSkillName] = useState<string | null>(mode === 'edit' ? (skillName ?? null) : null)
  const [selectedBindingIds, setSelectedBindingIds] = useState<string[]>([])
  const [bindingSearchQuery, setBindingSearchQuery] = useState('')

  useEffect(() => {
    setActiveSkillName(mode === 'edit' ? (skillName ?? null) : null)
  }, [mode, skillName])

  useEffect(() => {
    getAgents()
      .then((items) => {
        setAvailableAgents(items.map((agent) => ({ id: agent.id, name: agent.name })))
      })
      .catch(() => {
        setAvailableAgents([])
      })
  }, [])

  const initializeDraft = useCallback((nextDraft: SkillAuthoringDraft, options?: { markDirty?: boolean }) => {
    setDraft({
      ...nextDraft,
      rawMarkdown: nextDraft.rawMarkdown || stringifySkillMarkdownLocal(nextDraft.frontmatter, nextDraft.content),
    })
    setValidation(null)
    setDirty(Boolean(options?.markDirty))
  }, [])

  const initializeCreateState = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      initializeDraft(createEmptyDraft(locale), { markDirty: false })
      setDetail(null)
      setSelectedBindingIds([])
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }, [initializeDraft, locale])

  const loadSkill = useCallback(async (nextSkillName: string) => {
    setLoading(true)
    setError('')
    try {
      const next = await getSkillDraft(nextSkillName)
      const initialDraft = next.draft ?? (next.publishedDraft
        ? {
            ...next.publishedDraft,
            frontmatter: {
              ...next.publishedDraft.frontmatter,
              version: bumpDraftVersion(next.publishedDraft.frontmatter.version),
            },
            rawMarkdown: '',
          }
        : {
            frontmatter: { name: next.skill.name, description: next.skill.description ?? '', version: '1' },
            content: '',
            rawMarkdown: '',
          })

      initializeDraft(initialDraft, { markDirty: false })
      setDetail(next)
      setSelectedBindingIds(resolveSelectedBindingIds(next))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }, [initializeDraft])

  useEffect(() => {
    if (activeSkillName) {
      void loadSkill(activeSkillName)
      return
    }
    void initializeCreateState()
  }, [activeSkillName, initializeCreateState, loadSkill])

  const formatSkillMessage = useCallback((template: string, skillLabel: string) => (
    template.replace('{name}', skillLabel)
  ), [])
  const getOperationErrorMessage = useCallback((error: unknown, fallback: string) => {
    if (error instanceof Error && error.message) {
      return error.message
    }
    return fallback
  }, [])

  const frontmatter = draft.frontmatter
  const isCreateMode = !activeSkillName
  const bindingRows = useMemo<BindingRow[]>(() => {
    const detailById = new Map((detail?.bindingStates ?? []).map((binding) => [binding.id, binding]))
    const selectedSet = new Set(selectedBindingIds)
    const agentMap = new Map(availableAgents.map((agent) => [agent.id, agent.name]))

    for (const binding of detail?.bindingStates ?? []) {
      if (!agentMap.has(binding.id)) {
        agentMap.set(binding.id, binding.name)
      }
    }

    const base = Array.from(agentMap.entries()).map(([id, name]) => {
      const detailBinding = detailById.get(id)
      const state = detailBinding?.state ?? 'unbound'
      return {
        id,
        name: detailBinding?.name ?? name,
        state,
        selected: state === 'bound_via_wildcard' || selectedSet.has(id),
      }
    })

    return base.sort((left, right) => left.name.localeCompare(right.name))
  }, [availableAgents, detail?.bindingStates, selectedBindingIds])

  const visibleBindingRows = useMemo(() => {
    const query = bindingSearchQuery.trim().toLowerCase()

    return bindingRows.filter((binding) => {
      if (!query) return true

      return binding.name.toLowerCase().includes(query)
    })
  }, [bindingRows, bindingSearchQuery])

  const updateFrontmatter = useCallback(<K extends keyof SkillAuthoringDraft['frontmatter']>(key: K, value: SkillAuthoringDraft['frontmatter'][K]) => {
    setDraft((current) => {
      const nextFrontmatter = {
        ...current.frontmatter,
        [key]: value,
      }
      return {
        ...current,
        frontmatter: nextFrontmatter,
        rawMarkdown: stringifySkillMarkdownLocal(nextFrontmatter, current.content),
      }
    })
    setValidation(null)
    setDirty(true)
  }, [])

  const updateContent = useCallback((value: string) => {
    setDraft((current) => ({
      ...current,
      content: value,
      rawMarkdown: stringifySkillMarkdownLocal(current.frontmatter, value),
    }))
    setValidation(null)
    setDirty(true)
  }, [])

  const buildValidationPayload = useCallback(() => ({
    mode: 'form' as const,
    draft,
  }), [draft])

  const validateCurrentDraft = useCallback(async () => {
    const currentName = normalizeSlug(draft.frontmatter.name || activeSkillName || 'draft') || 'draft'
    const nextValidation = await validateSkillDraft(currentName, buildValidationPayload())
    setValidation(nextValidation)
    return nextValidation
  }, [activeSkillName, buildValidationPayload, draft.frontmatter.name])

  const ensureSkillProject = useCallback(async () => {
    if (activeSkillName) {
      return activeSkillName
    }

    const bootstrapValidation = await validateCurrentDraft()
    const bootstrapDraft = bootstrapValidation.draft
    const nextName = bootstrapDraft?.frontmatter.name?.trim()

    if (!bootstrapDraft || !nextName) {
      throw new Error(bootstrapValidation.errors[0]?.message ?? t.skills.fieldName)
    }

    const created = await createSkill({
      name: nextName,
      description: bootstrapDraft.frontmatter.description ?? '',
      locale,
    })

    setDetail(created)
    setActiveSkillName(created.skill.name)
    onSkillSelected(created.skill.name)
    onSkillsChanged()
    return created.skill.name
  }, [activeSkillName, locale, onSkillSelected, onSkillsChanged, t.skills.fieldName, validateCurrentDraft])

  const handleSaveDraft = useCallback(async ({ showToast = true }: { showToast?: boolean } = {}) => {
    const creatingSkill = !activeSkillName
    setSaving(true)
    setError('')
    try {
      const persistedSkillName = await ensureSkillProject()
      const response = await saveSkillDraft(persistedSkillName, buildValidationPayload())
      setDetail(response)
      setValidation(response.validation)
      if (response.validation.draft) {
        initializeDraft(response.validation.draft, { markDirty: false })
      } else {
        setDirty(false)
      }
      onSkillsChanged()
      if (showToast) {
        if (creatingSkill) {
          notify.success(formatSkillMessage(t.skills.skillCreateSuccess, response.skill.name))
        } else {
          notify.success(t.skills.draftSaveSuccess)
        }
      }
      return response
    } catch (nextError) {
      const fallback = creatingSkill
        ? formatSkillMessage(t.skills.skillCreateFailed, draft.frontmatter.name?.trim() || t.skills.newSkill)
        : t.skills.draftSaveFailed
      const message = getOperationErrorMessage(nextError, fallback)
      setError(message)
      if (showToast) {
        notify.error(message)
      }
      throw nextError
    } finally {
      setSaving(false)
    }
  }, [
    activeSkillName,
    buildValidationPayload,
    draft.frontmatter.name,
    ensureSkillProject,
    formatSkillMessage,
    getOperationErrorMessage,
    initializeDraft,
    onSkillsChanged,
    t.skills.draftSaveFailed,
    t.skills.draftSaveSuccess,
    t.skills.newSkill,
    t.skills.skillCreateFailed,
    t.skills.skillCreateSuccess,
  ])

  const handlePublish = useCallback(async () => {
    setPublishing(true)
    setError('')
    try {
      let nextSkillName = activeSkillName
      if (dirty || !nextSkillName) {
        const saved = await handleSaveDraft({ showToast: false })
        nextSkillName = saved.skill.name
      }
      if (!nextSkillName) {
        throw new Error(t.skills.publishBeforeBind)
      }

      const published = await publishSkill(nextSkillName, {
        bindingAgentIds: bindingRows
          .filter((binding) => binding.state === 'bound_via_wildcard' || selectedBindingIds.includes(binding.id))
          .map((binding) => binding.id),
      })

      setDetail(published)
      setSelectedBindingIds(resolveSelectedBindingIds(published))
      onSkillsChanged()

      setActiveSkillName(published.skill.name)
      onSkillSelected(published.skill.name)
      await loadSkill(published.skill.name)
      notify.success(formatSkillMessage(t.skills.skillPublishSuccess, published.skill.name))
    } catch (nextError) {
      const message = getOperationErrorMessage(nextError, t.skills.skillPublishFailed)
      setError(message)
      notify.error(message)
    } finally {
      setPublishing(false)
    }
  }, [
    activeSkillName,
    bindingRows,
    dirty,
    getOperationErrorMessage,
    handleSaveDraft,
    loadSkill,
    formatSkillMessage,
    onSkillSelected,
    onSkillsChanged,
    selectedBindingIds,
    t.skills.publishBeforeBind,
    t.skills.skillPublishFailed,
    t.skills.skillPublishSuccess,
  ])

  const handleDiscardDraft = useCallback(async () => {
    if (!activeSkillName) {
      initializeDraft(createEmptyDraft(locale), { markDirty: false })
      return
    }

    try {
      const discarded = await discardSkillDraft(activeSkillName)
      setDetail(discarded)
      setSelectedBindingIds(resolveSelectedBindingIds(discarded))
      const baseDraft = discarded.publishedDraft
        ? {
            ...discarded.publishedDraft,
            frontmatter: {
              ...discarded.publishedDraft.frontmatter,
              version: bumpDraftVersion(discarded.publishedDraft.frontmatter.version),
            },
            rawMarkdown: '',
          }
        : createEmptyDraft(locale)
      initializeDraft(baseDraft, { markDirty: false })
      setValidation(null)
      onSkillsChanged()
      notify.success(t.skills.draftDiscardSuccess)
    } catch (nextError) {
      const message = getOperationErrorMessage(nextError, t.skills.draftDiscardFailed)
      setError(message)
      notify.error(message)
    }
  }, [activeSkillName, getOperationErrorMessage, initializeDraft, locale, onSkillsChanged, t.skills.draftDiscardFailed, t.skills.draftDiscardSuccess])

  const handleDelete = useCallback(async () => {
    if (!activeSkillName) {
      onSkillSelected(null)
      onBack()
      return
    }

    setDeleting(true)
    try {
      await deleteManagedSkill(activeSkillName)
      setDeleteOpen(false)
      onSkillsChanged()
      onSkillSelected(null)
      onBack()
      notify.success(formatSkillMessage(t.skills.skillDeleteSuccess, activeSkillName))
    } catch (nextError) {
      const message = getOperationErrorMessage(
        nextError,
        formatSkillMessage(t.skills.skillDeleteFailed, activeSkillName),
      )
      setError(message)
      notify.error(message)
    } finally {
      setDeleting(false)
    }
  }, [activeSkillName, formatSkillMessage, getOperationErrorMessage, onBack, onSkillSelected, onSkillsChanged, t.skills.skillDeleteFailed, t.skills.skillDeleteSuccess])

  const handleDraftBindingToggle = useCallback((agentId: string, checked: boolean) => {
    setSelectedBindingIds((current) => {
      if (checked) {
        return current.includes(agentId) ? current : [...current, agentId]
      }
      return current.filter((item) => item !== agentId)
    })
    setDirty(true)
  }, [])

  const handleBack = useCallback(() => {
    if (dirty) {
      setLeaveOpen(true)
      return
    }
    onBack()
  }, [dirty, onBack])

  const titleStatus = isCreateMode || dirty || detail?.skill.hasDraft
    ? {
        icon: <PencilLine className="h-4 w-4" />,
        className: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      }
    : {
        icon: <CheckCircle2 className="h-4 w-4" />,
        className: 'border-green-500/30 bg-green-500/10 text-green-300',
      }

  const headerTitle = isCreateMode
    ? t.skills.createSkillTitle
    : (detail?.skill.name ?? activeSkillName ?? t.skills.editSkillTitle)
  const headerDescription = isCreateMode
    ? undefined
    : (frontmatter.description || detail?.skill.description || t.skills.builderEditHint)

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t.common.loading}</div>
  }

  return (
    <AuthoringShell
      onBack={handleBack}
      backLabel={t.common.back}
      title={headerTitle}
      titleLeading={(
        <div className={`flex h-8 w-8 items-center justify-center rounded-full border ${titleStatus.className}`}>
          {titleStatus.icon}
        </div>
      )}
      description={headerDescription}
      actions={(
        <>
          {(dirty || detail?.skill.hasDraft) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleDiscardDraft()}
            >
              <PencilLine className="h-4 w-4" />
              {t.skills.discardDraft}
            </Button>
          )}
          {!isCreateMode && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t.skills.deleteSkill}
            </Button>
          )}
          <Button size="sm" onClick={() => void handlePublish()} disabled={saving || publishing}>
            <Rocket className="h-4 w-4" />
            {saving || publishing ? t.skills.publishing : t.skills.publish}
          </Button>
        </>
      )}
      error={error}
      steps={[]}
      onStepSelect={() => {}}
      stepsContent={<></>}
      overlays={(
        <>
          <ConfirmDestructiveDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={t.common.delete}
            description={isCreateMode ? t.skills.leaveBuilderDesc : t.skills.confirmDeleteManagedSkill}
            cancelLabel={t.common.cancel}
            confirmLabel={deleting ? t.skills.deleting : t.common.delete}
            busy={deleting}
            onConfirm={() => {
              void handleDelete()
            }}
          />
          <ConfirmDestructiveDialog
            open={leaveOpen}
            onOpenChange={setLeaveOpen}
            title={t.skills.leaveBuilderTitle}
            description={t.skills.leaveBuilderDesc}
            cancelLabel={t.skills.stayEditing}
            confirmLabel={t.skills.discardAndBack}
            onConfirm={() => {
              setLeaveOpen(false)
              onBack()
            }}
          />
        </>
      )}
    >
      <div className="space-y-6">
        <SectionCard>
          <div className="space-y-4">
            <Field label={t.skills.fieldName} required>
              <Input
                value={frontmatter.name}
                onChange={(event) => updateFrontmatter('name', event.target.value)}
                className="shadow-none"
              />
            </Field>
            <Field label={t.skills.fieldDescription} required>
              <Textarea
                rows={3}
                value={frontmatter.description}
                onChange={(event) => updateFrontmatter('description', event.target.value)}
                className="min-h-[72px] resize-y shadow-none"
              />
            </Field>
          </div>
        </SectionCard>

        <MarkdownAuthoringEditor
          title={t.skills.skillDetails}
          value={draft.content}
          onChange={updateContent}
        />

        <SectionCard title={t.skills.stageBindingTitle} titleClassName="text-base font-semibold">
          {bindingRows.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
              {t.skills.bindingEmpty}
            </div>
          )}
          {bindingRows.length > 0 && (
            <div className="space-y-3">
              <div>
                <Input
                  value={bindingSearchQuery}
                  onChange={(event) => setBindingSearchQuery(event.target.value)}
                  placeholder={t.skills.bindingSearchPlaceholder}
                  className="h-9 w-full max-w-md shadow-none"
                />
              </div>

              {visibleBindingRows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">
                  {t.skills.bindingNoResults}
                </div>
              ) : (
                <div className="rounded-[24px] border border-border/60 bg-background/80">
                  <div className="max-h-72 overflow-y-auto">
                    <div className="divide-y divide-border/50">
                      {visibleBindingRows.map((binding) => {
                        const bindingViewState = resolveBindingViewState(binding)
                        return (
                          <div
                            key={binding.id}
                            role={bindingViewState === 'wildcard' ? 'group' : 'button'}
                            tabIndex={bindingViewState === 'wildcard' ? -1 : 0}
                            className={cn(
                              'flex items-start gap-3 px-4 py-3 transition-colors',
                              bindingViewState === 'wildcard'
                                ? 'cursor-default'
                                : 'cursor-pointer hover:bg-muted/35',
                            )}
                            onClick={() => {
                              if (bindingViewState === 'wildcard') return
                              handleDraftBindingToggle(binding.id, !binding.selected)
                            }}
                            onKeyDown={(event) => {
                              if (bindingViewState === 'wildcard') return
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                handleDraftBindingToggle(binding.id, !binding.selected)
                              }
                            }}
                          >
                            <Checkbox
                              checked={binding.selected}
                              disabled={bindingViewState === 'wildcard'}
                              tabIndex={-1}
                              className="pointer-events-none mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{binding.name}</span>
                                <Badge variant={bindingViewState === 'unbound' ? 'outline' : 'secondary'}>
                                  {bindingViewState === 'wildcard'
                                    ? t.skills.boundViaWildcard
                                    : bindingViewState === 'bound'
                                      ? t.skills.bound
                                      : t.skills.unbound}
                                </Badge>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      </div>
    </AuthoringShell>
  )
}
