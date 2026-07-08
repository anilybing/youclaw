// [XJC-PATCH] 商业化专属：渠道实例默认命名与渠道会话标题推导
import { CHANNEL_TYPE_REGISTRY } from './config-schema.ts'

/** 渠道类型的用户可见名称（注册表 label，未知类型回退 type 本身） */
export function channelTypeLabel(type: string): string {
  return CHANNEL_TYPE_REGISTRY[type]?.label ?? type
}

/** senderName 为这些占位值时视为无效，不用于会话标题 */
const GENERIC_SENDER_NAMES = new Set(['unknown', 'user', 'wechat user'])

/**
 * senderName 是否是「真实昵称」：非空、非占位词，
 * 且不等于 sender 原始 ID（飞书/企微/QQ/微信个人号的 senderName
 * 就是原始 ID，这种情况视为拿不到昵称）。
 */
export function isMeaningfulSenderName(senderName: string | undefined, sender?: string): boolean {
  const trimmed = senderName?.trim()
  if (!trimmed) return false
  if (GENERIC_SENDER_NAMES.has(trimmed.toLowerCase())) return false
  if (sender !== undefined && trimmed === sender.trim()) return false
  return true
}

/**
 * 渠道会话标题推导（非 web 会话）：
 *   群聊：真实群名（groupName，渠道能拿到才有）→ 「label·群」回退。
 *   单聊：好友昵称（senderName）→ 渠道实例自定义 label → 类型中文名。
 * 绝不落回原始 type 字符串。
 */
export function deriveChannelChatTitle(params: {
  channelType: string
  sender?: string
  senderName?: string
  isGroup?: boolean
  groupName?: string
  instanceLabel?: string | null
}): string {
  const base = params.instanceLabel?.trim() || channelTypeLabel(params.channelType)
  if (params.isGroup) {
    const groupName = params.groupName?.trim()
    if (groupName) return groupName.slice(0, 50)
    return `${base}·群`
  }
  if (isMeaningfulSenderName(params.senderName, params.sender)) {
    return params.senderName!.trim().slice(0, 50)
  }
  return base
}

/**
 * 新建渠道实例的默认名称：「类型中文名 + 序号」（如「微信个人号 1」）。
 * 序号按同类型现存实例数递增，并避开已被占用的名称。
 */
export function generateDefaultChannelLabel(
  type: string,
  existing: Array<{ type: string; label: string }>,
): string {
  const typeLabel = channelTypeLabel(type)
  const usedLabels = new Set(existing.map((record) => record.label))
  let n = existing.filter((record) => record.type === type).length + 1
  let candidate = `${typeLabel} ${n}`
  while (usedLabels.has(candidate)) {
    n += 1
    candidate = `${typeLabel} ${n}`
  }
  return candidate
}
