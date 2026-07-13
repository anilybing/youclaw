import { beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables, getDatabase } from './setup.ts'
import { createSettingsRoutes } from '../src/routes/settings.ts'
import { getStoredSettings, resolveCustomModelCredentials } from '../src/settings/manager.ts'

beforeEach(() => {
  cleanTables('kv_state')
})

describe('provider accounts (one key, many models)', () => {
  test('migrates legacy per-model keys into a shared provider account', async () => {
    const db = getDatabase()
    db.run(
      'INSERT INTO kv_state (key, value) VALUES (?, ?)',
      ['settings', JSON.stringify({
        activeModel: { provider: 'custom', id: 'm1' },
        customModels: [
          {
            id: 'm1',
            name: 'DeepSeek Chat',
            provider: 'deepseek',
            apiKey: 'sk-shared-key-123456',
            baseUrl: 'https://api.deepseek.com',
            modelId: 'deepseek-chat',
          },
          {
            id: 'm2',
            name: 'DeepSeek Reasoner',
            provider: 'deepseek',
            apiKey: 'sk-shared-key-123456',
            baseUrl: 'https://api.deepseek.com',
            modelId: 'deepseek-reasoner',
          },
        ],
      })],
    )

    const app = createSettingsRoutes()
    const res = await app.request('/settings')
    const body = await res.json() as {
      customProviders: Array<{ id: string; provider: string; apiKey: string; baseUrl: string }>
      customModels: Array<{ id: string; providerAccountId?: string; apiKey: string; modelId: string }>
    }

    expect(res.status).toBe(200)
    expect(body.customProviders).toHaveLength(1)
    expect(body.customProviders[0]?.provider).toBe('deepseek')
    expect(body.customProviders[0]?.apiKey).toBe('****3456')
    expect(body.customModels).toHaveLength(2)
    expect(body.customModels[0]?.providerAccountId).toBe(body.customProviders[0]?.id)
    expect(body.customModels[1]?.providerAccountId).toBe(body.customProviders[0]?.id)

    const stored = getStoredSettings()
    const creds1 = resolveCustomModelCredentials(stored.customModels[0]!, stored)
    const creds2 = resolveCustomModelCredentials(stored.customModels[1]!, stored)
    expect(creds1.apiKey).toBe('sk-shared-key-123456')
    expect(creds2.apiKey).toBe('sk-shared-key-123456')
    expect(creds1.baseUrl).toBe('https://api.deepseek.com')
  })

  test('PATCH can add a second model under an existing provider without a new key', async () => {
    const app = createSettingsRoutes()
    const create = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customProviders: [{
          id: 'p1',
          name: 'SiliconFlow',
          provider: 'siliconflow',
          apiKey: 'sk-sf-abcdefgh',
          baseUrl: 'https://api.siliconflow.cn/v1',
        }],
        customModels: [{
          id: 'm1',
          name: 'V3',
          provider: 'siliconflow',
          providerAccountId: 'p1',
          apiKey: '',
          baseUrl: 'https://api.siliconflow.cn/v1',
          modelId: 'deepseek-ai/DeepSeek-V3',
        }],
        activeModel: { provider: 'custom', id: 'm1' },
      }),
    })
    expect(create.status).toBe(200)

    const addModel = await app.request('/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customModels: [
          {
            id: 'm1',
            name: 'V3',
            provider: 'siliconflow',
            providerAccountId: 'p1',
            apiKey: '',
            baseUrl: 'https://api.siliconflow.cn/v1',
            modelId: 'deepseek-ai/DeepSeek-V3',
          },
          {
            id: 'm2',
            name: 'R1',
            provider: 'siliconflow',
            providerAccountId: 'p1',
            apiKey: '',
            baseUrl: 'https://api.siliconflow.cn/v1',
            modelId: 'deepseek-ai/DeepSeek-R1',
          },
        ],
      }),
    })
    const body = await addModel.json() as {
      customProviders: Array<{ apiKey: string }>
      customModels: Array<{ id: string; providerAccountId?: string; apiKey: string }>
    }
    expect(addModel.status).toBe(200)
    expect(body.customProviders).toHaveLength(1)
    expect(body.customProviders[0]?.apiKey).toBe('****efgh')
    expect(body.customModels.every((m) => m.apiKey === '')).toBe(true)
    expect(body.customModels.map((m) => m.id).sort()).toEqual(['m1', 'm2'])

    const stored = getStoredSettings()
    expect(resolveCustomModelCredentials(stored.customModels.find((m) => m.id === 'm2')!, stored).apiKey)
      .toBe('sk-sf-abcdefgh')
  })

  test('cleans up legacy per-model secrets after migrating to a provider account', async () => {
    const { resolve } = await import('node:path')
    const { existsSync, readFileSync } = await import('node:fs')
    const { getPaths } = await import('../src/config/paths.ts')

    const db = getDatabase()
    db.run(
      'INSERT INTO kv_state (key, value) VALUES (?, ?)',
      ['settings', JSON.stringify({
        activeModel: { provider: 'custom', id: 'm1' },
        customModels: [{
          id: 'm1',
          name: 'Chat',
          provider: 'deepseek',
          apiKey: 'sk-legacy-secret-9999',
          baseUrl: 'https://api.deepseek.com',
          modelId: 'deepseek-chat',
        }],
      })],
    )

    // Trigger migration + secret rewrite
    getStoredSettings()

    const secretsPath = resolve(getPaths().data, 'secrets.json')
    expect(existsSync(secretsPath)).toBe(true)
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as Record<string, string>
    expect(secrets.custom_model_m1_api_key).toBeUndefined()
    const providerSecretKeys = Object.keys(secrets).filter((k) => k.startsWith('custom_provider_'))
    expect(providerSecretKeys.length).toBe(1)
    expect(secrets[providerSecretKeys[0]!]).toBe('sk-legacy-secret-9999')
  })
})
