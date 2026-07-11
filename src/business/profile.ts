// [XJC] 一人公司经营画像：本地、结构化、用户确认后写入。
// 只保存非秘密经营元数据；客户资料、密钥、财务明细不得写入画像。
import { z } from 'zod/v4'
import { getDatabase } from '../db/index.ts'

const BUSINESS_PROFILE_KEY = 'business_profile_v1'
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
    return true
  } catch {
    return false
  }
}

const Text120Schema = z.string().trim().max(120)
const OfferSchema = z.string().trim().max(600)
const CustomerSchema = z.string().trim().max(400)
const ChannelsSchema = z.array(z.string().trim().max(80)).max(8)
const GoalsSchema = z.array(z.string().trim().max(200)).max(3)
const ConstraintsSchema = z.string().trim().max(600)
const TimeZoneValueSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, 'Invalid IANA time zone')

export const BusinessProfileEditableSchema = z.object({
  businessName: Text120Schema.default(''),
  businessType: Text120Schema.default(''),
  offer: OfferSchema.default(''),
  targetCustomer: CustomerSchema.default(''),
  channels: ChannelsSchema.default([]),
  currentGoals: GoalsSchema.default([]),
  constraints: ConstraintsSchema.default(''),
  timeZone: TimeZoneValueSchema.default(DEFAULT_TIME_ZONE),
})

export const BusinessProfileSchema = BusinessProfileEditableSchema.extend({
  version: z.literal(1).default(1),
  updatedAt: z.string().datetime().nullable().default(null),
})

// 不从带 default 的完整 Schema 派生 partial：Zod v4 会为缺失字段填默认值，
// 导致单字段更新把其余画像静默清空。
export const BusinessProfileUpdateSchema = z.object({
  businessName: Text120Schema.optional(),
  businessType: Text120Schema.optional(),
  offer: OfferSchema.optional(),
  targetCustomer: CustomerSchema.optional(),
  channels: ChannelsSchema.optional(),
  currentGoals: GoalsSchema.optional(),
  constraints: ConstraintsSchema.optional(),
  timeZone: TimeZoneValueSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one profile field is required')

export type BusinessProfileEditable = z.infer<typeof BusinessProfileEditableSchema>
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>
export type BusinessProfileField =
  | 'businessName'
  | 'businessType'
  | 'offer'
  | 'targetCustomer'
  | 'channels'
  | 'currentGoals'

const REQUIRED_FIELDS: BusinessProfileField[] = [
  'businessName',
  'businessType',
  'offer',
  'targetCustomer',
  'channels',
  'currentGoals',
]

function normalizeList(values: string[], max: number): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= max) break
  }
  return result
}

function normalizeEditable(input: BusinessProfileEditable): BusinessProfileEditable {
  return {
    ...input,
    channels: normalizeList(input.channels, 8),
    currentGoals: normalizeList(input.currentGoals, 3),
  }
}

export function createEmptyBusinessProfile(): BusinessProfile {
  const editable = normalizeEditable(BusinessProfileEditableSchema.parse({}))
  return BusinessProfileSchema.parse({ ...editable, version: 1, updatedAt: null })
}

export function getBusinessProfile(): BusinessProfile {
  const row = getDatabase()
    .query('SELECT value FROM kv_state WHERE key = ?')
    .get(BUSINESS_PROFILE_KEY) as { value: string } | null
  if (!row) return createEmptyBusinessProfile()
  try {
    const parsed = BusinessProfileSchema.parse(JSON.parse(row.value))
    return { ...parsed, ...normalizeEditable(parsed) }
  } catch {
    return createEmptyBusinessProfile()
  }
}

export function updateBusinessProfile(partial: Partial<BusinessProfileEditable>): BusinessProfile {
  const cleanPartial = BusinessProfileUpdateSchema.parse(partial)
  const current = getBusinessProfile()
  const editable = normalizeEditable(BusinessProfileEditableSchema.parse({
    businessName: cleanPartial.businessName ?? current.businessName,
    businessType: cleanPartial.businessType ?? current.businessType,
    offer: cleanPartial.offer ?? current.offer,
    targetCustomer: cleanPartial.targetCustomer ?? current.targetCustomer,
    channels: cleanPartial.channels ?? current.channels,
    currentGoals: cleanPartial.currentGoals ?? current.currentGoals,
    constraints: cleanPartial.constraints ?? current.constraints,
    timeZone: cleanPartial.timeZone ?? current.timeZone,
  }))
  const profile = BusinessProfileSchema.parse({
    ...editable,
    version: 1,
    updatedAt: new Date().toISOString(),
  })
  getDatabase().run(
    'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
    [BUSINESS_PROFILE_KEY, JSON.stringify(profile)],
  )
  return profile
}

export function getBusinessProfileCompletion(profile = getBusinessProfile()): {
  completeness: number
  missingFields: BusinessProfileField[]
} {
  const missingFields = REQUIRED_FIELDS.filter((field) => {
    const value = profile[field]
    return Array.isArray(value) ? value.length === 0 : !value.trim()
  })
  return {
    completeness: Math.round(((REQUIRED_FIELDS.length - missingFields.length) / REQUIRED_FIELDS.length) * 100),
    missingFields,
  }
}
