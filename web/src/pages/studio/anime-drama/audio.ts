/**
 * 漫剧「音画」阶段派生：从已解析剧本/分镜产出配音音色、对白时间码、情绪/BGM 曲线等
 * 可执行明细（纯前端派生，不依赖 LLM 二次产出，便于确定性渲染与单测）。
 */
import type { ParsedScript, ParsedShot } from './parse'

export type VoiceToneId =
  | 'lead'
  | 'warm'
  | 'cold'
  | 'energetic'
  | 'serious'
  | 'villain'
  | 'neutral'

export interface VoiceCastRow {
  id: string
  name: string
  role: string
  toneId: VoiceToneId
  /** 该角色出现在多少个含台词的镜头（无分镜数据时为 0） */
  lineCount: number
}

export interface DialogueCue {
  shotId: string
  startSec: number
  endSec: number
  /** mm:ss */
  start: string
  end: string
  durationSec: number
  dialogue?: string
  speakerIds?: string[]
}

export interface EmotionPoint {
  label: string
  emotion: string
  /** 时间码（来自分镜时有值，来自 beats 时为空串） */
  at: string
}

/** 情绪 → 建议 BGM 基调；供「情绪/配乐曲线」派生 */
export type BgmMoodId = 'tense' | 'warm' | 'sad' | 'epic' | 'playful' | 'calm' | 'neutral'

const TONE_RULES: Array<{ id: VoiceToneId; keys: RegExp }> = [
  { id: 'cold', keys: /高冷|冷漠|清冷|孤傲|傲|腹黑|阴郁|cold|aloof|arrogant/i },
  { id: 'villain', keys: /反派|阴险|狠毒|恶毒|野心|残忍|boss|villain|sinister|ruthless/i },
  { id: 'energetic', keys: /活泼|元气|开朗|机灵|古灵精怪|逗|energetic|cheerful|lively/i },
  { id: 'warm', keys: /温柔|善良|温暖|治愈|亲和|体贴|暖|warm|gentle|kind/i },
  { id: 'serious', keys: /沉稳|严肃|成熟|冷静|理智|沉默|serious|mature|calm|stoic/i },
]

const BGM_RULES: Array<{ id: BgmMoodId; keys: RegExp }> = [
  { id: 'tense', keys: /紧张|压迫|危机|对峙|冲突|恐惧|愤怒|tense|fear|anger|threat/i },
  { id: 'sad', keys: /悲|伤|孤独|绝望|失落|哭|sad|lonely|despair|grief/i },
  { id: 'epic', keys: /高潮|震撼|逆转|决战|燃|史诗|epic|climax|heroic|turning/i },
  { id: 'playful', keys: /欢快|搞笑|喜剧|轻松|俏皮|甜|playful|comedy|sweet|fun/i },
  { id: 'warm', keys: /温暖|治愈|感动|温情|warm|heal|touching/i },
  { id: 'calm', keys: /平静|日常|舒缓|calm|daily|slow/i },
]

/** 依据角色性格/定位推断建议音色（无匹配时主角=lead，其余=neutral） */
export function suggestVoiceTone(role: string, personality?: string): VoiceToneId {
  const text = personality ?? ''
  for (const rule of TONE_RULES) {
    if (rule.keys.test(text)) return rule.id
  }
  if (/lead|主角|主演|女主|男主/i.test(role)) return 'lead'
  return 'neutral'
}

/** 依据情绪关键词推断建议 BGM 基调 */
export function suggestBgmMood(emotion: string | undefined): BgmMoodId {
  if (!emotion) return 'neutral'
  for (const rule of BGM_RULES) {
    if (rule.keys.test(emotion)) return rule.id
  }
  return 'neutral'
}

export function buildVoiceCast(
  characters: ParsedScript['characters'],
  shots: ParsedShot[],
): VoiceCastRow[] {
  return characters.map((c) => {
    const idset = new Set([c.id, c.name].filter(Boolean))
    const lineCount = shots.filter(
      (s) => !!s.dialogue && (s.characterIds?.some((x) => idset.has(x)) ?? false),
    ).length
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      toneId: suggestVoiceTone(c.role, c.personality),
      lineCount,
    }
  })
}

/** 分镜秒数缺省回退到 4s（与 parseShotList 保持一致） */
function safeDuration(durationSec: number): number {
  return durationSec > 0 ? durationSec : 4
}

export function formatTimecode(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** 按分镜顺序累加秒数，产出对白时间码草稿（含无对白镜，便于对齐总时长） */
export function buildDialogueTimeline(shots: ParsedShot[]): DialogueCue[] {
  const cues: DialogueCue[] = []
  let cursor = 0
  for (const shot of shots) {
    const dur = safeDuration(shot.durationSec)
    const startSec = cursor
    const endSec = cursor + dur
    cues.push({
      shotId: shot.shotId,
      startSec,
      endSec,
      start: formatTimecode(startSec),
      end: formatTimecode(endSec),
      durationSec: dur,
      dialogue: shot.dialogue,
      speakerIds: shot.characterIds,
    })
    cursor = endSec
  }
  return cues
}

export function totalTimelineSeconds(shots: ParsedShot[]): number {
  return shots.reduce((sum, s) => sum + safeDuration(s.durationSec), 0)
}

/** 情绪/配乐曲线：优先取分镜 emotionCurve/emotion（带时间码），否则回退到剧本 beats */
export function buildEmotionCurve(
  shots: ParsedShot[],
  beats: ParsedScript['beats'],
): EmotionPoint[] {
  if (shots.length) {
    const points: EmotionPoint[] = []
    let cursor = 0
    for (const shot of shots) {
      const emo = shot.emotionCurve || shot.emotion
      if (emo) points.push({ label: shot.shotId, emotion: emo, at: formatTimecode(cursor) })
      cursor += safeDuration(shot.durationSec)
    }
    if (points.length) return points
  }
  return beats
    .filter((b) => b.emotion)
    .map((b, index) => ({ label: `BEAT ${index + 1}`, emotion: b.emotion as string, at: '' }))
}
