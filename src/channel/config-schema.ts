// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { z } from 'zod/v4'
import { BUILD_CONSTANTS } from '../config/build-constants.ts'

// ===== Config schema for each channel type =====

// [XJC] 不做线上域名硬编码回退：离线版构建时 BUILD_CONSTANTS 会把该键置空字符串，
// 若用 `|| 'https://...'` 兜底会把线上域名塞回离线包，导致各渠道教程按钮指向死链。
// 空串场景下 DOCS_BASE_URL 与各渠道 docsUrl 一并置空 → 前端条件渲染自动隐藏教程按钮。
const WEBSITE_URL = (BUILD_CONSTANTS['XiaoJuClaw_WEBSITE_URL'] || '').replace(/\/+$/, '')
// [XJC] 渠道文档统一指向官网教程页（MVP 无 /docs/* 路径，避免落到管理后台）；
// 用 hash 区分渠道，教程页可按需锚点定位。WEBSITE_URL 为空（离线版）时整体置空，
// 避免拼出 `/site/...` 半截路径。
const DOCS_BASE_URL = WEBSITE_URL ? `${WEBSITE_URL}/site/tutorials.html#channel` : ''
// 各渠道教程链接：DOCS_BASE_URL 为空时返回空串（而非 `/anchor` 半截路径），
// 让前端 `docsUrl && (...)` 条件渲染在离线版自动隐藏教程按钮。
const channelDocs = (anchor: string): string => (DOCS_BASE_URL ? `${DOCS_BASE_URL}/${anchor}` : '')

export const TelegramConfigSchema = z.object({
  botToken: z.string().min(1),
})

export const FeishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
})

export const QQConfigSchema = z.object({
  botAppId: z.string().min(1),
  botSecret: z.string().min(1),
})

export const WeComConfigSchema = z.object({
  corpId: z.string().min(1),
  corpSecret: z.string().min(1),
  agentId: z.string().min(1),
  token: z.string().min(1),
  encodingAESKey: z.string().min(1),
})

export const DingTalkConfigSchema = z.object({
  appKey: z.string().min(1),
  appSecret: z.string().min(1),
})

export const WechatOAConfigSchema = z.object({})
export const WechatPersonalConfigSchema = z.object({
  accountId: z.string().optional(),
  cdnBaseUrl: z.string().optional(),
})

// ===== Config field descriptors =====

export interface ConfigFieldInfo {
  key: string
  label: string
  placeholder: string
  secret: boolean
}

// ===== Channel type metadata =====

export interface ChannelTypeInfo {
  type: string
  label: string
  description: string
  chatIdPrefix: string
  configFields: ConfigFieldInfo[]
  docsUrl: string
  configSchema: z.ZodType
  hidden?: boolean
}

// [XJC] label/description 面向用户展示，统一中文（Telegram 保留通用英文名）。
// 代码逻辑一律按 type 判断，label 仅作展示，改名不影响路由/工厂分发。
export const CHANNEL_TYPE_REGISTRY: Record<string, ChannelTypeInfo> = {
  telegram: {
    type: 'telegram',
    label: 'Telegram',
    description: 'Telegram 机器人（Bot API 长轮询）',
    chatIdPrefix: 'tg:',
    configFields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...', secret: true },
    ],
    docsUrl: channelDocs('telegram'),
    configSchema: TelegramConfigSchema,
  },
  feishu: {
    type: 'feishu',
    label: '飞书',
    description: '飞书机器人（WebSocket 长连接）',
    chatIdPrefix: 'feishu:',
    configFields: [
      { key: 'appId', label: 'App ID', placeholder: 'cli_xxxxx', secret: false },
      { key: 'appSecret', label: 'App Secret', placeholder: '', secret: true },
    ],
    docsUrl: channelDocs('feishu'),
    configSchema: FeishuConfigSchema,
  },
  qq: {
    type: 'qq',
    label: 'QQ',
    description: 'QQ 机器人（官方 Bot API）',
    chatIdPrefix: 'qq:',
    configFields: [
      { key: 'botAppId', label: '机器人 App ID', placeholder: '', secret: false },
      { key: 'botSecret', label: '机器人 Secret', placeholder: '', secret: true },
    ],
    docsUrl: channelDocs('qq'),
    configSchema: QQConfigSchema,
  },
  wecom: {
    type: 'wecom',
    label: '企业微信',
    description: '企业微信机器人（Webhook 回调）',
    chatIdPrefix: 'wecom:',
    configFields: [
      { key: 'corpId', label: '企业 ID', placeholder: 'ww...', secret: false },
      { key: 'corpSecret', label: '企业 Secret', placeholder: '', secret: true },
      { key: 'agentId', label: '应用 Agent ID', placeholder: '1000001', secret: false },
      { key: 'token', label: '回调 Token', placeholder: '', secret: true },
      { key: 'encodingAESKey', label: 'Encoding AES Key', placeholder: '43 位字符', secret: true },
    ],
    docsUrl: 'https://developer.work.weixin.qq.com',
    configSchema: WeComConfigSchema,
    hidden: true,
  },
  dingtalk: {
    type: 'dingtalk',
    label: '钉钉',
    description: '钉钉机器人（Stream 模式）',
    chatIdPrefix: 'dingtalk:',
    configFields: [
      { key: 'appKey', label: 'App Key', placeholder: '', secret: false },
      { key: 'appSecret', label: 'App Secret', placeholder: '', secret: true },
    ],
    docsUrl: channelDocs('dingtalk'),
    configSchema: DingTalkConfigSchema,
  },
  'wechat-oa': {
    type: 'wechat-oa',
    label: '微信公众号',
    description: '通过云桥接接入的微信公众号（长轮询）',
    chatIdPrefix: 'wxoa:',
    configFields: [],
    docsUrl: channelDocs('wechat-oa'),
    configSchema: WechatOAConfigSchema,
  },
  'wechat-personal': {
    type: 'wechat-personal',
    label: '微信个人号',
    description: '通过兼容桥接接入的微信个人号',
    chatIdPrefix: 'wxp:',
    configFields: [],
    docsUrl: channelDocs('wechat-personal'),
    configSchema: WechatPersonalConfigSchema,
  },
}

/**
 * Infer channel type from chatId prefix
 * Matches against registered chatIdPrefix entries
 */
export function inferChannelType(chatId: string): string {
  for (const info of Object.values(CHANNEL_TYPE_REGISTRY)) {
    if (chatId.startsWith(info.chatIdPrefix)) {
      return info.type
    }
  }
  return 'web'
}

/**
 * Validate config object by channel type
 */
export function validateChannelConfig(type: string, config: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const typeInfo = CHANNEL_TYPE_REGISTRY[type]
  if (!typeInfo) {
    return { success: false, error: `Unknown channel type: ${type}` }
  }

  const result = typeInfo.configSchema.safeParse(config)
  if (!result.success) {
    return { success: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }

  return { success: true, data: result.data as Record<string, unknown> }
}

/**
 * Mask secret fields in config (for GET responses)
 */
export function maskSecretFields(type: string, config: Record<string, unknown>): { masked: Record<string, string>; configuredFields: string[] } {
  const typeInfo = CHANNEL_TYPE_REGISTRY[type]
  const masked: Record<string, string> = {}
  const configuredFields: string[] = []

  if (!typeInfo) return { masked, configuredFields }

  for (const field of typeInfo.configFields) {
    const val = config[field.key]
    if (val && typeof val === 'string' && val.length > 0) {
      configuredFields.push(field.key)
      masked[field.key] = field.secret ? '' : val
    } else {
      masked[field.key] = ''
    }
  }

  return { masked, configuredFields }
}
