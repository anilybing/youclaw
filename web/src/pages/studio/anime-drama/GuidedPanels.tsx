/**
 * 漫剧工作室引导组件：概要表、风格推荐、需求澄清、产线叙事、门禁确认明细。
 * 对标「同对话逐步引导 + 表格明细」体验，但落在阶段工作室而非聊天流。
 */
import type { ReactNode } from 'react'
import { CheckCircle2, Circle, Loader2, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  estimateStepSeconds,
  type LocalScriptBrief,
  type StyleRecommendation,
} from './brief'
import type { ParsedScript, ParsedShot } from './parse'
import type { StudioStageId } from './parse'

type Copy = {
  briefTitle: string
  briefTheme: string
  briefScenes: string
  briefCharacters: string
  briefPlot: string
  briefActs: string
  briefLocalHint: string
  briefPipelineHint: string
  styleRecTitle: string
  styleRecRank: string
  styleRecName: string
  styleRecReason: string
  styleRecTop: string
  styleRecApply: string
  clarifyTitle: string
  clarifyStyle: string
  clarifyAspect: string
  clarifyResolution: string
  clarifyDuration: string
  clarifyAnswered: string
  progressTitle: string
  progressEta: string
  progressDone: string
  progressActive: string
  progressPending: string
  progressWaiting: string
  gateChecklistTitle: string
  gateCheckAssets: string
  gateCheckBoard: string
  gateCheckVideo: string
  gateCheckScript: string
  tableIndex: string
  tableName: string
  tableDesc: string
  tableIntro: string
  charListTitle: string
  sceneListTitle: string
  propListTitle: string
  boardGroup: string
  boardScene: string
  boardEmotion: string
  boardText: string
  summaryTitle: string
}

function DetailTable({
  headers,
  rows,
  empty,
}: {
  headers: string[]
  rows: ReactNode[][]
  empty?: string
}) {
  if (rows.length === 0) {
    return empty ? (
      <p className="rounded-2xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
        {empty}
      </p>
    ) : null
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-3 py-2.5 font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border/40 align-top">
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function LocalBriefPanel({
  copy,
  brief,
  locale,
  recommendations,
  onApplyStyle,
}: {
  copy: Copy
  brief: LocalScriptBrief
  locale: string
  recommendations: StyleRecommendation[]
  onApplyStyle: (name: string) => void
}) {
  const summaryRows: ReactNode[][] = [
    [<span className="text-muted-foreground">{copy.briefTheme}</span>, brief.theme],
    [<span className="text-muted-foreground">{copy.briefScenes}</span>, brief.scenes.join('；')],
    [<span className="text-muted-foreground">{copy.briefCharacters}</span>, brief.characters.join('；')],
    [<span className="text-muted-foreground">{copy.briefPlot}</span>, brief.corePlot],
    [
      <span className="text-muted-foreground">{copy.briefActs}</span>,
      <ol className="list-decimal space-y-1 pl-4">
        {brief.acts.map((act) => (
          <li key={act}>{act}</li>
        ))}
      </ol>,
    ],
  ]

  return (
    <div className="space-y-4 rounded-[24px] border border-border/60 bg-card/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{copy.briefTitle}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {brief.confidence === 'high' ? copy.briefPipelineHint : copy.briefLocalHint}
          </p>
        </div>
        <Badge variant="secondary" className="rounded-full">
          {brief.title}
        </Badge>
      </div>
      <DetailTable headers={['', '']} rows={summaryRows} />
      <div>
        <h4 className="mb-2 text-sm font-medium">{copy.styleRecTitle}</h4>
        <DetailTable
          headers={[copy.styleRecRank, copy.styleRecName, copy.styleRecReason, '']}
          rows={recommendations.map((item) => {
            const name = locale === 'zh' ? item.nameZh : item.nameEn
            const reason = locale === 'zh' ? item.reasonZh : item.reasonEn
            return [
              item.rank === 1 ? (
                <Badge className="rounded-full bg-sky-500/15 text-sky-800 dark:text-sky-100">
                  {copy.styleRecTop}
                </Badge>
              ) : (
                String(item.rank)
              ),
              name,
              <span className="text-muted-foreground">{reason}</span>,
              <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={() => onApplyStyle(name)}>
                {copy.styleRecApply}
              </Button>,
            ]
          })}
        />
      </div>
    </div>
  )
}

export function ClarificationCard({
  copy,
  style,
  aspect,
  resolution,
  duration,
}: {
  copy: Copy
  style: string
  aspect: string
  resolution: string
  duration: string
}) {
  const items = [
    { label: copy.clarifyStyle, value: style || '—' },
    { label: copy.clarifyAspect, value: aspect || '—' },
    { label: copy.clarifyResolution, value: resolution || '—' },
    { label: copy.clarifyDuration, value: duration ? `${duration} min` : '—' },
  ]
  return (
    <div className="rounded-[24px] border border-border/60 bg-muted/20 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="h-4 w-4 text-sky-600 dark:text-sky-300" />
        {copy.clarifyAnswered}
      </div>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={item.label} className="rounded-2xl border border-border/50 bg-background/50 px-3 py-2.5">
            <div className="text-xs text-muted-foreground">
              {index + 1} {item.label}
            </div>
            <div className="mt-1 text-sm font-medium">{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProductionLog({
  copy,
  steps,
  currentStep,
  status,
}: {
  copy: Copy
  steps: Array<{ id: string; title: string }>
  currentStep: number
  status: string | undefined
}) {
  if (!status || steps.length === 0) {
    return (
      <div className="rounded-[24px] border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
        {copy.progressWaiting}
      </div>
    )
  }
  return (
    <div className="rounded-[24px] border border-border/60 bg-card/40 p-4">
      <h3 className="mb-3 text-sm font-medium">{copy.progressTitle}</h3>
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const done =
            status === 'success' ||
            (status !== 'failed' && index < currentStep) ||
            (status === 'awaiting_approval' && index < currentStep)
          const active =
            (status === 'running' || status === 'awaiting_approval') && index === currentStep
          return (
            <li
              key={step.id}
              className={cn(
                'flex items-start gap-3 rounded-2xl border px-3 py-2.5 text-sm',
                active && 'border-sky-400/50 bg-sky-400/10',
                done && !active && 'border-emerald-500/20 bg-emerald-500/5',
                !done && !active && 'border-border/40 bg-background/20 text-muted-foreground',
              )}
            >
              {done && !active ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              ) : active ? (
                status === 'awaiting_approval' ? (
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-500" />
                )
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{step.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {done && !active
                    ? copy.progressDone
                    : active
                      ? `${copy.progressActive} · ${copy.progressEta.replace('{eta}', estimateStepSeconds(step.id))}`
                      : copy.progressPending}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function GateChecklist({
  copy,
  stage,
  scriptDoc,
  shots,
  stillCount,
}: {
  copy: Copy
  stage: StudioStageId
  scriptDoc: ParsedScript | null
  shots: ParsedShot[]
  stillCount: number
}) {
  const items: string[] = []
  if (stage === 'script' || stage === 'assets') {
    items.push(
      copy.gateCheckScript
        .replace('{chars}', String(scriptDoc?.characters.length ?? 0))
        .replace('{locs}', String(scriptDoc?.locations.length ?? 0))
        .replace('{props}', String(scriptDoc?.props.length ?? 0)),
    )
    items.push(copy.gateCheckAssets)
  }
  if (stage === 'storyboard') {
    items.push(copy.gateCheckBoard.replace('{shots}', String(shots.length)).replace('{stills}', String(stillCount)))
  }
  if (stage === 'clips') {
    items.push(copy.gateCheckVideo)
  }
  if (items.length === 0) items.push(copy.gateCheckScript.replace('{chars}', '—').replace('{locs}', '—').replace('{props}', '—'))

  return (
    <div className="mt-3 rounded-2xl border border-amber-500/20 bg-background/40 px-3 py-2.5">
      <div className="text-xs font-medium text-amber-800 dark:text-amber-200">{copy.gateChecklistTitle}</div>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export function ScriptSummaryTable({
  copy,
  doc,
}: {
  copy: Copy
  doc: ParsedScript
}) {
  const rows: ReactNode[][] = [
    [<span className="text-muted-foreground">{copy.briefTheme}</span>, doc.theme || doc.style || '—'],
    [
      <span className="text-muted-foreground">{copy.briefScenes}</span>,
      doc.locations.map((l) => l.name).join('；') || '—',
    ],
    [
      <span className="text-muted-foreground">{copy.briefCharacters}</span>,
      doc.characters.map((c) => `${c.name}（${c.role}）`).join('；') || '—',
    ],
    [<span className="text-muted-foreground">{copy.briefPlot}</span>, doc.hook || doc.climax || '—'],
    [
      <span className="text-muted-foreground">{copy.briefActs}</span>,
      <ol className="list-decimal space-y-1 pl-4">
        {doc.beats.map((beat, index) => (
          <li key={beat.beatId ?? index}>
            {beat.summary}
            {beat.emotion ? `（${beat.emotion}）` : ''}
          </li>
        ))}
      </ol>,
    ],
  ]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{copy.summaryTitle}</h3>
        {doc.title && <Badge variant="secondary">{doc.title}</Badge>}
      </div>
      <DetailTable headers={['', '']} rows={rows} />
    </div>
  )
}

export function CharacterScenePropTables({
  copy,
  doc,
}: {
  copy: Copy
  doc: ParsedScript
}) {
  return (
    <div className="space-y-5">
      <div>
        <h4 className="mb-2 text-sm font-medium">{copy.charListTitle}</h4>
        <DetailTable
          headers={[copy.tableIndex, copy.tableName, copy.tableDesc, copy.tableIntro]}
          rows={doc.characters.map((c, index) => [
            String(index + 1),
            <span className="font-medium">{c.name}</span>,
            <span className="text-muted-foreground">{c.appearance || '—'}</span>,
            <span className="text-muted-foreground">{c.personality || c.role}</span>,
          ])}
          empty="—"
        />
      </div>
      <div>
        <h4 className="mb-2 text-sm font-medium">{copy.sceneListTitle}</h4>
        <DetailTable
          headers={[copy.tableIndex, copy.tableName, copy.tableDesc]}
          rows={doc.locations.map((l, index) => [
            String(index + 1),
            <span className="font-medium">{l.name}</span>,
            <span className="text-muted-foreground">{l.visualNotes || l.mood || '—'}</span>,
          ])}
          empty="—"
        />
      </div>
      {doc.props.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">{copy.propListTitle}</h4>
          <DetailTable
            headers={[copy.tableIndex, copy.tableName, copy.tableDesc]}
            rows={doc.props.map((p, index) => [
              String(index + 1),
              <span className="font-medium">{p.name}</span>,
              <span className="text-muted-foreground">{p.description || '—'}</span>,
            ])}
          />
        </div>
      )}
    </div>
  )
}

export function StoryboardDetailTable({
  copy,
  shots,
  locations,
}: {
  copy: Copy
  shots: ParsedShot[]
  locations: Array<{ id: string; name: string; visualNotes?: string }>
}) {
  const locationName = (id?: string) => {
    if (!id) return '—'
    return locations.find((l) => l.id === id)?.name || id
  }
  return (
    <DetailTable
      headers={[copy.boardGroup, copy.boardScene, copy.boardEmotion, copy.boardText]}
      rows={shots.map((shot) => [
        <span className="font-medium">
          {shot.shotId}（{shot.durationSec}s）
        </span>,
        <span className="text-muted-foreground">{locationName(shot.locationId)}</span>,
        <span className="text-muted-foreground">{shot.emotionCurve || shot.emotion || '—'}</span>,
        <div>
          <div>{shot.visualPrompt}</div>
          {shot.dialogue && <div className="mt-1 text-xs text-muted-foreground">“{shot.dialogue}”</div>}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {[shot.shotSize, shot.cameraMove].filter(Boolean).join(' · ')}
          </div>
        </div>,
      ])}
    />
  )
}
