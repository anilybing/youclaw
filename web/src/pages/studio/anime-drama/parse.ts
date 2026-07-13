/** 漫剧工作室前端：从工作流步骤产出里尽量解析结构化数据，供精致面板渲染。 */

export type StudioStageId = 'idea' | 'script' | 'assets' | 'storyboard' | 'clips' | 'audio' | 'final'

export const STUDIO_STAGE_ORDER: StudioStageId[] = [
  'idea',
  'script',
  'assets',
  'storyboard',
  'clips',
  'audio',
  'final',
]

export const STEP_TO_STAGE: Record<string, StudioStageId> = {
  script: 'script',
  bible: 'script',
  char_sheet: 'assets',
  gate_assets: 'assets',
  storyboard: 'storyboard',
  stills: 'storyboard',
  gate_board: 'storyboard',
  video_prompts: 'clips',
  gate_video: 'clips',
  video_notes: 'audio',
  assemble: 'final',
}

export const STYLE_PRESETS = [
  { id: 'anime', zh: '日漫', en: 'Anime' },
  { id: 'guofeng', zh: '国风', en: 'Chinese fantasy' },
  { id: 'chibi', zh: 'Q 版', en: 'Chibi' },
  { id: 'motion', zh: '写实动态漫', en: 'Realistic motion comic' },
] as const

export interface ParsedCharacter {
  id: string
  name: string
  role: string
  appearance: string
  personality?: string
}

export interface ParsedLocation {
  id: string
  name: string
  visualNotes: string
  mood?: string
}

export interface ParsedScript {
  title?: string
  hook?: string
  climax?: string
  cliffhanger?: string
  targetSeconds?: number
  style?: string
  characters: ParsedCharacter[]
  locations: ParsedLocation[]
  beats: Array<{ beatId?: string; summary: string; dialogue?: string; emotion?: string }>
}

export interface ParsedShot {
  shotId: string
  index: number
  durationSec: number
  shotSize?: string
  cameraMove?: string
  visualPrompt: string
  dialogue?: string
  characterIds?: string[]
}

export interface ParsedVideoPrompt {
  shotId: string
  durationSec?: number
  i2vPrompt: string
  cameraMove?: string
  riskNotes?: string
}

/** 从模型输出中抠出第一个 JSON 对象或数组（容忍前后说明文字 / 代码围栏）。 */
export function extractJson<T = unknown>(raw: string | undefined | null): T | null {
  if (!raw) return null
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  const tryParse = (text: string): T | null => {
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }
  const direct = tryParse(candidate)
  if (direct) return direct
  const objStart = candidate.indexOf('{')
  const arrStart = candidate.indexOf('[')
  const start =
    objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart)
  if (start < 0) return null
  const isArr = candidate[start] === '['
  const end = isArr ? candidate.lastIndexOf(']') : candidate.lastIndexOf('}')
  if (end <= start) return null
  return tryParse(candidate.slice(start, end + 1))
}

export function parseScriptDoc(raw: string | undefined | null): ParsedScript | null {
  const data = extractJson<Record<string, unknown>>(raw)
  if (!data || Array.isArray(data)) return null
  const characters = Array.isArray(data.characters)
    ? data.characters.map((item, index) => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          id: String(row.id ?? `c${index + 1}`),
          name: String(row.name ?? `char-${index + 1}`),
          role: String(row.role ?? 'support'),
          appearance: String(row.appearance ?? ''),
          personality: row.personality ? String(row.personality) : undefined,
        }
      })
    : []
  const locations = Array.isArray(data.locations)
    ? data.locations.map((item, index) => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          id: String(row.id ?? `l${index + 1}`),
          name: String(row.name ?? `loc-${index + 1}`),
          visualNotes: String(row.visualNotes ?? row.mood ?? ''),
          mood: row.mood ? String(row.mood) : undefined,
        }
      })
    : []
  const beats = Array.isArray(data.beats)
    ? data.beats.map((item, index) => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          beatId: row.beatId ? String(row.beatId) : `b${index + 1}`,
          summary: String(row.summary ?? ''),
          dialogue: row.dialogue ? String(row.dialogue) : undefined,
          emotion: row.emotion ? String(row.emotion) : undefined,
        }
      })
    : []
  return {
    title: data.title ? String(data.title) : undefined,
    hook: data.hook ? String(data.hook) : undefined,
    climax: data.climax ? String(data.climax) : undefined,
    cliffhanger: data.cliffhanger ? String(data.cliffhanger) : undefined,
    targetSeconds: typeof data.targetSeconds === 'number' ? data.targetSeconds : undefined,
    style: data.style ? String(data.style) : undefined,
    characters,
    locations,
    beats,
  }
}

export function parseShotList(raw: string | undefined | null): ParsedShot[] {
  const data = extractJson<unknown>(raw)
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { shots?: unknown }).shots)
      ? (data as { shots: unknown[] }).shots
      : null
  if (!list) return []
  return list.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>
    return {
      shotId: String(row.shotId ?? `S${index + 1}`),
      index: typeof row.index === 'number' ? row.index : index + 1,
      durationSec: typeof row.durationSec === 'number' ? row.durationSec : 4,
      shotSize: row.shotSize ? String(row.shotSize) : undefined,
      cameraMove: row.cameraMove ? String(row.cameraMove) : undefined,
      visualPrompt: String(row.visualPrompt ?? row.i2vPrompt ?? ''),
      dialogue: row.dialogue ? String(row.dialogue) : undefined,
      characterIds: Array.isArray(row.characterIds) ? row.characterIds.map(String) : undefined,
    }
  })
}

export function parseVideoPrompts(raw: string | undefined | null): ParsedVideoPrompt[] {
  const data = extractJson<unknown>(raw)
  if (!Array.isArray(data)) return []
  return data.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>
    return {
      shotId: String(row.shotId ?? `S${index + 1}`),
      durationSec: typeof row.durationSec === 'number' ? row.durationSec : undefined,
      i2vPrompt: String(row.i2vPrompt ?? row.visualPrompt ?? ''),
      cameraMove: row.cameraMove ? String(row.cameraMove) : undefined,
      riskNotes: row.riskNotes ? String(row.riskNotes) : undefined,
    }
  })
}

/** 从 agent markdown 产出里提取疑似本地媒体路径 */
export function extractMediaPaths(raw: string | undefined | null): string[] {
  if (!raw) return []
  const paths = new Set<string>()
  const patterns = [
    /(?:^|[\s`"'(])((?:[A-Za-z]:)?[\\/][^\s`"')]+?\.(?:png|jpe?g|webp|gif|mp4|webm))/gi,
    /(?:媒体产出|media[\\/]+output)[^\n]*?([^\s`"'|]+\.(?:png|jpe?g|webp|gif|mp4|webm))/gi,
  ]
  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const value = (match[1] || match[0]).trim()
      if (value.length > 4) paths.add(value.replace(/^['"`(]+|[)'"`]+$/g, ''))
    }
  }
  return [...paths].slice(0, 24)
}

export function outputByStepId(
  steps: Array<{ id?: string }>,
  outputs: string[],
  stepId: string,
): string | undefined {
  const index = steps.findIndex((step) => step.id === stepId)
  if (index < 0) return undefined
  return outputs[index]
}
