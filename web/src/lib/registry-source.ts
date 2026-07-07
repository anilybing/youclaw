import type { Locale } from '@/i18n'
import type { MarketplaceOrder, MarketplaceSort, RegistrySelectableSource, RegistrySourceInfo } from '@/api/client'

type RemoteRegistrySource = Exclude<RegistrySelectableSource, 'recommended'>
const hiddenMarketplaceSorts: MarketplaceSort[] = ['name']

// 自有私有源（第三方源开关关闭时仅保留这些源）
const FIRST_PARTY_REGISTRY_SOURCES: readonly RegistrySelectableSource[] = ['xiaojuclaw']

export function resolveLocaleDefaultRegistrySource(locale: Locale): RegistrySelectableSource {
  return locale === 'zh' ? 'tencent' : 'clawhub'
}

export function resolvePreferredRemoteRegistrySource(
  availableSources: Array<Pick<RegistrySourceInfo, 'id'>>,
  locale: Locale,
): RemoteRegistrySource {
  // 自有技能源存在即为默认源
  if (availableSources.some((source) => source.id === 'xiaojuclaw')) {
    return 'xiaojuclaw'
  }

  const localeDefault = resolveLocaleDefaultRegistrySource(locale)
  if (localeDefault !== 'recommended' && availableSources.some((source) => source.id === localeDefault)) {
    return localeDefault
  }

  const firstRemote = availableSources.find((source) => source.id !== 'recommended')?.id
  return firstRemote === 'tencent' ? 'tencent' : 'clawhub'
}

/**
 * 第三方源开关：
 * 关闭时源列表只保留自有 xiaojuclaw 源，clawhub / tencent / recommended 隐藏。
 */
export function filterVisibleRegistrySources(
  sources: RegistrySourceInfo[],
  thirdPartyEnabled: boolean,
): RegistrySourceInfo[] {
  if (thirdPartyEnabled) {
    return sources
  }
  return sources.filter((source) => FIRST_PARTY_REGISTRY_SOURCES.includes(source.id))
}

// [XJC] 第三方源可见性 = 用户本地偏好（设置页开关，默认关） OR 远程配置
// 'skills.thirdparty_enabled'（运营侧强制放开，默认 false）。两者都关时只展示小橘技能库。
export function isThirdPartySkillSourcesEnabled(
  userPreference: boolean,
  remoteFlagEnabled: boolean,
): boolean {
  return userPreference || remoteFlagEnabled
}

// [XJC] 自有源判定：第三方开关关闭后仅这些源可见/可选
export function isFirstPartyRegistrySource(source: RegistrySelectableSource): boolean {
  return FIRST_PARTY_REGISTRY_SOURCES.includes(source)
}

export function resolvePreferredRegistrySource(
  availableSources: Array<Pick<RegistrySourceInfo, 'id'>>,
  preferredSource: RegistrySelectableSource | undefined,
  locale: Locale,
): RegistrySelectableSource {
  if (preferredSource && availableSources.some((source) => source.id === preferredSource)) {
    return preferredSource
  }
  return resolvePreferredRemoteRegistrySource(availableSources, locale)
}

export function getRegistrySourceLabel(source: RegistrySelectableSource, sources: RegistrySourceInfo[]): string {
  return sources.find((item) => item.id === source)?.label
    ?? (source === 'xiaojuclaw' ? '小橘技能库' : source === 'recommended' ? 'Recommended' : source === 'tencent' ? 'Tencent' : 'ClawHub')
}

export function getRegistrySourceInfo(source: RegistrySelectableSource, sources: RegistrySourceInfo[]): RegistrySourceInfo | undefined {
  return sources.find((item) => item.id === source)
}

export function getAvailableMarketplaceSorts(source: RegistrySelectableSource, sources: RegistrySourceInfo[]): MarketplaceSort[] {
  const info = getRegistrySourceInfo(source, sources)
  return info?.capabilities.sorts.filter((sort) => !hiddenMarketplaceSorts.includes(sort)) ?? []
}

export function getDefaultMarketplaceSort(source: RegistrySelectableSource, sources: RegistrySourceInfo[]): MarketplaceSort | undefined {
  const info = getRegistrySourceInfo(source, sources)
  if (!info) {
    return undefined
  }

  const availableSorts = getAvailableMarketplaceSorts(source, sources)
  if (info.capabilities.defaultSort && availableSorts.includes(info.capabilities.defaultSort)) {
    return info.capabilities.defaultSort
  }

  return availableSorts[0]
}

export function resolveMarketplaceSort(
  source: RegistrySelectableSource,
  sources: RegistrySourceInfo[],
  sort: MarketplaceSort | undefined,
): MarketplaceSort | undefined {
  const availableSorts = getAvailableMarketplaceSorts(source, sources)
  if (sort && availableSorts.includes(sort)) {
    return sort
  }
  return getDefaultMarketplaceSort(source, sources)
}

export function resolveMarketplaceOrder(sort: MarketplaceSort | undefined, order: MarketplaceOrder | undefined): MarketplaceOrder {
  if (order === 'asc' || order === 'desc') {
    return order
  }
  return sort === 'name' ? 'asc' : 'desc'
}

export function resolveMarketplaceActionSource(
  selectedSource: RegistrySelectableSource | undefined,
  availableSources: Array<Pick<RegistrySourceInfo, 'id'>>,
  locale: Locale,
): RemoteRegistrySource {
  if (selectedSource === 'recommended') {
    const localeDefault = resolveLocaleDefaultRegistrySource(locale)
    if (localeDefault !== 'recommended' && availableSources.some((source) => source.id === localeDefault)) {
      return localeDefault
    }
  }

  if (selectedSource && selectedSource !== 'recommended') {
    return selectedSource
  }
  return resolvePreferredRemoteRegistrySource(availableSources, locale)
}
