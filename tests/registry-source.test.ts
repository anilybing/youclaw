import { describe, expect, test } from 'bun:test'
import {
  filterVisibleRegistrySources,
  isFirstPartyRegistrySource,
  isThirdPartySkillSourcesEnabled,
  resolveMarketplaceActionSource,
  resolvePreferredRegistrySource,
} from '../web/src/lib/registry-source.ts'

const allSources: Array<{ id: 'recommended' | 'clawhub' | 'tencent' }> = [
  { id: 'recommended' },
  { id: 'clawhub' },
  { id: 'tencent' },
]

const allSourceInfos = [
  { id: 'xiaojuclaw' },
  { id: 'recommended' },
  { id: 'clawhub' },
  { id: 'tencent' },
] as unknown as Parameters<typeof filterVisibleRegistrySources>[0]

describe('registry source helpers', () => {
  test('recommended installs use Tencent for zh locale', () => {
    expect(resolveMarketplaceActionSource('recommended', allSources, 'zh')).toBe('tencent')
  })

  test('recommended installs use ClawHub for non-zh locales', () => {
    expect(resolveMarketplaceActionSource('recommended', allSources, 'en')).toBe('clawhub')
  })

  test('explicit remote source overrides locale defaults', () => {
    expect(resolveMarketplaceActionSource('tencent', allSources, 'en')).toBe('tencent')
    expect(resolveMarketplaceActionSource('clawhub', allSources, 'zh')).toBe('clawhub')
  })
})

// [XJC] 技能市场第三方源开关（本地偏好 + 远程配置）
describe('third-party skill source toggle', () => {
  test('disabled toggle keeps only the first-party xiaojuclaw source', () => {
    expect(filterVisibleRegistrySources(allSourceInfos, false).map((source) => source.id)).toEqual(['xiaojuclaw'])
  })

  test('enabled toggle keeps all sources', () => {
    expect(filterVisibleRegistrySources(allSourceInfos, true).map((source) => source.id))
      .toEqual(['xiaojuclaw', 'recommended', 'clawhub', 'tencent'])
  })

  test('visibility is user preference OR remote flag', () => {
    expect(isThirdPartySkillSourcesEnabled(false, false)).toBe(false)
    expect(isThirdPartySkillSourcesEnabled(true, false)).toBe(true)
    expect(isThirdPartySkillSourcesEnabled(false, true)).toBe(true)
    expect(isThirdPartySkillSourcesEnabled(true, true)).toBe(true)
  })

  test('only xiaojuclaw counts as first-party', () => {
    expect(isFirstPartyRegistrySource('xiaojuclaw')).toBe(true)
    expect(isFirstPartyRegistrySource('recommended')).toBe(false)
    expect(isFirstPartyRegistrySource('clawhub')).toBe(false)
    expect(isFirstPartyRegistrySource('tencent')).toBe(false)
  })

  test('hidden preferred source falls back to xiaojuclaw', () => {
    const visible = filterVisibleRegistrySources(allSourceInfos, false)
    expect(resolvePreferredRegistrySource(visible, 'tencent', 'zh')).toBe('xiaojuclaw')
    expect(resolvePreferredRegistrySource(visible, 'clawhub', 'en')).toBe('xiaojuclaw')
  })
})
