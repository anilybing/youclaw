/**
 * 用户自带 Key 通道（P1-1）
 *
 * 该模块负责：
 * 1. 从便携目录 settings.json / secrets.json 读取用户的 OpenAI 兼容配置
 * 2. 直接调用用户配置的 Provider 完成自由聊天
 * 3. 不上传 Key 到 MVP，不扣平台积分
 *
 * 偏好读取走 MVP `/api/ai/preferences`，由 `commercial.ts` 在请求 chat/run 时调用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPaths } from '../config/paths.ts'
import { getLogger } from '../logger/index.ts'

export interface UserAiConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export const USER_AI_SETTING_KEYS = {
  baseUrl: 'user_ai_provider_url',
  model: 'user_ai_provider_model',
} as const

export const USER_AI_SECRET_KEY = 'user_ai_provider_key'

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

export function readUserAiConfig(): UserAiConfig | null {
  const dataDir = getPaths().data
  const settings = readJsonObject(resolve(dataDir, 'settings.json')) || {}
  const secrets = readJsonObject(resolve(dataDir, 'secrets.json')) || {}

  const baseUrl = String(settings[USER_AI_SETTING_KEYS.baseUrl] || '').trim()
  const model = String(settings[USER_AI_SETTING_KEYS.model] || '').trim()
  const apiKey = String(secrets[USER_AI_SECRET_KEY] || '').trim()

  if (!baseUrl || !model || !apiKey) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
}

export function userAiConfigStatus() {
  const dataDir = getPaths().data
  const settings = readJsonObject(resolve(dataDir, 'settings.json')) || {}
  const secrets = readJsonObject(resolve(dataDir, 'secrets.json')) || {}

  return {
    baseUrlConfigured: Boolean(String(settings[USER_AI_SETTING_KEYS.baseUrl] || '').trim()),
    modelConfigured: Boolean(String(settings[USER_AI_SETTING_KEYS.model] || '').trim()),
    apiKeyConfigured: Boolean(String(secrets[USER_AI_SECRET_KEY] || '').trim()),
  }
}

const USER_AI_TIMEOUT_MS = 60_000
const USER_AI_MAX_OUTPUT_TOKENS = 2048

export interface UserAiChatResult {
  outputContent: string
  modelName: string
  providerName: 'user_key'
  tokenUsage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  } | null
}

interface OpenAiCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export async function generateUserKeyChat(message: string, config: UserAiConfig): Promise<UserAiChatResult> {
  const url = `${config.baseUrl}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: USER_AI_MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: message }],
    }),
    signal: AbortSignal.timeout(USER_AI_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    getLogger().error(
      { category: 'user-ai', status: response.status, model: config.model, baseUrl: config.baseUrl },
      'User-key chat failed',
    )
    const err = new Error(`User AI 调用失败 (${response.status}): ${text.slice(0, 160)}`)
    ;(err as Error & { errorCode?: string }).errorCode = 'USER_AI_GENERATION_FAILED'
    throw err
  }

  const data = (await response.json().catch(() => null)) as OpenAiCompletionResponse | null
  const content = data?.choices?.[0]?.message?.content?.toString() || ''
  if (!content) {
    const err = new Error('User AI 返回内容为空')
    ;(err as Error & { errorCode?: string }).errorCode = 'USER_AI_GENERATION_FAILED'
    throw err
  }

  return {
    outputContent: content,
    modelName: config.model,
    providerName: 'user_key',
    tokenUsage: data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : null,
  }
}
