// [XJC-PATCH] G6.2 渠道消息日摘要：IM 渠道当日会话 → 当日记忆「渠道消息」段
//
// 规划出处：doc/数字员工能力增强规划 T-G6 内容 2
// 「钉钉/飞书/企微会话每日随 G1 蒸馏进记忆（提及的人/事/待办）」。
//
// 设计（与 folder-ingest 同款「纯代码 + 确定性摘要」路线）：
// - 素材从 messages/chats 表按渠道前缀取当日消息（DB 是全量未截断的权威来源；
//   memory/logs/ 只有截断版且混着 web 会话）；
// - 每个渠道会话折叠成一行：会话名 + 消息量 + 头尾若干条原文片段，不调 LLM；
// - 写入当日记忆「## 渠道消息」段，与「## 文档摄取」并列，成为 G1 23:50
//   日蒸馏的素材——真正的语义提炼（人/事/待办）由蒸馏任务完成；
// - 幂等：靠 kv_state 游标（channel_digest_state：date + 已消化的最大 timestamp），
//   同日重复运行只追加新增量；每日 23:40 由 ingest-scheduler 对齐触发一次，
//   赶在 23:50 日蒸馏之前。
//
// 隐私红线：
// - 素材全部来自本地 DB 已有内容，不新增采集面；
// - 摘要片段逐条截断（EXCERPT 上限），绝不整段复制长对话；
// - 游标只存日期 + 时间戳水位，不含任何消息内容；
// - 开关 channelDigestEnabled（ingest_settings）可随时关闭。

import { getDatabase } from '../db/index.ts'
import { getLogger } from '../logger/index.ts'
import { CHANNEL_TYPE_REGISTRY } from '../channel/config-schema.ts'
import { getIngestSettings } from './settings.ts'
import { appendDailyMemorySection, localDateStr, resolveIngestAgentId } from './folder-ingest.ts'

/** 单条消息片段截断长度（摘要仅保留会话首尾片段，防长文灌入记忆） */
export const MESSAGE_SNIPPET_MAX_CHARS = 120
/** 每个会话保留的首/尾消息片段数 */
export const SNIPPETS_PER_CHAT = 3
/** 单轮摘要最多覆盖的会话数（超出只计数不展开，防群聊风暴撑爆当日记忆） */
export const MAX_CHATS_PER_DIGEST = 20

const STATE_KEY = 'channel_digest_state'

/** 游标：date 变更即重置水位；仅存时间戳水位，无消息内容（隐私红线） */
interface ChannelDigestState {
  date: string
  /** 已消化消息的最大 timestamp（ISO 字符串，与 messages.timestamp 同源） */
  watermark: string
}

function loadState(): ChannelDigestState | null {
  const db = getDatabase()
  const row = db.query('SELECT value FROM kv_state WHERE key = ?').get(STATE_KEY) as { value: string } | null
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<ChannelDigestState>
    if (typeof parsed?.date === 'string' && typeof parsed?.watermark === 'string') {
      return { date: parsed.date, watermark: parsed.watermark }
    }
  } catch {
    // 损坏按无游标处理（代价：当日重复段落，可被 G1 蒸馏归并）
  }
  return null
}

function saveState(state: ChannelDigestState): void {
  const db = getDatabase()
  db.run('INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)', [STATE_KEY, JSON.stringify(state)])
}

/** IM 渠道 chatId 前缀（web/task/system 一律排除——只蒸馏外部渠道会话） */
export function imChatIdPrefixes(): string[] {
  return Object.values(CHANNEL_TYPE_REGISTRY).map((info) => info.chatIdPrefix)
}

interface DigestMessageRow {
  chat_id: string
  chat_name: string | null
  channel: string | null
  sender_name: string | null
  content: string | null
  timestamp: string
  is_bot_message: number
}

/**
 * 取「本地日期 date 内、timestamp 水位之后」的 IM 渠道消息。
 * 用 chat_id 前缀过滤而非 chats.channel：前缀是 adapter 写入时的硬约定
 * （config-schema chatIdPrefix），channel 列则可能是 record.id 等自由值。
 */
function fetchChannelMessages(dayStartIso: string, dayEndIso: string, watermark: string | null): DigestMessageRow[] {
  const db = getDatabase()
  const prefixes = imChatIdPrefixes()
  const prefixCond = prefixes.map(() => 'm.chat_id LIKE ?').join(' OR ')
  const params: (string | number)[] = prefixes.map((p) => `${p}%`)

  let timeCond = 'm.timestamp >= ? AND m.timestamp < ?'
  params.push(dayStartIso, dayEndIso)
  if (watermark) {
    timeCond += ' AND m.timestamp > ?'
    params.push(watermark)
  }

  return db
    .query(
      `SELECT m.chat_id, c.name AS chat_name, c.channel, m.sender_name, m.content, m.timestamp, m.is_bot_message
       FROM messages m
       LEFT JOIN chats c ON c.chat_id = m.chat_id
       WHERE (${prefixCond}) AND ${timeCond}
       ORDER BY m.timestamp ASC`,
    )
    .all(...params) as DigestMessageRow[]
}

/** 单条消息 → 「发送者: 片段」，合并空白 + 截断（确定性，零成本） */
export function buildMessageSnippet(row: DigestMessageRow, maxChars: number = MESSAGE_SNIPPET_MAX_CHARS): string {
  const who = row.is_bot_message ? '助手' : (row.sender_name || '对方')
  const collapsed = String(row.content || '').replace(/\s+/g, ' ').trim()
  const body = collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`
  return `${who}: ${body || '（空消息/附件）'}`
}

interface ChatDigest {
  chatId: string
  title: string
  total: number
  lines: string[]
}

/** 把一个会话的当日消息折叠成「首 N + 尾 N」片段行 */
function digestOneChat(chatId: string, rows: DigestMessageRow[]): ChatDigest {
  const first = rows[0]
  const title = (first?.chat_name || '').trim() || chatId
  const head = rows.slice(0, SNIPPETS_PER_CHAT)
  const tail = rows.length > SNIPPETS_PER_CHAT * 2 ? rows.slice(-SNIPPETS_PER_CHAT) : rows.slice(head.length)
  const lines = [...head.map((r) => buildMessageSnippet(r))]
  if (rows.length > SNIPPETS_PER_CHAT * 2) {
    lines.push(`……（中间省略 ${rows.length - SNIPPETS_PER_CHAT * 2} 条）`)
  }
  lines.push(...tail.map((r) => buildMessageSnippet(r)))
  return { chatId, title, total: rows.length, lines }
}

export interface ChannelDigestResult {
  enabled: boolean
  agentId: string | null
  /** 本轮消化的消息条数（0 = 无新消息，未写记忆） */
  messages: number
  chats: number
}

export interface ChannelDigestDeps {
  hasAgent?: (agentId: string) => boolean
  now?: Date
}

/**
 * 执行一轮渠道消息日摘要：当日水位后的 IM 消息 → 按会话折叠 → 追加当日记忆。
 * 幂等靠时间戳水位：同日重复调用只消化新增量；无新消息不写文件。
 */
export function runChannelDigest(deps: ChannelDigestDeps = {}): ChannelDigestResult {
  const logger = getLogger()
  const settings = getIngestSettings()
  if (!settings.channelDigestEnabled) {
    return { enabled: false, agentId: null, messages: 0, chats: 0 }
  }

  const now = deps.now ?? new Date()
  const today = localDateStr(now)

  // 本地日界转 ISO（messages.timestamp 是 toISOString() 写入的 UTC 串，
  // 比较必须同为 UTC——用本地 00:00/24:00 的时刻值转 ISO，不能拼日期字符串）
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  const prevState = loadState()
  const watermark = prevState?.date === today ? prevState.watermark : null

  const rows = fetchChannelMessages(dayStart.toISOString(), dayEnd.toISOString(), watermark)
  if (rows.length === 0) {
    return { enabled: true, agentId: null, messages: 0, chats: 0 }
  }

  // 按会话分组（保持时间序）
  const byChat = new Map<string, DigestMessageRow[]>()
  for (const row of rows) {
    const list = byChat.get(row.chat_id)
    if (list) list.push(row)
    else byChat.set(row.chat_id, [row])
  }

  const digests = [...byChat.entries()].map(([chatId, chatRows]) => digestOneChat(chatId, chatRows))
  const shown = digests.slice(0, MAX_CHATS_PER_DIGEST)
  const omitted = digests.length - shown.length

  const time = now.toTimeString().slice(0, 5)
  const blockLines: string[] = []
  for (const digest of shown) {
    blockLines.push(`- [${time}] 会话「${digest.title}」新增 ${digest.total} 条（仅摘要片段，原文在会话记录）：`)
    for (const line of digest.lines) {
      blockLines.push(`  - ${line}`)
    }
  }
  if (omitted > 0) {
    blockLines.push(`- 另有 ${omitted} 个会话共 ${digests.slice(MAX_CHATS_PER_DIGEST).reduce((n, d) => n + d.total, 0)} 条消息未展开`)
  }

  const agentId = resolveIngestAgentId(deps.hasAgent)
  appendDailyMemorySection(agentId, '渠道消息', blockLines.join('\n'), now)

  // 水位推进到本轮最后一条（rows 已按 timestamp ASC 排序）
  saveState({ date: today, watermark: rows[rows.length - 1]!.timestamp })

  logger.info(
    { agentId, messages: rows.length, chats: digests.length, category: 'channel-digest' },
    'Channel digest written to daily memory',
  )
  return { enabled: true, agentId, messages: rows.length, chats: digests.length }
}
