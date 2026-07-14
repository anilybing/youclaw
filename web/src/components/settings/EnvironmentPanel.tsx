// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '@/i18n'
import { notify } from '@/stores/app'
import { checkEnv, installTool, type DependencyStatus } from '@/api/client'
import { CheckCircle2, XCircle, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function EnvironmentPanel() {
  const { t } = useI18n()
  const [dependencies, setDependencies] = useState<DependencyStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [installingTool, setInstallingTool] = useState<string | null>(null)

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true)
    }
    const result = await checkEnv()
    setDependencies(result.dependencies)
    setLoading(false)
  }, [])

  const handleRefresh = () => {
    void refresh(true)
  }

  const handleInitialLoad = async () => {
    try {
      const result = await checkEnv()
      setDependencies(result.dependencies)
      setLoading(false)
    } catch {
      setLoading(false)
    }
  }

  const handleInstall = async (tool: string) => {
    setInstallingTool(tool)
    try {
      const result = await installTool(tool)
      if (result.ok) {
        notify.success(`${tool} ${t.envSetup.installSuccess}`)
      } else {
        notify.error(result.stderr || t.envSetup.installFailed, { durationMs: 6000 })
      }
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t.envSetup.installFailed, { durationMs: 6000 })
    }
    setInstallingTool(null)
    await refresh()
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void handleInitialLoad()
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [])

  return (
    <div className="space-y-6">
      {/* Header with refresh button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t.envPanel.title}</h3>
          <p className="text-sm text-muted-foreground">{t.envPanel.description}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          <span className="ml-1.5">{t.envPanel.refresh}</span>
        </Button>
      </div>

      {/* Dependencies list */}
      <div className="space-y-3">
        {dependencies.map((dep) => (
          <div key={dep.name} className="flex items-center justify-between p-3 rounded-xl border border-[var(--subtle-border)] bg-[var(--card)]">
            <div className="flex items-center gap-3">
              {dep.available ? (
                <CheckCircle2 size={18} className="text-green-500 shrink-0" />
              ) : (
                <XCircle size={18} className="text-destructive shrink-0" />
              )}
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{dep.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-md ${dep.required ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                    {dep.required ? t.envPanel.required : t.envPanel.optional}
                  </span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-md ${dep.available ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-destructive/10 text-destructive'}`}>
                    {dep.available ? t.envPanel.installed : t.envPanel.notInstalled}
                  </span>
                </div>
                {dep.available && dep.version && (
                  <p className="text-xs text-muted-foreground mt-0.5">{dep.version}</p>
                )}
                {dep.available && dep.path && (
                  <p className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">{dep.path}</p>
                )}
              </div>
            </div>
            {!dep.available && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleInstall(dep.name)}
                disabled={installingTool === dep.name}
              >
                {installingTool === dep.name ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  t.envSetup.installButton
                )}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
