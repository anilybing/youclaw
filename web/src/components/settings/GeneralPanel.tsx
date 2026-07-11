// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/i18n'
import { useAppPreferencesStore, type CloseAction } from '@/stores/app'
import type { Theme } from '@/hooks/useTheme'
import { Sun, Moon, Monitor, FolderOpen, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getPortableSetting, getTauriInvoke, isTauri, sidecarOrigin, updateCachedBaseUrl, savePreferredPort } from '@/api/transport'
import {
  apiFetch,
  getEvolutionStatus,
  getSettings,
  regenerateMcpServerToken,
  updateSettings,
  type EvolutionStatusDTO,
  type McpServerSettingsDTO,
} from '@/api/client'
import { getBackendBaseUrl } from '@/api/transport'

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

const DEFAULT_MCP_SERVER_SETTINGS: McpServerSettingsDTO = {
  enabled: false,
  allowDangerousTools: false,
  token: '',
}

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
  // [XJC] 自主进化引擎（进化引擎桥）
  const [evolution, setEvolution] = useState<EvolutionStatusDTO | null>(null)
  const [evolutionSaving, setEvolutionSaving] = useState(false)
  // [XJC] 内置 MCP Server（对接 Cursor）：主开关与危险工具开关默认关，token 由后端生成
  const [mcpServer, setMcpServer] = useState<McpServerSettingsDTO | null>(null)
  const [mcpSaving, setMcpSaving] = useState(false)
  const [mcpBaseUrl, setMcpBaseUrl] = useState('')
  const [mcpCopied, setMcpCopied] = useState(false)

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

  useEffect(() => {
    getEvolutionStatus()
      .then(setEvolution)
      .catch(() => setEvolution(null))
  }, [])

  useEffect(() => {
    getSettings()
      .then((s) => setMcpServer({ ...DEFAULT_MCP_SERVER_SETTINGS, ...s.mcpServer }))
      .catch(() => setMcpServer(DEFAULT_MCP_SERVER_SETTINGS))
    getBackendBaseUrl()
      .then(setMcpBaseUrl)
      .catch(() => setMcpBaseUrl(''))
  }, [])

  const handleToggleMcp = useCallback(async () => {
    if (!mcpServer || mcpSaving) return
    setMcpSaving(true)
    try {
      const enabled = !mcpServer.enabled
      const updated = await updateSettings({
        mcpServer: {
          enabled,
          allowDangerousTools: enabled ? mcpServer.allowDangerousTools : false,
        },
      })
      setMcpServer(updated.mcpServer)
    } catch (err) {
      console.error('Failed to toggle MCP server:', err)
    } finally {
      setMcpSaving(false)
    }
  }, [mcpServer, mcpSaving])

  const handleToggleDangerousMcp = useCallback(async () => {
    if (!mcpServer?.enabled || mcpSaving) return
    setMcpSaving(true)
    try {
      const updated = await updateSettings({
        mcpServer: {
          enabled: true,
          allowDangerousTools: !mcpServer.allowDangerousTools,
        },
      })
      setMcpServer(updated.mcpServer)
    } catch (err) {
      console.error('Failed to toggle dangerous MCP tools:', err)
    } finally {
      setMcpSaving(false)
    }
  }, [mcpServer, mcpSaving])

  const handleRegenerateMcpToken = useCallback(async () => {
    if (mcpSaving) return
    setMcpSaving(true)
    try {
      const { token } = await regenerateMcpServerToken()
      setMcpServer((prev) => (prev ? { ...prev, token } : prev))
    } catch (err) {
      console.error('Failed to regenerate MCP token:', err)
    } finally {
      setMcpSaving(false)
    }
  }, [mcpSaving])

  const mcpSnippet = mcpServer?.token
    ? JSON.stringify({
        mcpServers: {
          xiaojuclaw: {
            url: `${mcpBaseUrl || 'http://127.0.0.1:62601'}/mcp`,
            headers: { Authorization: `Bearer ${mcpServer.token}` },
          },
        },
      }, null, 2)
    : ''

  const handleCopyMcpSnippet = useCallback(async () => {
    if (!mcpSnippet) return
    try {
      await navigator.clipboard.writeText(mcpSnippet)
      setMcpCopied(true)
      setTimeout(() => setMcpCopied(false), 2000)
    } catch {
      /* clipboard 不可用时静默 */
    }
  }, [mcpSnippet])

  const handleToggleEvolution = useCallback(async () => {
    if (!evolution || evolutionSaving) return
    setEvolutionSaving(true)
    const nextEnabled = !evolution.enabled
    try {
      await updateSettings({ evolution: { enabled: nextEnabled } })
      // 开启后立刻拉一次状态（触发引擎物料化与 python 探测）
      const fresh = await getEvolutionStatus().catch(() => null)
      setEvolution(fresh ?? { ...evolution, enabled: nextEnabled })
    } catch (err) {
      console.error('Failed to toggle evolution:', err)
    } finally {
      setEvolutionSaving(false)
    }
  }, [evolution, evolutionSaving])

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
      updateCachedBaseUrl(sidecarOrigin(port))
      window.location.reload()
    } catch (err) {
      const errMsg = String(err)
      updateCachedBaseUrl(sidecarOrigin(port))
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

      {/* [XJC] 自主进化引擎：事件驱动零 token 学习 + 行为提示注入（默认关闭） */}
      {evolution && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
            {t.settings.evolutionTitle}
          </h4>
          <div className="flex items-center justify-between gap-4 rounded-2xl border-2 border-border p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t.settings.evolutionEnable}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.settings.evolutionEnableDesc}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t.settings.evolutionTokenNote}</div>
              {evolution.enabled && !evolution.pythonOk && (
                <div className="mt-2 text-xs text-amber-500">{t.settings.evolutionPythonMissing}</div>
              )}
              {evolution.enabled && evolution.pythonOk && (
                <div className="mt-2 text-xs text-muted-foreground">
                  {t.settings.evolutionStage}: {evolution.stage ?? 'embryonic'} · {t.settings.evolutionRecords}: {evolution.records}
                  {evolution.records > 0 && ` (${evolution.successes}✓/${evolution.failures}✗)`}
                  {evolution.activeRules > 0 && ` · ${t.settings.evolutionRules}: ${evolution.activeRules}`}
                </div>
              )}
              {/* [XJC] 学习成果可见：引擎审批通过的行为规则原文（这些规则每轮注入对话） */}
              {evolution.enabled && evolution.rulesText && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-primary/80 hover:text-primary select-none">
                    {t.settings.evolutionViewRules}
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--subtle-border)] bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
                    {evolution.rulesText}
                  </pre>
                </details>
              )}
            </div>
            <button
              role="switch"
              aria-checked={evolution.enabled}
              disabled={evolutionSaving}
              onClick={() => void handleToggleEvolution()}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                evolution.enabled ? 'bg-primary' : 'bg-muted',
                evolutionSaving && 'opacity-60',
              )}
            >
              <span
                className={cn(
                  'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
                  evolution.enabled ? 'translate-x-6' : 'translate-x-1',
                )}
              />
            </button>
          </div>
        </div>
      )}

      {/* [XJC] 内置 MCP Server（路线 A）：默认关闭，开启后 Cursor 等 MCP 客户端可凭 token 调用白名单工具 */}
      {mcpServer && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
            {t.settings.mcpTitle}
          </h4>
          <div className="rounded-2xl border-2 border-border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{t.settings.mcpEnable}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t.settings.mcpEnableDesc}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t.settings.mcpToolsNote}</div>
              </div>
              <button
                role="switch"
                aria-checked={mcpServer.enabled}
                disabled={mcpSaving}
                onClick={() => void handleToggleMcp()}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                  mcpServer.enabled ? 'bg-primary' : 'bg-muted',
                  mcpSaving && 'opacity-60',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
                    mcpServer.enabled ? 'translate-x-6' : 'translate-x-1',
                  )}
                />
              </button>
            </div>
            {mcpServer.enabled && (
              <div className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-destructive">{t.settings.mcpDangerousEnable}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{t.settings.mcpDangerousEnableDesc}</div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={mcpServer.allowDangerousTools}
                    disabled={mcpSaving}
                    onClick={() => void handleToggleDangerousMcp()}
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                      mcpServer.allowDangerousTools ? 'bg-destructive' : 'bg-muted',
                      mcpSaving && 'opacity-60',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
                        mcpServer.allowDangerousTools ? 'translate-x-6' : 'translate-x-1',
                      )}
                    />
                  </button>
                </div>
                <div className="mt-2 text-xs text-destructive">{t.settings.mcpDangerousWarning}</div>
              </div>
            )}
            {mcpServer.enabled && mcpServer.token && (
              <div className="mt-3 border-t border-[var(--subtle-border)] pt-3">
                <div className="text-xs text-muted-foreground">{t.settings.mcpSnippetHint}</div>
                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--subtle-border)] bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {mcpSnippet}
                </pre>
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void handleCopyMcpSnippet()}>
                    {mcpCopied ? t.settings.mcpCopied : t.settings.mcpCopy}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={mcpSaving} onClick={() => void handleRegenerateMcpToken()}>
                    {t.settings.mcpRegenerate}
                  </Button>
                </div>
                <div className="mt-2 text-xs text-amber-500">{t.settings.mcpSecurityNote}</div>
              </div>
            )}
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
