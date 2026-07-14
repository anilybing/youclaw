import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/i18n'
import { useAppPreferencesStore, useAppRuntimeStore } from '@/stores/app'
import { useRemoteConfigStore } from '@/stores/remote-config'
import { isFirstPartyRegistrySource, isThirdPartySkillSourcesEnabled } from '@/lib/registry-source'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getSettings,
  updateSettings,
  type SettingsDTO,
} from '@/api/client'

export function MarketplacePanel() {
  const { t } = useI18n()
  const refreshRegistrySources = useAppRuntimeStore((s) => s.refreshRegistrySources)
  // [XJC] 第三方技能源开关（本地偏好，默认关）：关闭时市场只展示小橘技能库
  const showThirdPartySkillSources = useAppPreferencesStore((s) => s.showThirdPartySkillSources)
  const setShowThirdPartySkillSources = useAppPreferencesStore((s) => s.setShowThirdPartySkillSources)
  const registrySource = useAppRuntimeStore((s) => s.registrySource)
  const setRegistrySource = useAppRuntimeStore((s) => s.setRegistrySource)
  const remoteThirdPartyEnabled = useRemoteConfigStore((s) => s.flag('skills.thirdparty_enabled', false))

  const handleToggleThirdPartySources = useCallback(() => {
    const next = !showThirdPartySkillSources
    setShowThirdPartySkillSources(next)
    // 关闭后若选中的源已被隐藏（远程配置也未强制放开），立即回落到小橘技能库
    if (!isThirdPartySkillSourcesEnabled(next, remoteThirdPartyEnabled) && !isFirstPartyRegistrySource(registrySource)) {
      setRegistrySource('xiaojuclaw')
    }
  }, [registrySource, remoteThirdPartyEnabled, setRegistrySource, setShowThirdPartySkillSources, showThirdPartySkillSources])
  const [settingsState, setSettingsState] = useState<SettingsDTO | null>(null)
  const [tokenValue, setTokenValue] = useState('')
  const [hasConfiguredToken, setHasConfiguredToken] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsMessage, setSettingsMessage] = useState('')
  const [settingsError, setSettingsError] = useState('')

  useEffect(() => {
    let cancelled = false
    setSettingsLoading(true)
    getSettings()
      .then((settings) => {
        if (!cancelled) {
          setSettingsState(settings)
          setTokenValue('')
          setHasConfiguredToken(Boolean(settings.registrySources.clawhub.token))
          setSettingsError('')
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsError(error instanceof Error ? error.message : t.skills.requestFailed)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSettingsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [t.skills.requestFailed])

  const updateRegistryToken = useCallback((value: string) => {
    setTokenValue(value)
    setSettingsMessage('')
    setSettingsError('')
  }, [])

  const handleSaveRegistrySettings = useCallback(async () => {
    if (!settingsState) return
    setSettingsSaving(true)
    setSettingsMessage('')
    setSettingsError('')
    try {
      const normalizedToken = tokenValue.trim()
      const updated = await updateSettings({
        registrySources: {
          clawhub: {
            ...settingsState.registrySources.clawhub,
            token: normalizedToken,
          },
          tencent: {
            ...settingsState.registrySources.tencent,
          },
        },
      })
      setSettingsState(updated)
      setTokenValue('')
      setHasConfiguredToken(Boolean(normalizedToken || updated.registrySources.clawhub.token))
      await refreshRegistrySources()
      setSettingsMessage(t.settings.registrySaved)
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t.skills.requestFailed)
    } finally {
      setSettingsSaving(false)
    }
  }, [refreshRegistrySources, settingsState, t.settings.registrySaved, t.skills.requestFailed, tokenValue])

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
          {t.settings.marketplace}
        </h4>
        <p className="text-xs text-muted-foreground">{t.settings.marketplaceHint}</p>
      </div>

      {/* [XJC] 第三方技能源开关：本地偏好即时生效，不依赖后端设置加载 */}
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--subtle-border)] p-4 max-w-2xl">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t.settings.showThirdPartySources}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t.settings.showThirdPartySourcesDesc}</div>
        </div>
        <button
          role="switch"
          aria-checked={showThirdPartySkillSources}
          onClick={handleToggleThirdPartySources}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            showThirdPartySkillSources ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
              showThirdPartySkillSources ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {settingsLoading && <p className="text-sm text-muted-foreground">{t.common.loading}</p>}

      {!settingsLoading && settingsState && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--subtle-border)] p-4 space-y-4 max-w-2xl">
            <div>
              <div className="text-sm font-medium">ClawHub</div>
              <div className="text-xs text-muted-foreground mt-1">{t.settings.marketplaceSourceClawhubHint}</div>
            </div>
            <label className="space-y-2 block">
              <span className="text-xs font-medium text-muted-foreground">{t.settings.registryToken}</span>
              {hasConfiguredToken && !tokenValue && (
                <div className="text-xs text-green-500">{t.settings.marketplaceTokenConfigured}</div>
              )}
              <Input
                type="password"
                value={tokenValue}
                onChange={(event) => updateRegistryToken(event.target.value)}
                placeholder={t.settings.marketplaceTokenPlaceholder}
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => void handleSaveRegistrySettings()} disabled={settingsSaving}>
              {settingsSaving ? t.settings.marketplaceSaving : t.settings.marketplaceSave}
            </Button>
            {settingsMessage && <span className="text-sm text-green-500">{settingsMessage}</span>}
            {settingsError && <span className="text-sm text-destructive">{settingsError}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
