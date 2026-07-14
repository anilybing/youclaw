// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { z } from 'zod/v4'

export const RegistrySourceSettingSchema = z.enum(['clawhub', 'recommended', 'tencent', 'xiaojuclaw'])
export type RegistrySourceSetting = z.infer<typeof RegistrySourceSettingSchema>

export const ActiveModelProvider = {
  Builtin: 'builtin',
  Custom: 'custom',
} as const

export const ACTIVE_MODEL_PROVIDERS = [
  ActiveModelProvider.Builtin,
  ActiveModelProvider.Custom,
] as const

export type ActiveModelProvider = typeof ACTIVE_MODEL_PROVIDERS[number]

export const ActiveModelProviderSchema = z.preprocess(
  (value) => value === 'cloud' ? ActiveModelProvider.Builtin : value,
  z.enum(ACTIVE_MODEL_PROVIDERS),
)

export const CustomModelProviderSchema = z.enum([
  'anthropic',
  'openai',
  'gemini',
  'minimax',
  'minimax-cn',
  'glm',
  'deepseek',
  'qwen',
  'moonshot',
  'doubao',
  'siliconflow',
  'openrouter',
  'groq',
  'xai',
  'mistral',
  'together',
  'fireworks',
  'ollama',
  'custom',
])

/** 供应商账户：一套 baseUrl + apiKey，可挂多个模型。 */
export const CustomProviderAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: CustomModelProviderSchema.default('custom'),
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
})

export const CustomModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: CustomModelProviderSchema.default('anthropic'),
  /** 引用 customProviders 中的账户；有值时优先用账户的 apiKey/baseUrl。 */
  providerAccountId: z.string().optional(),
  /** 遗留字段：无 providerAccountId 时仍可用；有账户引用时可为空。 */
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
  modelId: z.string(),
})

export const RegistrySourceConfigSchema = z.object({
  token: z.string().default(''),
})

export const TencentRegistryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  indexUrl: z.string().default('https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/skills.json'),
  searchUrl: z.string().default('https://lightmake.site/api/skills'),
  downloadUrl: z.string().default('https://lightmake.site/api/v1/download'),
})

export const DEFAULT_CLAWHUB_REGISTRY_SOURCE = RegistrySourceConfigSchema.parse({})
export const DEFAULT_TENCENT_REGISTRY_SOURCE = TencentRegistryConfigSchema.parse({})
export const ActiveModelSchema = z.object({
  provider: ActiveModelProviderSchema,
  id: z.string().optional(),
}).default({ provider: ActiveModelProvider.Builtin })

// [XJC] 语音能力配置（通用能力对齐 · T-A2）。provider='openai-compatible' 时走
// OpenAI 兼容 /audio/transcriptions（ASR）与 /audio/speech（TTS）端点；
// baseUrl/apiKey/model 由用户在设置页填写（不硬编码任何厂商域名，离线红线）。
export const VoiceProviderSchema = z.enum(['off', 'openai-compatible'])

export const VoiceAsrConfigSchema = z.object({
  provider: VoiceProviderSchema.default('off'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
})

export const VoiceTtsConfigSchema = z.object({
  provider: VoiceProviderSchema.default('off'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  voice: z.string().default(''),
})

export const DEFAULT_VOICE_ASR_CONFIG = VoiceAsrConfigSchema.parse({})
export const DEFAULT_VOICE_TTS_CONFIG = VoiceTtsConfigSchema.parse({})

export const VoiceSettingsSchema = z.object({
  asr: VoiceAsrConfigSchema.default(DEFAULT_VOICE_ASR_CONFIG),
  tts: VoiceTtsConfigSchema.default(DEFAULT_VOICE_TTS_CONFIG),
}).default({ asr: DEFAULT_VOICE_ASR_CONFIG, tts: DEFAULT_VOICE_TTS_CONFIG })

// [XJC] 自主进化引擎开关（进化引擎桥 src/evolution/service.ts）。
// 默认关闭：开启后事件驱动零 token 学习 + 行为提示注入（每轮几十 token）。
export const EvolutionSettingsSchema = z.object({
  enabled: z.boolean().default(false),
}).default({ enabled: false })

// [XJC] 内置 MCP Server 开关（对接 Cursor 等 MCP 客户端，src/mcp-server/service.ts）。
// 默认关闭；开启时若 token 为空由设置路由自动生成。危险工具另设默认关闭的二次开关，
// token 用于 /mcp 端点 Bearer 鉴权，防本机其他进程未授权调用。
export const McpServerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  allowDangerousTools: z.boolean().default(false),
  token: z.string().default(''),
}).default({ enabled: false, allowDangerousTools: false, token: '' })

// [XJC] Canary release channel. This is local application configuration and
// never depends on account/login state. Unknown legacy values fail back to the
// stable channel through SettingsSchema parsing.
export const UpdateReleaseChannelSchema = z.enum(['stable', 'beta'])
export const UpdateSettingsSchema = z.object({
  channel: UpdateReleaseChannelSchema.default('stable'),
}).default({ channel: 'stable' })

// [XJC] 媒体生成配置（图像生成/对话式改图/视频生成，src/media/service.ts）。
// provider='openai-compatible'：图像走 {baseUrl}/images/generations（改图模型经 image 字段传 base64），
//   视频走 {baseUrl}/video/submit → /video/status 轮询（硅基流动等 OpenAI 风格网关）。
// provider='dashscope'：阿里百炼原生生图/改图，走 {baseUrl}/services/aigc/multimodal-generation/generation
//   （qwen-image / 通义万相，与 OpenAI 端点不兼容）。仅图像组支持，视频组不支持 dashscope。
// 不硬编码任何厂商域名（离线红线）：baseUrl 一律由用户/预设填入。
export const MediaProviderSchema = z.enum(['off', 'openai-compatible', 'dashscope'])

export const MediaImageConfigSchema = z.object({
  provider: MediaProviderSchema.default('off'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  /** 文生图模型 */
  model: z.string().default(''),
  /** 改图（指令编辑）模型；留空则改图不可用 */
  editModel: z.string().default(''),
})

export const MediaVideoConfigSchema = z.object({
  provider: VoiceProviderSchema.default('off'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
})

export const DEFAULT_MEDIA_IMAGE_CONFIG = MediaImageConfigSchema.parse({})
export const DEFAULT_MEDIA_VIDEO_CONFIG = MediaVideoConfigSchema.parse({})

export const MediaSettingsSchema = z.object({
  image: MediaImageConfigSchema.default(DEFAULT_MEDIA_IMAGE_CONFIG),
  video: MediaVideoConfigSchema.default(DEFAULT_MEDIA_VIDEO_CONFIG),
}).default({ image: DEFAULT_MEDIA_IMAGE_CONFIG, video: DEFAULT_MEDIA_VIDEO_CONFIG })

// [XJC] 漫剧工作室配置（G0 视频渲染 provider 路由 + ¥ 预算硬闸，src/media/video-provider.ts）。
// videoRenderMode 默认 mock（不联网不烧钱）；env XJC_STUDIO_VIDEO_MODE 仅 CI/dry-run 覆盖。
export const StudioVideoRenderModeSchema = z.enum(['mock', 'live'])

export const StudioSettingsSchema = z.object({
  videoRenderMode: StudioVideoRenderModeSchema.default('mock'),
  /** 每 run 媒体渲染花费硬顶（¥ 全口径；SiliconFlow 按 ¥ 计费，用户预算 ¥32）。 */
  maxRenderCnyPerRun: z.number().default(32),
  /** tier→provider 路由（live 模式生效） */
  draftProvider: z.string().default('wan'),
  hqProvider: z.string().default('kling'),
  /** 各档视频模型 id（SiliconFlow） */
  draftModel: z.string().default('Wan-AI/Wan2.2-I2V-A14B'),
  hqModel: z.string().default(''),
  /** live provider 端点/密钥；留空则回退 env（SILICONFLOW_BASE_URL / SILICONFLOW_API_KEY） */
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
}).default({
  videoRenderMode: 'mock',
  maxRenderCnyPerRun: 32,
  draftProvider: 'wan',
  hqProvider: 'kling',
  draftModel: 'Wan-AI/Wan2.2-I2V-A14B',
  hqModel: '',
  baseUrl: '',
  apiKey: '',
})

export const DEFAULT_STUDIO_SETTINGS = StudioSettingsSchema.parse({})

export const SettingsSchema = z.object({
  activeModel: ActiveModelSchema,
  /** 供应商账户（一 Key 多模型） */
  customProviders: z.array(CustomProviderAccountSchema).default([]),
  customModels: z.array(CustomModelSchema).default([]),
  defaultRegistrySource: RegistrySourceSettingSchema.optional(),
  registrySources: z.object({
    clawhub: RegistrySourceConfigSchema.default(DEFAULT_CLAWHUB_REGISTRY_SOURCE),
    tencent: TencentRegistryConfigSchema.default(DEFAULT_TENCENT_REGISTRY_SOURCE),
  }).default({
    clawhub: DEFAULT_CLAWHUB_REGISTRY_SOURCE,
    tencent: DEFAULT_TENCENT_REGISTRY_SOURCE,
  }),
  voice: VoiceSettingsSchema,
  evolution: EvolutionSettingsSchema,
  media: MediaSettingsSchema,
  studio: StudioSettingsSchema,
  mcpServer: McpServerSettingsSchema,
  update: UpdateSettingsSchema,
})

export type Settings = z.infer<typeof SettingsSchema>
export type ActiveModel = z.infer<typeof ActiveModelSchema>
export type CustomProviderAccount = z.infer<typeof CustomProviderAccountSchema>
export type CustomModel = z.infer<typeof CustomModelSchema>
export type CustomModelProvider = z.infer<typeof CustomModelProviderSchema>
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>
export type VoiceAsrConfig = z.infer<typeof VoiceAsrConfigSchema>
export type VoiceTtsConfig = z.infer<typeof VoiceTtsConfigSchema>
export type MediaSettings = z.infer<typeof MediaSettingsSchema>
export type MediaImageConfig = z.infer<typeof MediaImageConfigSchema>
export type MediaVideoConfig = z.infer<typeof MediaVideoConfigSchema>
export type StudioSettings = z.infer<typeof StudioSettingsSchema>
export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>
