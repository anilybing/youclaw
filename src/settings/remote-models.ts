// [XJC] 从各大服务商拉取可用模型列表（多数走 OpenAI 兼容 GET {baseUrl}/models）
import { getLogger } from '../logger/index.ts'
import {
  resolveProviderAccountApiKey,
  getStoredSettings,
} from './manager.ts'
import type { CustomModelProvider, CustomProviderAccount } from './schema.ts'

export interface RemoteModelInfo {
  id: string
  name: string
  ownedBy?: string
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function modelsEndpoint(account: CustomProviderAccount): string {
  const base = normalizeBaseUrl(account.baseUrl)
  if (!base) {
    // Sensible defaults when user left baseUrl empty for known providers.
    const defaults: Partial<Record<CustomModelProvider, string>> = {
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      deepseek: 'https://api.deepseek.com',
      siliconflow: 'https://api.siliconflow.cn/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      groq: 'https://api.groq.com/openai/v1',
      xai: 'https://api.x.ai/v1',
      mistral: 'https://api.mistral.ai/v1',
      together: 'https://api.together.xyz/v1',
      fireworks: 'https://api.fireworks.ai/inference/v1',
      ollama: 'http://localhost:11434/v1',
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      moonshot: 'https://api.moonshot.cn/v1',
      glm: 'https://open.bigmodel.cn/api/paas/v4',
      doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    }
    const fallback = defaults[account.provider]
    if (!fallback) throw new Error('Provider base URL is required to list models')
    return `${fallback}/models`
  }

  // SiliconFlow: prefer chat-capable models when the gateway supports the filter.
  if (account.provider === 'siliconflow') {
    return `${base}/models?sub_type=chat`
  }
  return `${base}/models`
}

function buildHeaders(account: CustomProviderAccount, apiKey: string): Record<string, string> {
  if (account.provider === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
  if (account.provider === 'gemini' && apiKey) {
    // Google AI Studio style often uses query key; still send bearer for OpenAI-compat gateways.
    return { Authorization: `Bearer ${apiKey}` }
  }
  if (apiKey) {
    return { Authorization: `Bearer ${apiKey}` }
  }
  return {}
}

function parseOpenAiStyleList(payload: unknown): RemoteModelInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const models: RemoteModelInfo[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!id) continue
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id
    const ownedBy = typeof row.owned_by === 'string' ? row.owned_by : undefined
    models.push({ id, name, ownedBy })
  }
  return models
}

function parseGeminiList(payload: unknown): RemoteModelInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const list = (payload as { models?: unknown }).models
  if (!Array.isArray(list)) return []
  const models: RemoteModelInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const rawName = typeof row.name === 'string' ? row.name.trim() : ''
    if (!rawName) continue
    // Gemini returns "models/gemini-2.0-flash" — strip prefix for API model id.
    const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName
    const display = typeof row.displayName === 'string' && row.displayName.trim()
      ? row.displayName.trim()
      : id
    models.push({ id, name: display })
  }
  return models
}

function parseOllamaTags(payload: unknown): RemoteModelInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const list = (payload as { models?: unknown }).models
  if (!Array.isArray(list)) return []
  const models: RemoteModelInfo[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.name === 'string' ? row.name.trim() : (typeof row.model === 'string' ? row.model.trim() : '')
    if (!id) continue
    models.push({ id, name: id })
  }
  return models
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`List models failed (${res.status}): ${text.slice(0, 200) || res.statusText}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the remote model catalog for a provider account.
 * Prefer OpenAI-compatible GET {base}/models; fall back to Gemini / Ollama shapes.
 */
export async function listRemoteModelsForAccount(account: CustomProviderAccount): Promise<RemoteModelInfo[]> {
  const apiKey = resolveProviderAccountApiKey(account)
  if (!apiKey && account.provider !== 'ollama' && account.provider !== 'openrouter') {
    throw new Error('API Key is required to list models for this provider')
  }

  const headers = buildHeaders(account, apiKey)
  const primaryUrl = modelsEndpoint(account)

  try {
    // Gemini native list uses /v1beta/models?key=
    if (account.provider === 'gemini' && !normalizeBaseUrl(account.baseUrl).includes('openai')) {
      const base = normalizeBaseUrl(account.baseUrl) || 'https://generativelanguage.googleapis.com/v1beta'
      const url = apiKey.includes('key=') ? `${base}/models` : `${base}/models?key=${encodeURIComponent(apiKey)}`
      const payload = await fetchJson(url, {})
      const gemini = parseGeminiList(payload)
      if (gemini.length > 0) return dedupeSort(gemini)
    }

    const payload = await fetchJson(primaryUrl, headers)
    const openai = parseOpenAiStyleList(payload)
    if (openai.length > 0) return dedupeSort(openai)

    // Some gateways wrap differently
    if (Array.isArray(payload)) {
      return dedupeSort(parseOpenAiStyleList({ data: payload }))
    }
  } catch (error) {
    getLogger().warn({ error, provider: account.provider, url: primaryUrl }, 'Primary model list fetch failed')
    // Ollama fallback to /api/tags
    if (account.provider === 'ollama') {
      const root = normalizeBaseUrl(account.baseUrl).replace(/\/v1$/, '') || 'http://localhost:11434'
      const payload = await fetchJson(`${root}/api/tags`, {})
      return dedupeSort(parseOllamaTags(payload))
    }
    throw error
  }

  if (account.provider === 'ollama') {
    const root = normalizeBaseUrl(account.baseUrl).replace(/\/v1$/, '') || 'http://localhost:11434'
    const payload = await fetchJson(`${root}/api/tags`, {})
    return dedupeSort(parseOllamaTags(payload))
  }

  return []
}

function dedupeSort(models: RemoteModelInfo[]): RemoteModelInfo[] {
  const map = new Map<string, RemoteModelInfo>()
  for (const model of models) {
    if (!map.has(model.id)) map.set(model.id, model)
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function listRemoteModelsForProviderAccountId(providerAccountId: string): Promise<{
  account: { id: string; name: string; provider: string; baseUrl: string }
  models: RemoteModelInfo[]
}> {
  const settings = getStoredSettings()
  const account = settings.customProviders.find((item) => item.id === providerAccountId)
  if (!account) {
    throw new Error('Provider account not found')
  }
  const models = await listRemoteModelsForAccount(account)
  return {
    account: {
      id: account.id,
      name: account.name,
      provider: account.provider,
      baseUrl: account.baseUrl,
    },
    models,
  }
}
