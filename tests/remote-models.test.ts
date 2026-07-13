import { beforeEach, describe, expect, test } from 'bun:test'
import './setup.ts'
import { cleanTables, getDatabase } from './setup.ts'
import { createSettingsRoutes } from '../src/routes/settings.ts'
import { updateSettings } from '../src/settings/manager.ts'

beforeEach(() => {
  cleanTables('kv_state')
})

describe('remote model list API', () => {
  test('GET /settings/custom-providers/:id/remote-models returns OpenAI-style catalog', async () => {
    updateSettings({
      customProviders: [{
        id: 'p-sf',
        name: 'SiliconFlow',
        provider: 'siliconflow',
        apiKey: 'sk-test-key-12345678',
        baseUrl: 'https://api.siliconflow.cn/v1',
      }],
      customModels: [],
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      expect(url).toContain('/models')
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-ai/DeepSeek-V3', object: 'model' },
          { id: 'Qwen/Qwen2.5-72B-Instruct', object: 'model', owned_by: 'qwen' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      const app = createSettingsRoutes()
      const res = await app.request('/settings/custom-providers/p-sf/remote-models')
      const body = await res.json() as {
        account: { id: string; provider: string }
        models: Array<{ id: string; name: string }>
      }
      expect(res.status).toBe(200)
      expect(body.account.id).toBe('p-sf')
      expect(body.account.provider).toBe('siliconflow')
      expect(body.models.map((m) => m.id).sort()).toEqual([
        'Qwen/Qwen2.5-72B-Instruct',
        'deepseek-ai/DeepSeek-V3',
      ].sort())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('GET returns 404 for unknown provider account', async () => {
    const app = createSettingsRoutes()
    const res = await app.request('/settings/custom-providers/missing/remote-models')
    expect(res.status).toBe(404)
  })
})
