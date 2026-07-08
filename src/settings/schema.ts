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

export const CustomModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: CustomModelProviderSchema.default('anthropic'),
  apiKey: z.string(),
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

export const SettingsSchema = z.object({
  activeModel: ActiveModelSchema,
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
})

export type Settings = z.infer<typeof SettingsSchema>
export type ActiveModel = z.infer<typeof ActiveModelSchema>
export type CustomModel = z.infer<typeof CustomModelSchema>
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>
export type VoiceAsrConfig = z.infer<typeof VoiceAsrConfigSchema>
export type VoiceTtsConfig = z.infer<typeof VoiceTtsConfigSchema>
