/**
 * T-G3：model-hints 纯函数测试
 *
 * 覆盖：
 *   - isModelHint 白名单（合法 5 值 / 非法字符串 / 非字符串输入）
 *   - resolveRoutedModel 优先级：byHint[hint] → default → null
 *   - 空字符串字段视为缺（部分字段可单独生效）
 *   - 旧种子结构 { primary, fallback } 兼容
 *   - 畸形输入（null / 数组 / 标量）一律返回 null
 */

import { describe, expect, test } from 'bun:test'
import { MODEL_HINTS, isModelHint, resolveRoutedModel } from '../src/agent/model-hints.ts'

describe('isModelHint', () => {
  test('接受全部合法 hint', () => {
    expect(MODEL_HINTS).toEqual(['chat', 'reasoning', 'memory', 'fast', 'vision'])
    for (const hint of MODEL_HINTS) {
      expect(isModelHint(hint)).toBe(true)
    }
  })

  test('拒绝非法值与非字符串', () => {
    expect(isModelHint('hack')).toBe(false)
    expect(isModelHint('CHAT')).toBe(false)
    expect(isModelHint('')).toBe(false)
    expect(isModelHint(null)).toBe(false)
    expect(isModelHint(undefined)).toBe(false)
    expect(isModelHint(42)).toBe(false)
    expect(isModelHint(['chat'])).toBe(false)
  })
})

describe('resolveRoutedModel', () => {
  const routing = {
    default: { provider: 'openai', model: 'gpt-default' },
    byHint: {
      reasoning: { provider: 'windsurfapi', model: 'ws-reasoning' },
      fast: { provider: '', model: 'gpt-mini' },
    },
    fallback: [{ provider: 'mock', model: '' }],
  }

  test('byHint 命中优先于 default', () => {
    expect(resolveRoutedModel(routing, 'reasoning')).toEqual({
      provider: 'windsurfapi',
      model: 'ws-reasoning',
    })
  })

  test('byHint 局部字段：provider 空串保留 model', () => {
    expect(resolveRoutedModel(routing, 'fast')).toEqual({ provider: '', model: 'gpt-mini' })
  })

  test('byHint 未配置的 hint 回落 default', () => {
    expect(resolveRoutedModel(routing, 'memory')).toEqual({
      provider: 'openai',
      model: 'gpt-default',
    })
    expect(resolveRoutedModel(routing, 'chat')).toEqual({
      provider: 'openai',
      model: 'gpt-default',
    })
  })

  test('byHint 条目字段全空视为缺，回落 default', () => {
    const partial = {
      default: { provider: 'openai', model: 'gpt-default' },
      byHint: { vision: { provider: '', model: '' } },
    }
    expect(resolveRoutedModel(partial, 'vision')).toEqual({
      provider: 'openai',
      model: 'gpt-default',
    })
  })

  test('default 也为空 → null（沿用现状）', () => {
    const empty = {
      default: { provider: '', model: '' },
      byHint: {
        reasoning: { provider: '', model: '' },
        memory: { provider: '', model: '' },
        fast: { provider: '', model: '' },
        vision: { provider: '', model: '' },
      },
      fallback: [],
    }
    for (const hint of MODEL_HINTS) {
      expect(resolveRoutedModel(empty, hint)).toBeNull()
    }
  })

  test('字段带空白会被 trim；trim 后全空视为缺', () => {
    const spaced = { default: { provider: '  openai  ', model: ' m1 ' } }
    expect(resolveRoutedModel(spaced, 'chat')).toEqual({ provider: 'openai', model: 'm1' })
    expect(resolveRoutedModel({ default: { provider: '  ', model: ' ' } }, 'chat')).toBeNull()
  })

  test('兼容旧种子结构 { primary, fallback }', () => {
    expect(resolveRoutedModel({ primary: 'legacy-model', fallback: [] }, 'chat')).toEqual({
      provider: '',
      model: 'legacy-model',
    })
    expect(resolveRoutedModel({ primary: '', fallback: [] }, 'reasoning')).toBeNull()
  })

  test('畸形输入一律 null', () => {
    expect(resolveRoutedModel(null, 'chat')).toBeNull()
    expect(resolveRoutedModel(undefined, 'chat')).toBeNull()
    expect(resolveRoutedModel('routing', 'chat')).toBeNull()
    expect(resolveRoutedModel([], 'chat')).toBeNull()
    expect(resolveRoutedModel({ default: 'oops', byHint: 7 }, 'chat')).toBeNull()
    expect(resolveRoutedModel({ default: ['a'], byHint: { chat: 'x' } }, 'chat')).toBeNull()
  })
})
