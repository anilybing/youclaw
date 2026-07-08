// 定时任务「结果投递」配置区块：仅记录 / 推送到 IM 渠道（Tasks 页与工作台共用）。
// 渠道下拉来自 /api/channels/types + /api/channels（标注连接状态），
// 会话 ID 建议来自 /api/chats 中带渠道前缀的既有会话。
import { useEffect, useMemo, useRef, useState } from 'react'
import { getChannelTypes, getChannels, getChats } from '@/api/client'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { TaskDeliveryMode } from '@/lib/task-delivery'
import { useI18n } from '@/i18n'

interface ChannelOption {
  type: string
  label: string
  prefix: string
  status: 'ready' | 'offline' | 'unconfigured'
}

interface RecentSession {
  chatId: string
  name: string
}

function findPrefixOption(options: ChannelOption[], target: string): ChannelOption | undefined {
  return options
    .filter((option) => target.startsWith(option.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]
}

export function TaskDeliveryFields({
  mode,
  target,
  onModeChange,
  onTargetChange,
  disabled,
}: {
  mode: TaskDeliveryMode
  target: string
  onModeChange: (mode: TaskDeliveryMode) => void
  onTargetChange: (target: string) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [options, setOptions] = useState<ChannelOption[]>([])
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([])
  const loadedRef = useRef(false)

  // 首次切到「推送」时按需加载渠道与会话数据
  useEffect(() => {
    if (mode !== 'push' || loadedRef.current) return
    loadedRef.current = true
    void (async () => {
      const [types, instances, chats] = await Promise.all([
        getChannelTypes().catch(() => []),
        getChannels().catch(() => []),
        getChats().catch(() => []),
      ])

      const nextOptions: ChannelOption[] = types
        .filter((info) => info.chatIdPrefix && (!info.hidden || instances.some((ch) => ch.type === info.type)))
        .map((info) => {
          const own = instances.filter((ch) => ch.type === info.type)
          const status: ChannelOption['status'] = own.some((ch) => ch.connected)
            ? 'ready'
            : own.some((ch) => ch.enabled)
              ? 'offline'
              : 'unconfigured'
          return { type: info.type, label: info.label, prefix: info.chatIdPrefix, status }
        })
      setOptions(nextOptions)

      const prefixes = nextOptions.map((option) => option.prefix)
      const seen = new Set<string>()
      const sessions: RecentSession[] = []
      for (const chat of chats) {
        if (!prefixes.some((prefix) => chat.chat_id.startsWith(prefix))) continue
        if (seen.has(chat.chat_id)) continue
        seen.add(chat.chat_id)
        sessions.push({ chatId: chat.chat_id, name: chat.name })
        if (sessions.length >= 8) break
      }
      setRecentSessions(sessions)
    })()
  }, [mode])

  const selectedOption = useMemo(() => findPrefixOption(options, target), [options, target])

  const statusLabel = (status: ChannelOption['status']) =>
    status === 'ready'
      ? t.tasks.deliveryChannelStatusReady
      : status === 'offline'
        ? t.tasks.deliveryChannelStatusOffline
        : t.tasks.deliveryChannelStatusUnconfigured

  const handleChannelSelect = (type: string) => {
    const next = options.find((option) => option.type === type)
    if (!next) return
    const current = findPrefixOption(options, target)
    const rest = (current ? target.slice(current.prefix.length) : target).trimStart()
    onTargetChange(next.prefix + rest)
  }

  const visibleSessions = selectedOption
    ? recentSessions.filter((session) => session.chatId.startsWith(selectedOption.prefix))
    : recentSessions

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {(['none', 'push'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`task-delivery-mode-${value}`}
            onClick={() => onModeChange(value)}
            disabled={disabled}
            className={cn(
              'px-3 py-1.5 text-xs rounded-md border transition-colors',
              mode === value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-accent/30 border-border text-muted-foreground hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {value === 'none' ? t.tasks.deliveryModeNone : t.tasks.deliveryModePush}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {mode === 'push' ? t.tasks.deliveryModePushHint : t.tasks.deliveryModeNoneHint}
      </p>

      {mode === 'push' && (
        <div className="space-y-3 rounded-md border border-border bg-accent/10 p-3">
          {options.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground/85">{t.tasks.deliveryChannel}</label>
              <Select value={selectedOption?.type ?? ''} onValueChange={handleChannelSelect} disabled={disabled}>
                <SelectTrigger data-testid="task-delivery-channel" className="w-full">
                  <SelectValue placeholder={t.tasks.deliveryChannelPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem
                      key={option.type}
                      value={option.type}
                      data-testid={`task-delivery-channel-option-${option.type}`}
                    >
                      {option.label}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({option.prefix}) · {statusLabel(option.status)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-foreground/85">{t.tasks.deliveryTarget}</label>
            <Input
              data-testid="task-delivery-target"
              type="text"
              value={target}
              onChange={(e) => onTargetChange(e.target.value)}
              placeholder={
                selectedOption && selectedOption.type !== 'telegram'
                  ? `${selectedOption.prefix}…`
                  : t.tasks.deliveryTargetPlaceholder
              }
              disabled={disabled}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">{t.tasks.deliveryTargetHint}</p>
          </div>

          {visibleSessions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">{t.tasks.deliveryRecentSessions}</div>
              <div className="flex flex-wrap gap-1.5">
                {visibleSessions.map((session) => (
                  <button
                    key={session.chatId}
                    type="button"
                    data-testid={`task-delivery-recent-${session.chatId}`}
                    onClick={() => onTargetChange(session.chatId)}
                    disabled={disabled}
                    title={session.chatId}
                    className={cn(
                      'max-w-[280px] truncate rounded-full border px-2.5 py-1 text-xs transition-colors',
                      target === session.chatId
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-accent/20 text-muted-foreground hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    {session.name ? `${session.name} · ` : ''}
                    {session.chatId}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
