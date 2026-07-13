// [XJC] 漫剧工作室·资产库面板 + 成片草稿导出面板
// 资产库：从剧本/圣经播种角色/场景/道具，锁定设定与参考图，跨镜跨集复用（防串脸串景）。
// 草稿导出：把分镜 + 静帧 + 台词打包成剪映草稿 + FFmpeg 一键合成脚本。

import { useCallback, useEffect, useState } from 'react'
import { Lock, Unlock, Trash2, RefreshCw, Users, MapPin, Package, Download, FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatApiErrorMessage } from '@/lib/api-error'
import {
  clearStudioAssets,
  deleteStudioAsset,
  exportStudioDraft,
  importStudioAssets,
  listStudioAssets,
  patchStudioAsset,
  type StudioAssetDTO,
  type StudioAssetKindDTO,
  type StudioDraftManifestDTO,
} from '@/api/client'
import type { ParsedCharacter, ParsedLocation, ParsedProp, ParsedShot, ParsedStillFrame } from './parse'
import { resolveShotMediaPath } from './parse'

export interface AssetLibraryCopy {
  assetLibTitle: string
  assetLibHint: string
  assetLibSeed: string
  assetLibSeedDone: string
  assetLibClear: string
  assetLibClearDone: string
  assetLibEmpty: string
  assetLibNeedRun: string
  assetLibLock: string
  assetLibLocked: string
  assetLibUnlock: string
  assetLibDelete: string
  assetLibRefNone: string
  assetLibKindCharacter: string
  assetLibKindLocation: string
  assetLibKindProp: string
  assetLibLoadFailed: string
  assetLibSaveFailed: string
  exportTitle: string
  exportHint: string
  exportBtn: string
  exportNeedShots: string
  exportDone: string
  exportFailed: string
  exportResultShots: string
  exportResultFiles: string
  exportOpenHint: string
}

const KIND_META: Record<StudioAssetKindDTO, { icon: typeof Users; labelKey: keyof AssetLibraryCopy }> = {
  character: { icon: Users, labelKey: 'assetLibKindCharacter' },
  location: { icon: MapPin, labelKey: 'assetLibKindLocation' },
  prop: { icon: Package, labelKey: 'assetLibKindProp' },
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
}

export function AssetLibraryPanel({
  copy,
  runId,
  agentId,
  characters,
  locations,
  props,
  refCandidates,
}: {
  copy: AssetLibraryCopy
  runId?: string
  agentId?: string | null
  characters: ParsedCharacter[]
  locations: ParsedLocation[]
  props: ParsedProp[]
  refCandidates: string[]
}) {
  const [assets, setAssets] = useState<StudioAssetDTO[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const { assets: list } = await listStudioAssets(id)
      setAssets(list)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.assetLibLoadFailed))
    } finally {
      setLoading(false)
    }
  }, [copy.assetLibLoadFailed])

  useEffect(() => {
    if (!runId) {
      setAssets([])
      return
    }
    void load(runId)
  }, [runId, load])

  const handleSeed = async () => {
    if (!runId || busy) return
    setBusy(true)
    try {
      const { assets: list } = await importStudioAssets(runId, {
        agentId,
        characters: characters.map((c) => ({
          refKey: c.id,
          name: c.name,
          description: [c.appearance, c.personality].filter(Boolean).join(' · ') || undefined,
        })),
        locations: locations.map((l) => ({
          refKey: l.id,
          name: l.name,
          description: [l.visualNotes, l.mood].filter(Boolean).join(' · ') || undefined,
        })),
        props: props.map((p) => ({ refKey: p.id, name: p.name, description: p.description || undefined })),
      })
      setAssets(list)
      toast.success(copy.assetLibSeedDone)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.assetLibSaveFailed))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    if (!runId || busy) return
    setBusy(true)
    try {
      await clearStudioAssets(runId)
      setAssets([])
      toast.success(copy.assetLibClearDone)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.assetLibSaveFailed))
    } finally {
      setBusy(false)
    }
  }

  const mutate = async (id: string, run: () => Promise<StudioAssetDTO | null>) => {
    try {
      const next = await run()
      setAssets((prev) => (next ? prev.map((a) => (a.id === id ? next : a)) : prev.filter((a) => a.id !== id)))
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.assetLibSaveFailed))
    }
  }

  const toggleLock = (asset: StudioAssetDTO) =>
    mutate(asset.id, async () => (await patchStudioAsset(asset.id, { locked: !asset.locked })).asset)

  const setRef = (asset: StudioAssetDTO, imagePath: string) =>
    mutate(asset.id, async () => (await patchStudioAsset(asset.id, { imagePath: imagePath || null })).asset)

  const removeAsset = (asset: StudioAssetDTO) =>
    mutate(asset.id, async () => {
      await deleteStudioAsset(asset.id)
      return null
    })

  const seedCount = characters.length + locations.length + props.length
  const grouped: StudioAssetKindDTO[] = ['character', 'location', 'prop']

  return (
    <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-medium">{copy.assetLibTitle}</h3>
          <p className="text-sm text-muted-foreground">{copy.assetLibHint}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void handleSeed()} disabled={!runId || busy || seedCount === 0}>
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', busy && 'animate-spin')} />
            {copy.assetLibSeed}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleClear()} disabled={!runId || busy || assets.length === 0}>
            {copy.assetLibClear}
          </Button>
        </div>
      </div>

      {!runId ? (
        <p className="mt-4 rounded-2xl border border-dashed border-border/60 bg-background/20 px-4 py-6 text-center text-sm text-muted-foreground">
          {copy.assetLibNeedRun}
        </p>
      ) : loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />…</div>
      ) : assets.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-dashed border-border/60 bg-background/20 px-4 py-6 text-center text-sm text-muted-foreground">
          {copy.assetLibEmpty}
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {grouped.map((kind) => {
            const items = assets.filter((a) => a.kind === kind)
            if (items.length === 0) return null
            const meta = KIND_META[kind]
            const Icon = meta.icon
            return (
              <div key={kind}>
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  {copy[meta.labelKey]}
                  <span className="text-muted-foreground/60">· {items.length}</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {items.map((asset) => (
                    <div
                      key={asset.id}
                      className={cn(
                        'rounded-2xl border bg-background/30 p-3',
                        asset.locked ? 'border-emerald-500/40' : 'border-border/50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{asset.name}</span>
                            {asset.locked && (
                              <Badge className="rounded-full bg-emerald-500/15 text-[10px] text-emerald-700 dark:text-emerald-300">
                                {copy.assetLibLocked}
                              </Badge>
                            )}
                          </div>
                          {asset.description && (
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{asset.description}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title={asset.locked ? copy.assetLibUnlock : copy.assetLibLock}
                            onClick={() => void toggleLock(asset)}
                          >
                            {asset.locked ? <Lock className="h-3.5 w-3.5 text-emerald-500" /> : <Unlock className="h-3.5 w-3.5" />}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            title={copy.assetLibDelete}
                            onClick={() => void removeAsset(asset)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2">
                        <select
                          className="w-full truncate rounded-lg border border-border/60 bg-background/50 px-2 py-1 text-[11px] text-muted-foreground"
                          value={asset.imagePath ?? ''}
                          onChange={(e) => void setRef(asset, e.target.value)}
                        >
                          <option value="">{copy.assetLibRefNone}</option>
                          {(asset.imagePath && !refCandidates.includes(asset.imagePath)
                            ? [asset.imagePath, ...refCandidates]
                            : refCandidates
                          ).map((path) => (
                            <option key={path} value={path}>{path.split(/[\\/]/).pop()}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function DraftExportPanel({
  copy,
  runId,
  agentId,
  title,
  aspect,
  resolution,
  shots,
  stillFrames = [],
  stillPaths,
}: {
  copy: AssetLibraryCopy
  runId?: string
  agentId?: string | null
  title: string
  aspect: string
  resolution: string
  shots: ParsedShot[]
  stillFrames?: ParsedStillFrame[]
  stillPaths: string[]
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ dir: string; shotCount: number; totalSec: number; files: string[]; manifest: StudioDraftManifestDTO } | null>(null)

  const handleExport = async () => {
    if (!runId || busy) return
    if (shots.length === 0) {
      toast.error(copy.exportNeedShots)
      return
    }
    setBusy(true)
    try {
      const res = await exportStudioDraft(runId, {
        title,
        aspect,
        resolution,
        agentId,
        shots: shots.map((s, i) => ({
          shotId: s.shotId,
          durationSec: s.durationSec,
          mediaPath: resolveShotMediaPath(s.shotId, i, stillFrames, stillPaths),
          mediaType: 'photo' as const,
          dialogue: s.dialogue,
        })),
      })
      setResult(res)
      toast.success(copy.exportDone)
    } catch (error) {
      toast.error(formatApiErrorMessage(error, copy.exportFailed))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[28px] border border-border/60 bg-card/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-medium">{copy.exportTitle}</h3>
          <p className="text-sm text-muted-foreground">{copy.exportHint}</p>
        </div>
        <Button size="sm" onClick={() => void handleExport()} disabled={!runId || busy || shots.length === 0}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
          {copy.exportBtn}
        </Button>
      </div>

      {result && (
        <div className="mt-4 space-y-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4 text-emerald-500" />
            <span className="font-medium">{fill(copy.exportResultShots, { n: result.shotCount, sec: result.totalSec })}</span>
          </div>
          <code className="block break-all rounded-lg bg-background/50 px-2 py-1 text-xs text-muted-foreground">{result.dir}</code>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{copy.exportResultFiles}</div>
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {result.files.map((f) => (
                <li key={f} className="truncate">· {f.split(/[\\/]/).slice(-2).join('/')}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">{copy.exportOpenHint}</p>
        </div>
      )}
    </section>
  )
}
