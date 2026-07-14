// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState, useCallback, useRef, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { openExternal } from "@/api/transport"
import { useI18n } from "@/i18n"
import { getOfficialDocsUrl } from "@/lib/external-links"
import { cn } from "@/lib/utils"
import { Plus, Pencil, Trash2, Check, Settings2, Cloud, Cpu, ExternalLink } from "lucide-react"
import {
  ActiveModelProvider,
  getSettings,
  updateSettings as apiUpdateSettings,
  listProviderRemoteModels,
  type SettingsDTO,
  type CustomModelDTO,
  type CustomProviderAccountDTO,
  type RemoteModelInfoDTO,
} from "@/api/client"
import { useAppRuntimeStore } from "@/stores/app"

// Built-in model definitions
const BUILTIN_MODELS = [
  {
    id: "XiaoJuClaw-pro",
    name: "XiaoJuClaw Pro",
    description: "Most capable built-in model",
  },
] as const

// [XJC] 暂时隐藏「云服务·按积分计费」的内置模型：默认引导用户使用自定义 API（自带 Key）。
const CLOUD_BILLING_ENABLED = false

const CUSTOM_MODEL_DOCS_URL = getOfficialDocsUrl('custom-models')
const CUSTOM_MODEL_PROVIDER_META: Record<CustomModelDTO['provider'], { label: string; defaultBaseUrl: string; modelIdExample?: string }> = {
  anthropic: {
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelIdExample: 'claude-sonnet-4-6',
  },
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    modelIdExample: 'gpt-4.1',
  },
  gemini: {
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    modelIdExample: 'gemini-2.5-flash',
  },
  minimax: {
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimax.io/anthropic',
    modelIdExample: 'MiniMax-M2.5-highspeed',
  },
  'minimax-cn': {
    label: 'MiniMax CN',
    defaultBaseUrl: '',
    modelIdExample: 'MiniMax-M2.5-highspeed',
  },
  glm: {
    label: 'GLM',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelIdExample: 'glm-4.6',
  },
  deepseek: {
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    modelIdExample: 'deepseek-chat',
  },
  qwen: {
    label: 'Qwen',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelIdExample: 'qwen3-max',
  },
  moonshot: {
    label: 'Moonshot',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    modelIdExample: 'kimi-k2-0711-preview',
  },
  doubao: {
    label: 'Doubao',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelIdExample: 'doubao-seed-1-6-thinking-250715',
  },
  siliconflow: {
    label: 'SiliconFlow',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    modelIdExample: 'deepseek-ai/DeepSeek-V3',
  },
  openrouter: {
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    modelIdExample: 'openai/gpt-4.1-mini',
  },
  groq: {
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    modelIdExample: 'llama-3.3-70b-versatile',
  },
  xai: {
    label: 'xAI',
    defaultBaseUrl: 'https://api.x.ai/v1',
    modelIdExample: 'grok-4',
  },
  mistral: {
    label: 'Mistral',
    defaultBaseUrl: 'https://api.mistral.ai',
    modelIdExample: 'mistral-large-latest',
  },
  together: {
    label: 'Together AI',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    modelIdExample: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  fireworks: {
    label: 'Fireworks AI',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    modelIdExample: 'accounts/fireworks/models/deepseek-v3',
  },
  ollama: {
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    modelIdExample: 'qwen3:8b',
  },
  custom: {
    label: 'Custom',
    defaultBaseUrl: '',
    modelIdExample: 'my-proxy/model-name',
  },
}

const CUSTOM_MODEL_PROVIDER_VALUES: CustomModelDTO['provider'][] = [
  'anthropic',
  'openai',
  'gemini',
  'glm',
  'deepseek',
  'qwen',
  'moonshot',
  'doubao',
  'siliconflow',
  'openrouter',
  'groq',
  'xai',
  'mistral',
  'together',
  'fireworks',
  'ollama',
  'minimax',
  'minimax-cn',
  'custom',
]

const CUSTOM_MODEL_PROVIDER_OPTIONS: Array<{ value: CustomModelDTO['provider']; label: string }> =
  CUSTOM_MODEL_PROVIDER_VALUES.map((value) => ({ value, label: CUSTOM_MODEL_PROVIDER_META[value].label }))

type ActiveModel = SettingsDTO['activeModel']

export function ModelsPanel() {
  const { t } = useI18n()
  const { cloudEnabled } = useAppRuntimeStore()
  const [builtinModel, setBuiltinModel] = useState("XiaoJuClaw-pro")
  const [builtinModelId, setBuiltinModelId] = useState<string | null>(null)
  const [customProviders, setCustomProviders] = useState<CustomProviderAccountDTO[]>([])
  const [customModels, setCustomModels] = useState<CustomModelDTO[]>([])
  const [activeModel, setActiveModel] = useState<ActiveModel>({ provider: ActiveModelProvider.Builtin })

  // Provider dialog
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<CustomProviderAccountDTO | null>(null)
  const [formProviderName, setFormProviderName] = useState("")
  const [formProviderType, setFormProviderType] = useState<CustomModelDTO['provider']>("siliconflow")
  const formProviderTypeRef = useRef<CustomModelDTO['provider']>("siliconflow")
  const [formProviderApiKey, setFormProviderApiKey] = useState("")
  const [formProviderBaseUrl, setFormProviderBaseUrl] = useState(CUSTOM_MODEL_PROVIDER_META.siliconflow.defaultBaseUrl)

  // Model dialog
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<CustomModelDTO | null>(null)
  const [formName, setFormName] = useState("")
  const [formModelId, setFormModelId] = useState("")
  const [formAccountId, setFormAccountId] = useState("")
  const [remoteModels, setRemoteModels] = useState<RemoteModelInfoDTO[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)

  const [deleteModelId, setDeleteModelId] = useState<string | null>(null)
  const [deleteProviderId, setDeleteProviderId] = useState<string | null>(null)
  const [touched, setTouched] = useState<Record<string, boolean>>({})

  const isBuiltinActive = activeModel.provider === ActiveModelProvider.Builtin
  const showBuiltin = cloudEnabled && CLOUD_BILLING_ENABLED
  const currentProviderMeta = CUSTOM_MODEL_PROVIDER_META[
    customProviders.find((p) => p.id === formAccountId)?.provider
    ?? editingModel?.provider
    ?? 'custom'
  ]

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, CustomModelDTO[]>()
    for (const model of customModels) {
      const key = model.providerAccountId || `__legacy__:${model.id}`
      const list = map.get(key) ?? []
      list.push(model)
      map.set(key, list)
    }
    return map
  }, [customModels])

  useEffect(() => {
    getSettings().then((settings) => {
      setActiveModel(settings.activeModel)
      setCustomProviders(settings.customProviders ?? [])
      setCustomModels(settings.customModels)
      if (settings.builtinModelId) {
        setBuiltinModelId(settings.builtinModelId)
      }
      if (!CLOUD_BILLING_ENABLED && settings.activeModel.provider === ActiveModelProvider.Builtin) {
        const [first] = settings.customModels
        if (first) {
          const newActive: ActiveModel = { provider: ActiveModelProvider.Custom, id: first.id }
          setActiveModel(newActive)
          apiUpdateSettings({ activeModel: newActive })
            .then(() => useAppRuntimeStore.setState({ modelReady: true }))
            .catch(console.error)
        }
      }
    }).catch(console.error)
  }, [])

  const saveSettings = useCallback(async (partial: Partial<SettingsDTO>) => {
    try {
      const updated = await apiUpdateSettings(partial)
      setActiveModel(updated.activeModel)
      setCustomProviders(updated.customProviders ?? [])
      setCustomModels(updated.customModels)

      const { provider, id } = updated.activeModel
      if (provider === ActiveModelProvider.Builtin) {
        useAppRuntimeStore.setState({ modelReady: cloudEnabled })
      } else {
        const model = id
          ? updated.customModels.find((m) => m.id === id)
          : updated.customModels[0]
        useAppRuntimeStore.setState({ modelReady: !!model })
      }
    } catch (err) {
      console.error('Failed to save settings:', err)
    }
  }, [cloudEnabled])

  const handleSetActiveProvider = async (provider: ActiveModelProvider) => {
    let newActive: ActiveModel
    if (provider === ActiveModelProvider.Builtin) {
      newActive = { provider: ActiveModelProvider.Builtin }
    } else {
      const defaultModel = customModels[0]
      if (!defaultModel) return
      newActive = { provider: ActiveModelProvider.Custom, id: defaultModel.id }
    }
    setActiveModel(newActive)
    await saveSettings({ activeModel: newActive })
  }

  const handleSelectBuiltin = async (id: string) => {
    setBuiltinModel(id)
    const newActive: ActiveModel = { provider: ActiveModelProvider.Builtin }
    setActiveModel(newActive)
    await saveSettings({ activeModel: newActive })
  }

  const handleSetCustomActive = async (id: string) => {
    const newActive: ActiveModel = { provider: ActiveModelProvider.Custom, id }
    setActiveModel(newActive)
    await saveSettings({ activeModel: newActive })
  }

  const providerFormErrors = {
    name: !formProviderName.trim() ? t.settings.validationRequired ?? 'Required' : null,
    // Local Ollama usually needs no API key.
    apiKey: !editingProvider && !formProviderApiKey.trim() && formProviderType !== 'ollama'
      ? t.settings.validationRequired ?? 'Required'
      : formProviderApiKey.trim() && formProviderApiKey.trim().length < 8
        ? t.settings.validationApiKeyTooShort ?? 'API Key is too short'
        : null,
    baseUrl: formProviderBaseUrl.trim() && !/^https?:\/\/.+/.test(formProviderBaseUrl.trim())
      ? t.settings.validationBaseUrlFormat ?? 'Must start with http:// or https://'
      : !formProviderBaseUrl.trim() && formProviderType !== 'ollama' && formProviderType !== 'minimax-cn' && formProviderType !== 'custom'
        ? t.settings.validationRequired ?? 'Required'
        : null,
  }
  const providerHasErrors = Object.values(providerFormErrors).some((e) => e !== null)

  const modelFormErrors = {
    accountId: !formAccountId.trim() ? t.settings.validationRequired ?? 'Required' : null,
    name: !formName.trim() ? t.settings.validationRequired ?? 'Required' : null,
    modelId: !formModelId.trim()
      ? t.settings.validationRequired ?? 'Required'
      : /\s/.test(formModelId.trim())
        ? t.settings.validationModelIdNoSpaces ?? 'Model ID cannot contain spaces'
        : null,
  }
  const modelHasErrors = Object.values(modelFormErrors).some((e) => e !== null)

  const handleBlur = (field: string) => setTouched((prev) => ({ ...prev, [field]: true }))

  const handleOpenAddProvider = () => {
    setEditingProvider(null)
    setFormProviderName("")
    setFormProviderType("siliconflow")
    formProviderTypeRef.current = "siliconflow"
    setFormProviderApiKey("")
    setFormProviderBaseUrl(CUSTOM_MODEL_PROVIDER_META.siliconflow.defaultBaseUrl)
    setTouched({})
    setProviderDialogOpen(true)
  }

  const handleOpenEditProvider = (account: CustomProviderAccountDTO) => {
    setEditingProvider(account)
    setFormProviderName(account.name)
    setFormProviderType(account.provider)
    formProviderTypeRef.current = account.provider
    setFormProviderApiKey("")
    setFormProviderBaseUrl(account.baseUrl)
    setTouched({})
    setProviderDialogOpen(true)
  }

  const handleProviderTypeChange = (value: CustomModelDTO['provider']) => {
    const previous = formProviderType
    const previousDefault = CUSTOM_MODEL_PROVIDER_META[previous].defaultBaseUrl
    const nextDefault = CUSTOM_MODEL_PROVIDER_META[value].defaultBaseUrl
    setFormProviderType(value)
    formProviderTypeRef.current = value
    setFormProviderBaseUrl((current) => {
      const trimmed = current.trim()
      if (!trimmed || trimmed === previousDefault) return nextDefault
      return current
    })
    if (!formProviderName.trim() || formProviderName === CUSTOM_MODEL_PROVIDER_META[previous].label) {
      setFormProviderName(CUSTOM_MODEL_PROVIDER_META[value].label)
    }
  }

  const handleSaveProvider = async () => {
    setTouched({ name: true, apiKey: true, baseUrl: true })
    if (providerHasErrors) return

    const provider = formProviderTypeRef.current
    let updatedProviders: CustomProviderAccountDTO[]
    if (editingProvider) {
      updatedProviders = customProviders.map((item) =>
        item.id === editingProvider.id
          ? {
              ...item,
              name: formProviderName.trim(),
              provider,
              baseUrl: formProviderBaseUrl.trim(),
              ...(formProviderApiKey.trim() ? { apiKey: formProviderApiKey.trim() } : {}),
            }
          : item
      )
    } else {
      updatedProviders = [
        ...customProviders,
        {
          id: crypto.randomUUID(),
          name: formProviderName.trim() || CUSTOM_MODEL_PROVIDER_META[provider].label,
          provider,
          apiKey: formProviderApiKey.trim(),
          baseUrl: formProviderBaseUrl.trim(),
        },
      ]
    }

    const updatedModels = customModels.map((model) => {
      const account = updatedProviders.find((item) => item.id === model.providerAccountId)
      if (!account) return model
      return { ...model, provider: account.provider, baseUrl: account.baseUrl, apiKey: '' }
    })

    setCustomProviders(updatedProviders)
    setCustomModels(updatedModels)
    await saveSettings({ customProviders: updatedProviders, customModels: updatedModels })
    setProviderDialogOpen(false)
  }

  const handleDeleteProvider = async (id: string) => {
    const updatedProviders = customProviders.filter((item) => item.id !== id)
    const removedModelIds = new Set(
      customModels.filter((model) => model.providerAccountId === id).map((model) => model.id),
    )
    const updatedModels = customModels.filter((model) => model.providerAccountId !== id)
    const partial: Partial<SettingsDTO> = {
      customProviders: updatedProviders,
      customModels: updatedModels,
    }
    if (
      activeModel.provider === ActiveModelProvider.Custom
      && activeModel.id
      && removedModelIds.has(activeModel.id)
    ) {
      const next = updatedModels[0]
      partial.activeModel = next
        ? { provider: ActiveModelProvider.Custom, id: next.id }
        : { provider: ActiveModelProvider.Builtin }
      setActiveModel(partial.activeModel)
    }
    setCustomProviders(updatedProviders)
    setCustomModels(updatedModels)
    await saveSettings(partial)
  }

  const handleOpenAddModel = (accountId?: string) => {
    if (customProviders.length === 0) return
    setEditingModel(null)
    setFormName("")
    setFormModelId("")
    setFormAccountId(accountId || customProviders[0]!.id)
    setRemoteModels([])
    setTouched({})
    setModelDialogOpen(true)
  }

  const handleFetchRemoteModels = async () => {
    if (!formAccountId) return
    setRemoteLoading(true)
    try {
      const result = await listProviderRemoteModels(formAccountId)
      setRemoteModels(result.models)
      if (result.models.length === 0) {
        console.info(t.settings.fetchRemoteModelsEmpty)
      }
    } catch (err) {
      console.error(err)
      setRemoteModels([])
    } finally {
      setRemoteLoading(false)
    }
  }

  const handleOpenEditModel = (model: CustomModelDTO) => {
    setEditingModel(model)
    setFormName(model.name)
    setFormModelId(model.modelId)
    setFormAccountId(model.providerAccountId || customProviders[0]?.id || "")
    setTouched({})
    setModelDialogOpen(true)
  }

  const handleSaveModel = async () => {
    setTouched({ accountId: true, name: true, modelId: true })
    if (modelHasErrors) return
    const account = customProviders.find((item) => item.id === formAccountId)
    if (!account) return

    let updated: CustomModelDTO[]
    if (editingModel) {
      updated = customModels.map((m) =>
        m.id === editingModel.id
          ? {
              ...m,
              name: formName.trim(),
              modelId: formModelId.trim(),
              providerAccountId: account.id,
              provider: account.provider,
              baseUrl: account.baseUrl,
              apiKey: '',
            }
          : m
      )
    } else {
      updated = [
        ...customModels,
        {
          id: crypto.randomUUID(),
          name: formName.trim(),
          modelId: formModelId.trim(),
          providerAccountId: account.id,
          provider: account.provider,
          baseUrl: account.baseUrl,
          apiKey: '',
        },
      ]
    }
    setCustomModels(updated)
    await saveSettings({ customModels: updated })
    setModelDialogOpen(false)
  }

  const handleDeleteModel = async (id: string) => {
    const updated = customModels.filter((m) => m.id !== id)
    setCustomModels(updated)

    const partial: Partial<SettingsDTO> = { customModels: updated }
    if (activeModel.provider === ActiveModelProvider.Custom && activeModel.id === id) {
      const next = updated[0]
      const newActive: ActiveModel = next
        ? { provider: ActiveModelProvider.Custom, id: next.id }
        : { provider: ActiveModelProvider.Builtin }
      setActiveModel(newActive)
      partial.activeModel = newActive
    }
    await saveSettings(partial)
  }

  const isCustomActive = (id: string) => activeModel.provider === ActiveModelProvider.Custom && activeModel.id === id

  return (
    <div className="space-y-8">
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
          {t.settings.activeModel}
        </h4>
        <div className={cn("grid gap-3", showBuiltin ? "grid-cols-2" : "grid-cols-1")}>
          {showBuiltin && (
            <button
              onClick={() => handleSetActiveProvider(ActiveModelProvider.Builtin)}
              className={cn(
                "relative flex items-start gap-4 p-5 rounded-2xl border text-left transition-all duration-200 ease-[var(--ease-soft)]",
                isBuiltinActive
                  ? "border-primary bg-primary/5"
                  : "border-[var(--subtle-border)] hover:border-primary/30"
              )}
            >
              <div className={cn(
                "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                isBuiltinActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}>
                <Cloud size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{t.settings.builtinProvider}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t.settings.cloudDesc}
                </div>
              </div>
              {isBuiltinActive && (
                <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
              )}
            </button>
          )}

          <button
            onClick={() => handleSetActiveProvider(ActiveModelProvider.Custom)}
            className={cn(
              "relative flex items-start gap-4 p-5 rounded-2xl border text-left transition-all duration-200 ease-[var(--ease-soft)]",
              activeModel.provider === ActiveModelProvider.Custom
                ? "border-primary bg-primary/5"
                : "border-[var(--subtle-border)] hover:border-primary/30",
              customModels.length === 0 && "opacity-50 cursor-not-allowed"
            )}
            disabled={customModels.length === 0}
          >
            <div className={cn(
              "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              activeModel.provider === ActiveModelProvider.Custom
                ? "bg-orange-500 text-white"
                : "bg-muted text-muted-foreground"
            )}>
              <Settings2 size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{t.settings.customProvider}</div>
              <div className="text-xs text-muted-foreground mt-1">{t.settings.customDesc}</div>
            </div>
            {activeModel.provider === ActiveModelProvider.Custom && (
              <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" />
            )}
          </button>
        </div>
      </div>

      {showBuiltin && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">
            {t.settings.builtinModels}
          </h4>
          <div className="space-y-2">
            {BUILTIN_MODELS.map((model) => {
              const isActive = builtinModel === model.id && isBuiltinActive
              return (
                <div
                  key={model.id}
                  className={cn(
                    "w-full flex items-center justify-between p-4 rounded-2xl border text-left transition-all duration-200 ease-[var(--ease-soft)]",
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-[var(--subtle-border)] hover:border-primary/30"
                  )}
                >
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}>
                      <Cpu size={18} />
                    </div>
                    <div>
                      <div className="text-sm font-semibold flex items-center gap-2">
                        {model.name}
                        {isActive && (
                          <span className="text-xs font-medium text-primary flex items-center gap-1">
                            <Check size={12} />
                            {t.settings.currentSelection}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {builtinModelId ?? model.description}
                      </div>
                    </div>
                  </div>
                  {!isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs rounded-lg"
                      onClick={() => handleSelectBuiltin(model.id)}
                    >
                      {t.settings.setDefault}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.settings.customProviders}
          </h4>
          <Button variant="ghost" size="sm" onClick={handleOpenAddProvider} className="h-7 gap-1 rounded-lg">
            <Plus size={14} />
            {t.settings.addCustomProvider}
          </Button>
        </div>
        <div className="mb-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                {t.settings.customModelSupportTitle}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t.settings.customModelSupportDesc}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t.settings.providerOneKeyHint}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 rounded-xl"
              onClick={() => void openExternal(CUSTOM_MODEL_DOCS_URL)}
            >
              <ExternalLink size={13} />
              {t.settings.customModelDocs}
            </Button>
          </div>
        </div>

        {customProviders.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-[var(--subtle-border)] rounded-2xl">
            {t.settings.noProviderYet}
          </div>
        ) : (
          <div className="space-y-4">
            {customProviders.map((account) => {
              const models = modelsByProvider.get(account.id) ?? []
              return (
                <div key={account.id} className="rounded-2xl border border-[var(--subtle-border)] overflow-hidden">
                  <div className="flex items-center justify-between gap-3 bg-[var(--surface-raised)] px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{account.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {CUSTOM_MODEL_PROVIDER_META[account.provider].label}
                        {account.baseUrl ? ` · ${account.baseUrl}` : ''}
                        {account.apiKey ? ` · ${account.apiKey}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-xs rounded-lg"
                        onClick={() => handleOpenAddModel(account.id)}
                      >
                        <Plus size={13} />
                        {t.settings.addModelUnderProvider}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 rounded-lg"
                        onClick={() => handleOpenEditProvider(account)}
                      >
                        <Pencil size={13} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 rounded-lg text-destructive hover:text-destructive"
                        onClick={() => setDeleteProviderId(account.id)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                  {models.length === 0 ? (
                    <div className="px-4 py-4 text-xs text-muted-foreground">
                      {t.settings.customDesc}
                    </div>
                  ) : (
                    <div className="divide-y divide-border/60">
                      {models.map((model) => (
                        <div
                          key={model.id}
                          className={cn(
                            "flex items-center justify-between px-4 py-3 transition-colors",
                            isCustomActive(model.id) && "bg-primary/5"
                          )}
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium flex items-center gap-2">
                              {model.name}
                              {isCustomActive(model.id) && (
                                <span className="text-xs font-medium text-primary flex items-center gap-1">
                                  <Check size={12} />
                                  {t.settings.currentSelection}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">{model.modelId}</div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {!isCustomActive(model.id) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs rounded-lg"
                                onClick={() => handleSetCustomActive(model.id)}
                              >
                                {t.settings.setDefault}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 rounded-lg"
                              onClick={() => handleOpenEditModel(model)}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 rounded-lg text-destructive hover:text-destructive"
                              onClick={() => setDeleteModelId(model.id)}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {/* Safety net: unlinked legacy rows should not disappear from the UI. */}
            {customModels.filter((model) => !model.providerAccountId || !customProviders.some((p) => p.id === model.providerAccountId)).length > 0 && (
              <div className="rounded-2xl border border-dashed border-amber-500/40 p-4">
                <div className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
                  {t.settings.customModels}
                </div>
                <div className="space-y-2">
                  {customModels
                    .filter((model) => !model.providerAccountId || !customProviders.some((p) => p.id === model.providerAccountId))
                    .map((model) => (
                      <div key={model.id} className="flex items-center justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{model.name}</div>
                          <div className="text-xs text-muted-foreground truncate">{model.modelId}</div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-lg" onClick={() => handleOpenEditModel(model)}>
                            <Pencil size={13} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 rounded-lg text-destructive hover:text-destructive"
                            onClick={() => setDeleteModelId(model.id)}
                          >
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={providerDialogOpen} onOpenChange={setProviderDialogOpen}>
        <DialogContent className="w-[90vw] max-w-2xl p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {editingProvider ? t.settings.editProvider : t.settings.addCustomProvider}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 rounded-xl"
              onClick={() => void openExternal(CUSTOM_MODEL_DOCS_URL)}
            >
              <ExternalLink size={13} />
              {t.settings.customModelDocs}
            </Button>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t.settings.modelProvider ?? 'Provider'}</Label>
              <Select value={formProviderType} onValueChange={(value) => handleProviderTypeChange(value as CustomModelDTO['provider'])}>
                <SelectTrigger className="rounded-xl">
                  <SelectValue placeholder={t.settings.modelProviderPlaceholder ?? 'Select a provider'} />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_MODEL_PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t.settings.providerAccountName}</Label>
              <Input
                value={formProviderName}
                onChange={(e) => setFormProviderName(e.target.value)}
                onBlur={() => handleBlur('name')}
                placeholder={t.settings.providerAccountNamePlaceholder}
                className={cn("rounded-xl", touched.name && providerFormErrors.name ? 'border-destructive' : '')}
              />
              {touched.name && providerFormErrors.name && (
                <p className="text-xs text-destructive">{providerFormErrors.name}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>API Key</Label>
              <Input
                type="password"
                value={formProviderApiKey}
                onChange={(e) => setFormProviderApiKey(e.target.value)}
                onBlur={() => handleBlur('apiKey')}
                placeholder={editingProvider ? t.settings.apiKeyEditPlaceholder ?? "Leave empty to keep current key" : t.settings.apiKeyPlaceholder}
                className={cn("rounded-xl", touched.apiKey && providerFormErrors.apiKey ? 'border-destructive' : '')}
              />
              {touched.apiKey && providerFormErrors.apiKey && (
                <p className="text-xs text-destructive">{providerFormErrors.apiKey}</p>
              )}
              <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                {t.settings.localSecretPlaintextNotice}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Base URL</Label>
              <Input
                value={formProviderBaseUrl}
                onChange={(e) => setFormProviderBaseUrl(e.target.value)}
                onBlur={() => handleBlur('baseUrl')}
                placeholder={t.settings.baseUrlPlaceholder}
                className={cn("rounded-xl", touched.baseUrl && providerFormErrors.baseUrl ? 'border-destructive' : '')}
              />
              {touched.baseUrl && providerFormErrors.baseUrl && (
                <p className="text-xs text-destructive">{providerFormErrors.baseUrl}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t.settings.baseUrlFormatHint}
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setProviderDialogOpen(false)} className="rounded-xl">
                {t.common.cancel}
              </Button>
              <Button onClick={() => void handleSaveProvider()} disabled={providerHasErrors} className="rounded-xl">
                {t.common.save}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="w-[90vw] max-w-2xl p-6">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">
              {editingModel ? t.settings.editModel : t.settings.addCustomModel}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{t.settings.providerOneKeyHint}</p>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t.settings.selectProviderAccount}</Label>
              <Select value={formAccountId} onValueChange={setFormAccountId}>
                <SelectTrigger className="rounded-xl">
                  <SelectValue placeholder={t.settings.selectProviderAccountPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {customProviders.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name} ({CUSTOM_MODEL_PROVIDER_META[account.provider].label})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {touched.accountId && modelFormErrors.accountId && (
                <p className="text-xs text-destructive">{modelFormErrors.accountId}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>{t.settings.modelName}</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                onBlur={() => handleBlur('name')}
                placeholder={t.settings.modelNamePlaceholder}
                className={cn("rounded-xl", touched.name && modelFormErrors.name ? 'border-destructive' : '')}
              />
              {touched.name && modelFormErrors.name && (
                <p className="text-xs text-destructive">{modelFormErrors.name}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>{t.settings.modelId}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!formAccountId || remoteLoading}
                  onClick={() => void handleFetchRemoteModels()}
                >
                  {remoteLoading ? (t.common.loading ?? 'Loading...') : t.settings.fetchRemoteModels}
                </Button>
              </div>
              {remoteModels.length > 0 && (
                <Select
                  value={remoteModels.some((m) => m.id === formModelId) ? formModelId : undefined}
                  onValueChange={(value) => {
                    setFormModelId(value)
                    const hit = remoteModels.find((m) => m.id === value)
                    if (hit && !formName.trim()) setFormName(hit.name || hit.id)
                  }}
                >
                  <SelectTrigger className="rounded-xl">
                    <SelectValue placeholder={t.settings.selectModel ?? t.settings.modelIdPlaceholder} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {remoteModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name || model.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                value={formModelId}
                onChange={(e) => setFormModelId(e.target.value)}
                onBlur={() => handleBlur('modelId')}
                placeholder={currentProviderMeta.modelIdExample ?? t.settings.modelIdPlaceholder}
                className={cn("rounded-xl", touched.modelId && modelFormErrors.modelId ? 'border-destructive' : '')}
              />
              {touched.modelId && modelFormErrors.modelId && (
                <p className="text-xs text-destructive">{modelFormErrors.modelId}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setModelDialogOpen(false)} className="rounded-xl">
                {t.common.cancel}
              </Button>
              <Button onClick={() => void handleSaveModel()} disabled={modelHasErrors} className="rounded-xl">
                {t.common.save}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteModelId} onOpenChange={(open) => !open && setDeleteModelId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.settings.confirmDeleteModel}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.settings.deleteModelDesc}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteModelId) void handleDeleteModel(deleteModelId)
                setDeleteModelId(null)
              }}
            >
              {t.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteProviderId} onOpenChange={(open) => !open && setDeleteProviderId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.settings.confirmDeleteProvider}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.settings.confirmDeleteProvider}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteProviderId) void handleDeleteProvider(deleteProviderId)
                setDeleteProviderId(null)
              }}
            >
              {t.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
