import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { KeyRound, Loader2, ShieldCheck, ShieldAlert, Sparkles, RotateCcw } from 'lucide-react'
import {
  deletePortableSecret,
  deletePortableSetting,
  getPortableSetting,
  hasPortableSecret,
  isTauri,
  savePortableSecret,
  savePortableSetting,
} from '@/api/transport'
import {
  getAiPreference,
  updateAiPreference,
  type AiPreference,
} from '@/api/client'
import { notify } from '@/stores/app-runtime'
import { formatApiError } from '@/lib/api-error'

const KEY_BASE_URL = 'user_ai_provider_url'
const KEY_MODEL = 'user_ai_provider_model'
const SECRET_API_KEY = 'user_ai_provider_key'

const PLACEHOLDER_API_KEY = '••••••••••'

/**
 * 用户自带 Key 配置卡片（P1-1）
 *
 * - BaseURL / Model 写入便携 settings.json
 * - API Key 明文写入用户数据目录的 secrets.json，前端不回显明文
 * - 切换「平台积分 / 自带 Key」模式调用 MVP `/ai/preferences`
 *
 * Web 浏览器模式（非 Tauri）下卡片只读展示提示，配置入口仅在桌面端可用。
 */
export function UserAiKeyCard() {
  const [preference, setPreference] = useState<AiPreference | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState<'platform' | 'user_key' | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasSavedKey, setHasSavedKey] = useState(false)

  useEffect(() => {
    void hydrate()
  }, [])

  async function hydrate() {
    setLoading(true)
    try {
      const pref = await getAiPreference()
      setPreference(pref)
      if (isTauri) {
        const [savedBase, savedModel, savedKey] = await Promise.all([
          getPortableSetting(KEY_BASE_URL),
          getPortableSetting(KEY_MODEL),
          hasPortableSecret(SECRET_API_KEY).catch(() => false),
        ])
        setBaseUrl(savedBase || '')
        setModel(savedModel || '')
        setHasSavedKey(savedKey)
      }
    } catch (err) {
      const formatted = formatApiError(err, '加载 AI 偏好失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setLoading(false)
    }
  }

  async function handleSaveConfig() {
    if (!isTauri) {
      notify.warning('桌面端才能保存本地 Key', { description: '请在 XiaoJuClaw 桌面客户端中配置。' })
      return
    }
    if (!baseUrl.trim() || !model.trim()) {
      notify.warning('请填写完整 BaseURL 与 Model')
      return
    }
    setSaving(true)
    try {
      await savePortableSetting(KEY_BASE_URL, baseUrl.trim().replace(/\/+$/, ''))
      await savePortableSetting(KEY_MODEL, model.trim())
      if (apiKey.trim()) {
        await savePortableSecret(SECRET_API_KEY, apiKey.trim())
        setHasSavedKey(true)
        setApiKey('')
      } else if (!hasSavedKey) {
        notify.warning('请首次填写 API Key', {
          description: '密钥会以明文保存到本机用户数据目录的 secrets.json，云端不留存。',
        })
        setSaving(false)
        return
      }
      notify.success('本地 Key 配置已保存')
      // 同步刷新偏好（包含 userKeyConfigStatus）
      const pref = await getAiPreference()
      setPreference(pref)
    } catch (err) {
      const formatted = formatApiError(err, '保存失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setSaving(false)
    }
  }

  async function handleClearKey() {
    if (!isTauri) return
    setSaving(true)
    try {
      await deletePortableSecret(SECRET_API_KEY)
      await deletePortableSetting(KEY_BASE_URL)
      await deletePortableSetting(KEY_MODEL)
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setHasSavedKey(false)
      // 如果当前模式是 user_key 也会因 sidecar 校验在下次发送时失败 → 自动回退提示
      const pref = await getAiPreference()
      setPreference(pref)
      notify.success('本地 Key 已清除')
    } catch (err) {
      const formatted = formatApiError(err, '清除失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setSaving(false)
    }
  }

  async function handleSwitchMode(mode: 'platform' | 'user_key') {
    if (preference?.aiMode === mode) return
    setSwitching(mode)
    try {
      const pref = await updateAiPreference({ aiMode: mode })
      setPreference(pref)
      notify.success(mode === 'user_key' ? '已切换为「自带 Key」模式' : '已切换为「平台积分」模式')
    } catch (err) {
      const formatted = formatApiError(err, '切换失败')
      notify.error(formatted.title, { description: formatted.suggestion })
    } finally {
      setSwitching(null)
    }
  }

  const status = preference?.userKeyConfigStatus
  const allConfigured = Boolean(status?.baseUrlConfigured && status?.modelConfigured && status?.apiKeyConfigured)
  const currentMode = preference?.aiMode ?? 'platform'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5 text-violet-500" />
          AI 模式与本地 Key
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载 AI 偏好...
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">当前模式：</span>
              {currentMode === 'platform' ? (
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  平台积分
                </Badge>
              ) : (
                <Badge variant="default" className="gap-1 bg-violet-500">
                  <KeyRound className="h-3 w-3" />
                  自带 Key（不消耗平台积分）
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <Button
                variant={currentMode === 'platform' ? 'default' : 'outline'}
                className="justify-start gap-2"
                disabled={switching !== null}
                onClick={() => handleSwitchMode('platform')}
              >
                {switching === 'platform' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                使用平台积分
              </Button>
              <Button
                variant={currentMode === 'user_key' ? 'default' : 'outline'}
                className="justify-start gap-2"
                disabled={switching !== null || !allConfigured}
                onClick={() => handleSwitchMode('user_key')}
                title={!allConfigured ? '需先填写 BaseURL / Model / Key' : ''}
              >
                {switching === 'user_key' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                使用自带 Key
              </Button>
            </div>

            {!isTauri && (
              <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200">
                <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>本地 Key 仅在桌面客户端中可配置，浏览器模式下只能查看模式状态。</span>
              </div>
            )}

            <div className="space-y-3 border-t pt-4">
              <div>
                <Label className="text-xs text-muted-foreground">本地配置状态</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  <Badge variant={status?.baseUrlConfigured ? 'default' : 'secondary'} className="text-xs">
                    BaseURL {status?.baseUrlConfigured ? '已配置' : '未配置'}
                  </Badge>
                  <Badge variant={status?.modelConfigured ? 'default' : 'secondary'} className="text-xs">
                    Model {status?.modelConfigured ? '已配置' : '未配置'}
                  </Badge>
                  <Badge variant={status?.apiKeyConfigured ? 'default' : 'secondary'} className="text-xs">
                    API Key {status?.apiKeyConfigured ? '已配置' : '未配置'}
                  </Badge>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="user-ai-base-url">Base URL</Label>
                <Input
                  id="user-ai-base-url"
                  placeholder="https://api.openai.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={!isTauri || saving}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="user-ai-model">Model</Label>
                <Input
                  id="user-ai-model"
                  placeholder="gpt-4o-mini"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!isTauri || saving}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="user-ai-api-key">API Key</Label>
                <Input
                  id="user-ai-api-key"
                  type="password"
                  placeholder={hasSavedKey ? PLACEHOLDER_API_KEY : 'sk-...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={!isTauri || saving}
                />
                <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                  Key 以明文保存在本机用户数据目录的 <code>secrets.json</code>，云端不会保存。
                  请保护设备或 U 盘，切勿向他人发送数据目录。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button onClick={handleSaveConfig} disabled={!isTauri || saving} className="gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  保存本地配置
                </Button>
                {hasSavedKey && (
                  <Button variant="outline" onClick={handleClearKey} disabled={!isTauri || saving} className="gap-2">
                    <RotateCcw className="h-4 w-4" />
                    清除本地 Key
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
