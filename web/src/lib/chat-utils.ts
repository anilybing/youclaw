export type ChatItem = {
  chat_id: string
  name: string
  agent_id: string
  channel: string
  last_message_time: string
  last_message: string | null
  avatar: string | null
}

/** 8 full-spectrum preset gradient colors */
export const PRESET_GRADIENTS = [
  'linear-gradient(135deg, oklch(0.65 0.18 0), oklch(0.50 0.15 40))',       // red
  'linear-gradient(135deg, oklch(0.65 0.18 30), oklch(0.50 0.15 70))',      // orange
  'linear-gradient(135deg, oklch(0.65 0.18 60), oklch(0.50 0.15 100))',     // yellow
  'linear-gradient(135deg, oklch(0.65 0.15 120), oklch(0.50 0.13 160))',    // green
  'linear-gradient(135deg, oklch(0.65 0.15 180), oklch(0.50 0.13 220))',    // cyan
  'linear-gradient(135deg, oklch(0.60 0.15 240), oklch(0.48 0.13 280))',    // blue
  'linear-gradient(135deg, oklch(0.62 0.17 270), oklch(0.48 0.15 310))',    // purple
  'linear-gradient(135deg, oklch(0.62 0.17 310), oklch(0.48 0.15 350))',    // pink
] as const

/**
 * 把 chat.channel 归一到已知渠道类型 key。
 * 兼容两种存量取值：类型串（"wechat-personal"）与实例 id（"telegram-abc123"）。
 * web/task 等非 IM 渠道返回 null。
 */
export function matchChannelType(
  channel: string | null | undefined,
  knownTypes: string[],
): string | null {
  if (!channel) return null
  if (knownTypes.includes(channel)) return channel
  let best: string | null = null
  for (const type of knownTypes) {
    if (channel.startsWith(`${type}-`) && (!best || type.length > best.length)) {
      best = type
    }
  }
  return best
}

/** 定时任务落库会话名的内部前缀（scheduler：`Task: <名称>`）。 */
const TASK_NAME_PREFIX = 'Task: '

/** 是否为定时任务生成的会话（channel==='task' 或 chatId 以 task: 前缀）。 */
export function isTaskChat(chat: Pick<ChatItem, 'channel' | 'chat_id'>): boolean {
  return chat.channel === 'task' || chat.chat_id.startsWith('task:')
}

/**
 * 会话名展示兜底：
 *   - 定时任务会话名形如 `Task: xxx`，去掉内部英文前缀只显示 `xxx`（徽标已标「定时任务」）；
 *   - 存量数据可能把原始渠道 type（如 "wechat-personal"）存成会话名，映射成本地化类型名；
 *   - 其余原样返回。
 */
export function resolveChatDisplayName(
  name: string,
  typeLabels: Record<string, string>,
): string {
  if (name.startsWith(TASK_NAME_PREFIX)) {
    const rest = name.slice(TASK_NAME_PREFIX.length).trim()
    if (rest) return rest
  }
  return typeLabels[name] ?? name
}

/**
 * 会话来源徽标文案：定时任务 → taskLabel；web/无来源 → null；
 * 其余渠道 → 本地化类型名（归一失败回退原始 channel 串）。
 */
export function resolveChatBadge(
  chat: Pick<ChatItem, 'channel' | 'chat_id'>,
  typeLabels: Record<string, string>,
  taskLabel: string,
): string | null {
  if (isTaskChat(chat)) return taskLabel
  const channel = chat.channel
  if (!channel || channel === 'web') return null
  const type = matchChannelType(channel, Object.keys(typeLabels))
  return type ? typeLabels[type] : channel
}

/**
 * 会话是否命中搜索：对「显示名 + 来源徽标 + 原始存储名」做小写包含匹配，
 * 这样搜中文类型名（微信个人号）/「定时任务」也能命中存量英文名会话。
 */
export function chatMatchesQuery(
  chat: ChatItem,
  query: string,
  typeLabels: Record<string, string>,
  taskLabel: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    resolveChatDisplayName(chat.name, typeLabels),
    resolveChatBadge(chat, typeLabels, taskLabel) ?? '',
    chat.name,
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

/** Resolve avatar field to CSS background value */
export function resolveAvatar(avatar: string | null): string {
  if (!avatar) return PRESET_GRADIENTS[0]
  if (avatar.startsWith('gradient:')) {
    const index = parseInt(avatar.split(':')[1], 10)
    return PRESET_GRADIENTS[index] ?? PRESET_GRADIENTS[0]
  }
  // Future extension: image type
  return PRESET_GRADIENTS[0]
}

// Group chats by date
export function groupChatsByDate(
  chats: ChatItem[],
  labels: { today: string; yesterday: string; older: string }
): { label: string; items: ChatItem[] }[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const today: ChatItem[] = []
  const yesterday: ChatItem[] = []
  const older: ChatItem[] = []

  for (const chat of chats) {
    const time = new Date(chat.last_message_time).getTime()
    if (time >= todayStart) today.push(chat)
    else if (time >= yesterdayStart) yesterday.push(chat)
    else older.push(chat)
  }

  const groups: { label: string; items: ChatItem[] }[] = []
  if (today.length) groups.push({ label: labels.today, items: today })
  if (yesterday.length) groups.push({ label: labels.yesterday, items: yesterday })
  if (older.length) groups.push({ label: labels.older, items: older })
  return groups
}
