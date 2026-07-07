// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/i18n'
import { useAppPreferencesStore, type CloseAction } from '@/stores/app'
import type { Theme } from '@/hooks/useTheme'
import { Sun, Moon, Monitor, FolderOpen, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getPortableSetting, getTauriInvoke, isTauri, updateCachedBaseUrl, savePreferredPort } from '@/api/transport'
import { apiFetch } from '@/api/client'

// [XJC-PATCH] T-G6 本地文档摄取配置（后端 /api/ingest/config，存 kv_state）
interface IngestConfigDTO {
  ingestEnabled: boolean
  ingestFolders: string[]
  /** [G6.2] 渠道消息日摘要开关 */
  channelDigestEnabled: boolean
}

const themeOptions: { value: Theme; labelKey: 'dark' | 'light' | 'system'; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { value: 'light', labelKey: 'light', icon: Sun },
  { value: 'dark', labelKey: 'dark', icon: Moon },
  { value: 'system', labelKey: 'system', icon: Monitor },
]

const languageOptions = [
  { value: 'en', label: 'English (US)' },
  { value: 'zh', label: '简体中文' },
] as const

const closeBehaviorOptions: { value: CloseAction; titleKey: 'closeBehaviorAsk' | 'closeBehaviorMinimize' | 'closeBehaviorQuit'; descriptionKey: 'closeBehaviorAskDesc' | 'closeBehaviorMinimizeDesc' | 'closeBehaviorQuitDesc' }[] = [
  { value: '', titleKey: 'closeBehaviorAsk', descriptionKey: 'closeBehaviorAskDesc' },
  { value: 'minimize', titleKey: 'closeBehaviorMinimize', descriptionKey: 'closeBehaviorMinimizeDesc' },
  { value: 'quit', titleKey: 'closeBehaviorQuit', descriptionKey: 'closeBehaviorQuitDesc' },
]

export function GeneralPanel() {
  const { t } = useI18n()
  const theme = useAppPreferencesStore((s) => s.theme)
  const setTheme = useAppPreferencesStore((s) => s.setTheme)
  const locale = useAppPreferencesStore((s) => s.locale)
  const setLocale = useAppPreferencesStore((s) => s.setLocale)
  const closeAction = useAppPreferencesStore((s) => s.closeAction)
  const setCloseAction = useAppPreferencesStore((s) => s.setCloseAction)
  const [portValue, setPortValue] = useState('62601')
  const [portSaved, setPortSaved] = useState(false)
  const [portRestarting, setPortRestarting] = useState(false)
  const [portMessage, setPortMessage] = useState('')
  const [ingestConfig, setIngestConfig] = useState<IngestConfigDTO | null>(null)
  const [ingestFolderInput, setIngestFolderInput] = useState('')
  const [ingestSaveFailed, setIngestSaveFailed] = useState(false)

  useEffect(() => {
    if (!isTauri) return
    getPortableSetting('preferred_port').then((preferred) => {
      if (preferred) setPortValue(preferred)
    })
  }, [])

  useEffect(() => {
    apiFetch<IngestConfigDTO>('/api/ingest/config')
      .then(setIngestConfig)
      .catch(() => setIngestConfig(null))
  }, [])

  const saveIngestConfig = useCallback(async (partial: Partial<IngestConfigDTO>) => {
    setIngestSaveFailed(false)
    try {
      const updated = await apiFetch<IngestConfigDTO>('/api/ingest/config', {
        method: 'POST',
        body: JSON.stringify(partial),
      })
      setIngestConfig(updated)
    } catch (err) {
      console.error('Failed to save ingest config:', err)
      setIngestSaveFailed(true)
    }
  }, [])

  const handleAddIngestFolder = useCallback(() => {
    const folder = ingestFolderInput.trim()
    if (!folder || !ingestConfig) return
    setIngestFolderInput('')
    void saveIngestConfig({ ingestFolders: [...ingestConfig.ingestFolders, folder] })
  }, [ingestFolderInput, ingestConfig, saveIngestConfig])

  const savePortToStore = useCallback(async (port: number) => {
    await savePreferredPort(port)
  }, [])

  const handleSavePort = useCallback(async () => {
    const port = parseInt(portValue, 10)
    if (isNaN(port) || port < 1024 || port > 65535) return
    try {
      await savePortToStore(port)
      setPortSaved(true)
      setPortMessage('')
      setTimeout(() => setPortSaved(false), 3000)
    } catch (err) {
      console.error('Failed to save port:', err)
    }
  }, [portValue, savePortToStore])

  const handleRestartSidecar = useCallback(async () => {
    const port = parseInt(portValue, 10)
    if (isNaN(port) || port < 1024 || port > 65535) return
    setPortRestarting(true)
    setPortMessage('')
    try {
      await savePortToStore(port)
      const invoke = getTauriInvoke()
      await invoke('restart_sidecar')
      updateCachedBaseUrl(`http://localhost:${port}`)
      window.location.reload()
    } catch (err) {
      const errMsg = String(err)
      updateCachedBaseUrl(`http://localhost:${port}`)
      setPortSaved(true)
      setPortRestarting(false)
      setPortMessage(errMsg.includes('Dev mode') ? t.settings.portWebHint : `Restart failed: ${errMsg}`)
    }
  }, [portValue, savePortToStore, t])

  return (
    <div className="space-y-8">
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
          {t.settings.appearance}
        </h4>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((option) => {
            const Icon = option.icon
            return (
              <button
                key={option.value}
                onClick={() => setTheme(option.value)}
                className={cn(
                  'p-4 rounded-2xl border-2 transition-all flex flex-col items-center gap-3',
                  theme === option.value
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-muted-foreground/30',
                )}
              >
                <div className={cn(
                  'w-10 h-10 rounded-xl flex items-center justify-center',
                  theme === option.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground',
                )}>
                  <Icon size={20} />
                </div>
                <span className="text-xs font-medium capitalize">{t.settings[option.labelKey]}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
          {t.settings.language}
        </h4>
        <div className="flex gap-3">
          {languageOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setLocale(option.value)}
              className={cn(
                'px-6 py-3 rounded-xl border-2 text-sm font-medium transition-all',
                locale === option.value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/30',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {ingestConfig && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
            {t.settings.ingestTitle}
          </h4>
          <p className="text-xs text-muted-foreground mb-3">{t.settings.ingestHint}</p>
          <div className="flex items-center justify-between gap-4 rounded-2xl border-2 border-border p-4 mb-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t.settings.ingestEnable}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.settings.ingestEnableDesc}</div>
            </div>
            <button
              role="switch"
              aria-checked={ingestConfig.ingestEnabled}
              onClick={() => void saveIngestConfig({ ingestEnabled: !ingestConfig.ingestEnabled })}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                ingestConfig.ingestEnabled ? 'bg-primary' : 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
                  ingestConfig.ingestEnabled ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </button>
          </div>
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">{t.settings.ingestFoldersLabel}</div>
            {ingestConfig.ingestFolders.length === 0 && (
              <p className="text-xs text-muted-foreground">{t.settings.ingestNoFolders}</p>
            )}
            {ingestConfig.ingestFolders.map((folder) => (
              <div key={folder} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2">
                <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-xs" title={folder}>{folder}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-lg px-2 text-muted-foreground hover:text-destructive"
                  onClick={() => void saveIngestConfig({ ingestFolders: ingestConfig.ingestFolders.filter((f) => f !== folder) })}
                >
                  <Trash2 size={14} />
                  <span className="sr-only">{t.settings.ingestRemoveFolder}</span>
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Input
                value={ingestFolderInput}
                onChange={(e) => setIngestFolderInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddIngestFolder() }}
                placeholder={t.settings.ingestFolderPlaceholder}
                className="flex-1 rounded-xl text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl"
                onClick={handleAddIngestFolder}
                disabled={!ingestFolderInput.trim()}
              >
                {t.settings.ingestAddFolder}
              </Button>
            </div>
            {ingestSaveFailed && <p className="text-xs text-destructive">{t.settings.ingestSaveFailed}</p>}
          </div>
          {/* [G6.2] 渠道消息日摘要开关（与文件夹摄取独立） */}
          <div className="mt-3 flex items-center justify-between gap-4 rounded-2xl border-2 border-border p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t.settings.channelDigestEnable}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.settings.channelDigestEnableDesc}</div>
            </div>
            <button
              role="switch"
              aria-checked={ingestConfig.channelDigestEnabled}
              onClick={() => void saveIngestConfig({ channelDigestEnabled: !ingestConfig.channelDigestEnabled })}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                ingestConfig.channelDigestEnabled ? 'bg-primary' : 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
                  ingestConfig.channelDigestEnabled ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </button>
          </div>
        </div>
      )}

      {isTauri && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
            {t.settings.serverPort}
          </h4>
          <p className="text-xs text-muted-foreground mb-3">{t.settings.portHint}</p>
          <div className="flex items-center gap-3">
            <Input
              type="number"
              min={1024}
              max={65535}
              value={portValue}
              onChange={(e) => { setPortValue(e.target.value); setPortSaved(false); setPortMessage('') }}
              className="w-32 rounded-xl"
            />
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={handleSavePort}
              disabled={portSaved}
            >
              {portSaved ? t.settings.portSaved : t.settings.portSave}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={handleRestartSidecar}
              disabled={portRestarting}
            >
              {portRestarting ? t.settings.portRestarting : t.settings.portRestartNow}
            </Button>
          </div>
          {portMessage && (
            <p className="text-xs text-amber-500 mt-2">{portMessage}</p>
          )}
        </div>
      )}

      {isTauri && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
            {t.settings.closeBehavior}
          </h4>
          <p className="text-xs text-muted-foreground mb-4">{t.settings.closeBehaviorHint}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {closeBehaviorOptions.map((option) => (
              <button
                key={option.titleKey}
                onClick={() => void setCloseAction(option.value)}
                className={cn(
                  'rounded-2xl border-2 p-4 text-left transition-all',
                  closeAction === option.value
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-muted-foreground/30'
                )}
              >
                <div className="text-sm font-medium text-foreground">
                  {t.settings[option.titleKey]}
                </div>
                <div className="mt-2 text-xs leading-5 text-muted-foreground">
                  {t.settings[option.descriptionKey]}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
