import { useEffect, useMemo } from 'react'
import type { RegistrySelectableSource, RegistrySourceInfo } from '@/api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { filterVisibleRegistrySources, getRegistrySourceLabel } from '@/lib/registry-source'
import { useRemoteConfigStore } from '@/stores/remote-config'
import { cn } from '@/lib/utils'

export function RegistrySourceSelect({
  sources,
  value,
  onValueChange,
  disabled = false,
  className,
}: {
  sources: RegistrySourceInfo[]
  value: RegistrySelectableSource
  onValueChange: (value: RegistrySelectableSource) => void
  disabled?: boolean
  className?: string
}) {
  const { t } = useI18n()
  // 第三方源开关（T-C6）：关闭时只展示自有 xiaojuclaw 源
  const thirdPartyEnabled = useRemoteConfigStore((s) => s.flag('skills.thirdparty_enabled', false))
  const visibleSources = useMemo(
    () => filterVisibleRegistrySources(sources, thirdPartyEnabled),
    [sources, thirdPartyEnabled],
  )

  // 当前选中源被开关隐藏时自动切回自有源
  useEffect(() => {
    if (visibleSources.length > 0 && !visibleSources.some((source) => source.id === value)) {
      onValueChange('xiaojuclaw')
    }
  }, [visibleSources, value, onValueChange])

  return (
    <Select value={value} onValueChange={(next) => onValueChange(next as RegistrySelectableSource)} disabled={disabled}>
      <SelectTrigger className={cn('w-full sm:w-auto sm:min-w-max', className)}>
        <SelectValue placeholder={t.skills.marketplaceSourceLabel} />
      </SelectTrigger>
      <SelectContent>
        {visibleSources.map((source) => (
          <SelectItem key={source.id} value={source.id}>
            {getRegistrySourceLabel(source.id, visibleSources)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
