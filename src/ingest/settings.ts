// [XJC-PATCH] T-G6 本地文档摄取一期：摄取设置持久化
//
// 勘查结论：src/settings 的 SettingsSchema 是封闭 zod 对象（未知键会被 parse 剥离），
// updateSettings 逐字段显式合并——扩展它必须同时改 schema.ts / manager.ts / routes/settings.ts
// 的字段白名单，超出本任务允许改动范围。故沿用同一存储基座（kv_state 表），
// 参照 skill_settings / preferred_port 的先例，用独立键 `ingest_settings` 存放摄取配置。
//
// 隐私红线：ingestEnabled 默认 false（不开启就绝不扫描任何目录）；
// ingestFolders 是用户显式添加的白名单，可随时移除（移除后由调用方清理对应游标条目）。

import { z } from 'zod/v4'
import { getDatabase } from '../db/index.ts'
import { resolvePathInput } from '../config/index.ts'

const INGEST_SETTINGS_KEY = 'ingest_settings'

export const IngestSettingsSchema = z.object({
  /** 隐私优先：默认关闭，用户在设置里显式开启后才会扫描 */
  ingestEnabled: z.boolean().default(false),
  /** 监听目录白名单（绝对路径；只扫第一层，不递归） */
  ingestFolders: z.array(z.string()).default([]),
})

export type IngestSettings = z.infer<typeof IngestSettingsSchema>

/** 归一化目录列表：去空白、展开 ~、转绝对路径、去重（Windows 大小写不敏感） */
export function normalizeIngestFolders(folders: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of folders) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const resolved = resolvePathInput(trimmed)
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}

function normalize(settings: IngestSettings): IngestSettings {
  return {
    ...settings,
    ingestFolders: normalizeIngestFolders(settings.ingestFolders),
  }
}

/** 读摄取设置；缺失/损坏一律回退默认值（enabled=false，目录为空） */
export function getIngestSettings(): IngestSettings {
  const db = getDatabase()
  const row = db.query('SELECT value FROM kv_state WHERE key = ?').get(INGEST_SETTINGS_KEY) as { value: string } | null
  if (!row) return IngestSettingsSchema.parse({})
  try {
    return normalize(IngestSettingsSchema.parse(JSON.parse(row.value)))
  } catch {
    return IngestSettingsSchema.parse({})
  }
}

/** 部分更新摄取设置并整体写回（与 settings/manager.ts 的 updateSettings 同款语义） */
export function updateIngestSettings(partial: Partial<IngestSettings>): IngestSettings {
  const db = getDatabase()
  const current = getIngestSettings()
  const merged: IngestSettings = {
    ingestEnabled: partial.ingestEnabled ?? current.ingestEnabled,
    ingestFolders: partial.ingestFolders ?? current.ingestFolders,
  }
  const validated = normalize(IngestSettingsSchema.parse(merged))
  db.run(
    'INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)',
    [INGEST_SETTINGS_KEY, JSON.stringify(validated)],
  )
  return validated
}
