import { describe, expect, test } from 'bun:test'
import './setup-light.ts'
import { resolvePiModel, resolveManualReasoningProfile } from '../src/agent/model-resolver.ts'

describe('resolvePiModel', () => {
  test('preserves qualified proxy model ids for built-in cloud routes', () => {
    const model = resolvePiModel({
      apiKey: 'token',
      baseUrl: 'https://www.xiaojuclaw.top/api',
      modelId: 'minimax/MiniMax-M2.5-highspeed',
      provider: 'builtin',
    })

    expect(model.provider).toBe('minimax')
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toBe('https://www.xiaojuclaw.top/api')
    expect(model.id).toBe('minimax/MiniMax-M2.5-highspeed')
  })

  test('infers minimax anthropic api for proxy models missing from the local registry', () => {
    const model = resolvePiModel({
      apiKey: 'token',
      baseUrl: 'https://www.xiaojuclaw.top/api',
      modelId: 'minimax/MiniMax-M2.7-highspeed',
      provider: 'builtin',
    })

    expect(model.provider).toBe('minimax')
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toBe('https://www.xiaojuclaw.top/api')
    expect(model.id).toBe('minimax/MiniMax-M2.7-highspeed')
  })

  test('uses the GLM OpenAI-compatible defaults for manual models', () => {
    const model = resolvePiModel({
      apiKey: 'token',
      baseUrl: '',
      modelId: 'glm-4.6',
      provider: 'glm',
    })

    expect(model.provider).toBe('glm')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(model.id).toBe('glm-4.6')
  })

  test('uses the OpenRouter v1 base url for manual models', () => {
    const model = resolvePiModel({
      apiKey: 'token',
      baseUrl: '',
      modelId: 'openai/gpt-4.1-mini',
      provider: 'openrouter',
    })

    expect(model.provider).toBe('openrouter')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(model.id).toBe('openai/gpt-4.1-mini')
  })

  // [XJC] 混合推理模型思考模式：此前手动构造一律 reasoning:false，GLM-5.x 全程跑快答模式
  test('enables thinking for manually constructed glm-5.x with zai compat', () => {
    const model = resolvePiModel({
      apiKey: 'token',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      modelId: 'glm-5.2',
      provider: 'glm',
    }) as any

    expect(model.reasoning).toBe(true)
    expect(model.maxTokens).toBe(16384)
    expect(model.compat?.thinkingFormat).toBe('zai')
    expect(model.compat?.maxTokensField).toBe('max_tokens')
  })

  test('glm-4.6 gets thinking, older glm-4.5 stays fast-mode but keeps zai compat', () => {
    expect(resolveManualReasoningProfile('glm', 'glm-4.6').reasoning).toBe(true)
    const older = resolveManualReasoningProfile('glm', 'glm-4.5')
    expect(older.reasoning).toBe(false)
    expect(older.compat?.thinkingFormat).toBe('zai')
  })

  // [XJC] 聚合源实测形态（硅基流动 zai-org/GLM-5.2）：org 前缀家族识别 + 保守输出预算
  test('aggregator-hosted GLM (zai-org/GLM-5.2 via siliconflow) gets thinking with conservative maxTokens', () => {
    const profile = resolveManualReasoningProfile('zai-org', 'zai-org/GLM-5.2', 'https://api.siliconflow.cn/v1')
    expect(profile.reasoning).toBe(true)
    expect(profile.maxTokens).toBe(8192)
    expect(profile.compat?.thinkingFormat).toBe('zai')

    const official = resolveManualReasoningProfile('glm', 'glm-5.2', 'https://open.bigmodel.cn/api/paas/v4')
    expect(official.maxTokens).toBe(16384)
  })

  test('qwen3 and deepseek reasoning families are recognized', () => {
    const qwen = resolveManualReasoningProfile('qwen', 'qwen3-max-thinking')
    expect(qwen.reasoning).toBe(true)
    expect(qwen.compat?.thinkingFormat).toBe('qwen')

    const ds = resolveManualReasoningProfile('deepseek', 'deepseek-reasoner')
    expect(ds.reasoning).toBe(true)
    expect(ds.compat?.supportsReasoningEffort).toBe(false)
  })

  test('unknown manual models keep the legacy fast-mode profile', () => {
    const profile = resolveManualReasoningProfile('openrouter', 'some-random-model')
    expect(profile.reasoning).toBe(false)
    expect(profile.maxTokens).toBe(8192)
    expect(profile.compat).toBeUndefined()
  })

  test('XJC_MANUAL_REASONING=off restores the legacy profile', () => {
    process.env.XJC_MANUAL_REASONING = 'off'
    try {
      const model = resolvePiModel({
        apiKey: 'token',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelId: 'glm-5.2',
        provider: 'glm',
      }) as any
      expect(model.reasoning).toBe(false)
      expect(model.maxTokens).toBe(8192)
    } finally {
      delete process.env.XJC_MANUAL_REASONING
    }
  })
})
