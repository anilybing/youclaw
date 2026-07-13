/** 企划阶段本地导读：在启动产线前给出可读概要与风格推荐（不依赖 LLM）。 */

export interface LocalScriptBrief {
  title: string
  theme: string
  scenes: string[]
  characters: string[]
  corePlot: string
  acts: string[]
  confidence: 'low' | 'medium' | 'high'
}

export interface StyleRecommendation {
  id: string
  nameZh: string
  nameEn: string
  reasonZh: string
  reasonEn: string
  rank: number
}

const THEME_RULES: Array<{ id: string; zh: string; en: string; keys: RegExp }> = [
  { id: 'palace', zh: '西方宫廷权谋', en: 'Western palace intrigue', keys: /宫廷|舞会|退婚|王子|公爵|巴洛克|皇宫|贵族|权谋|palace|duke|prince|ballroom|baroque/i },
  { id: 'apocalypse', zh: '末世求生', en: 'Apocalypse survival', keys: /末世|丧尸|囤货|废土|apocalypse|zombie|wasteland/i },
  { id: 'campus', zh: '校园青春', en: 'Campus youth', keys: /校园|同学|教室|校服|高中|campus|school|classroom/i },
  { id: 'xuanhuan', zh: '古风玄幻', en: 'Xianxia fantasy', keys: /修仙|玄幻|仙门|妖兽|灵力|宗门|国风|水墨|xianxia|cultivat/i },
  { id: 'cyber', zh: '赛博都市', en: 'Cyberpunk city', keys: /赛博|霓虹|义体|黑客|赛博朋克|cyber|neon|android/i },
  { id: 'urban', zh: '现代都市情感', en: 'Modern urban romance', keys: /都市|公司|咖啡|地铁|总裁|都市情感|office|metro|ceo/i },
  { id: 'wuxia', zh: '武侠江湖', en: 'Wuxia', keys: /江湖|侠客|剑|门派|武林|wuxia|sword/i },
]

function firstNonEmptyLines(text: string, limit = 40): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit)
}

function extractTitle(text: string, episodeTitle?: string): string {
  const explicit = episodeTitle?.trim()
  if (explicit) return explicit
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (heading) return heading
  const book = text.match(/《([^》]{2,40})》/)?.[1]?.trim()
  if (book) return book
  const labeled = text.match(/(?:标题|剧名|title)\s*[:：]\s*(.+)/i)?.[1]?.trim()
  if (labeled) return labeled.replace(/^#+\s*/, '').slice(0, 40)
  const first = firstNonEmptyLines(text, 1)[0]
  return first ? first.replace(/^#+\s*/, '').slice(0, 40) : '未命名本集'
}

function extractTheme(text: string): string {
  for (const rule of THEME_RULES) {
    if (rule.keys.test(text)) return rule.zh
  }
  return '剧情向短剧'
}

function extractLabeledList(text: string, labels: RegExp): string[] {
  const block = text.match(new RegExp(`(?:${labels.source})\\s*[:：]?\\s*([\\s\\S]{0,800})`, 'i'))
  if (!block?.[1]) return []
  const chunk = block[1].split(/\n{2,}/)[0] ?? block[1]
  return chunk
    .split(/\n|、|，|,|;|；|\|/)
    .map((item) => item.replace(/^[-*•\d.、\s]+/, '').trim())
    .filter((item) => item.length >= 2 && item.length <= 40)
    .slice(0, 8)
}

function extractCharacters(text: string): string[] {
  const labeled = extractLabeledList(text, /角色|人物|出演|characters?/)
  if (labeled.length) return labeled
  const speakers = [...text.matchAll(/^[「"']?([\u4e00-\u9fffA-Za-z]{1,12})[」"']?\s*[:：]/gm)]
    .map((m) => m[1])
    .filter(Boolean)
  return [...new Set(speakers)].slice(0, 8)
}

function extractScenes(text: string): string[] {
  const labeled = extractLabeledList(text, /场景|地点|locations?|settings?/)
  if (labeled.length) return labeled
  const headings = [...text.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim())
  if (headings.length) return headings.slice(0, 6)
  const sceneMarks = [...text.matchAll(/(?:第[一二三四五六七八九十\d]+场|场景\s*\d+)[：:\s]*([^\n]{2,40})/g)]
    .map((m) => m[1].trim())
  return [...new Set(sceneMarks)].slice(0, 6)
}

function extractActs(text: string, scenes: string[]): string[] {
  const marks = [...text.matchAll(/(?:第[一二三四五六七八九十\d]+场|分场\s*\d+|Beat\s*\d+)[：:\s]*([^\n]{2,60})/gi)]
    .map((m) => m[0].replace(/\s+/g, ' ').trim())
  if (marks.length) return marks.slice(0, 6)
  if (scenes.length >= 2) return scenes.map((scene, index) => `${index + 1}. ${scene}`)
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= 12)
    .slice(0, 3)
  return paras.map((p, index) => `${index + 1}. ${p.slice(0, 48)}${p.length > 48 ? '…' : ''}`)
}

function extractCorePlot(text: string): string {
  const labeled = text.match(/(?:核心剧情|剧情概要|梗概|大纲|premise|synopsis)\s*[:：]\s*([^\n]{8,160})/i)?.[1]
  if (labeled) return labeled.trim()
  const cleaned = text.replace(/^#.+$/gm, '').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? '…' : '')
}

export function analyzeLocalBrief(text: string, episodeTitle?: string): LocalScriptBrief | null {
  const trimmed = text.trim()
  if (trimmed.length < 24) return null
  const scenes = extractScenes(trimmed)
  const characters = extractCharacters(trimmed)
  const acts = extractActs(trimmed, scenes)
  const signals = [scenes.length > 0, characters.length > 0, /第.+场|角色|场景|对白|旁白/.test(trimmed)].filter(Boolean).length
  return {
    title: extractTitle(trimmed, episodeTitle),
    theme: extractTheme(trimmed),
    scenes: scenes.length ? scenes : ['待产线解析后补全'],
    characters: characters.length ? characters : ['待产线解析后补全'],
    corePlot: extractCorePlot(trimmed),
    acts: acts.length ? acts : ['导入后将由结构化剧本步骤拆分场次'],
    confidence: signals >= 2 ? 'high' : signals === 1 ? 'medium' : 'low',
  }
}

export function recommendStyles(brief: LocalScriptBrief): StyleRecommendation[] {
  const theme = brief.theme
  const pool: StyleRecommendation[] = [
    {
      id: 'western-real',
      nameZh: '欧美写实',
      nameEn: 'Western realism',
      reasonZh: '适合宫廷舞会、服饰与建筑细节，强化戏剧张力。',
      reasonEn: 'Best for palace balls, ornate costumes, and dramatic tension.',
      rank: 1,
    },
    {
      id: 'shoujo',
      nameZh: '日系漫画',
      nameEn: 'Japanese manga',
      reasonZh: '细腻线条与情绪特写，适合权谋与情感对峙戏。',
      reasonEn: 'Fine linework and emotion close-ups for intrigue and confrontation.',
      rank: 2,
    },
    {
      id: 'cinematic',
      nameZh: '电影感写实',
      nameEn: 'Cinematic realism',
      reasonZh: '高对比光影，利于突出羞辱/反转等高戏剧节点。',
      reasonEn: 'High-contrast lighting for humiliation and twist beats.',
      rank: 3,
    },
    {
      id: 'guofeng',
      nameZh: '国风插画',
      nameEn: 'Chinese fantasy art',
      reasonZh: '适配仙侠/古风题材的服饰与意境。',
      reasonEn: 'Fits xianxia/guofeng wardrobe and atmosphere.',
      rank: 1,
    },
    {
      id: 'chibi',
      nameZh: 'Q 版动态漫',
      nameEn: 'Chibi motion comic',
      reasonZh: '节奏轻快、适合囤货/喜剧反差题材。',
      reasonEn: 'Light pacing for comedy and contrast-driven plots.',
      rank: 1,
    },
    {
      id: 'cyber',
      nameZh: '赛博朋克',
      nameEn: 'Cyberpunk',
      reasonZh: '霓虹与义体美学，贴合都市科技冲突。',
      reasonEn: 'Neon and chrome aesthetics for tech-city conflict.',
      rank: 1,
    },
    {
      id: 'motion',
      nameZh: '写实动态漫',
      nameEn: 'Realistic motion comic',
      reasonZh: '通用稳妥选项，兼顾表情与动作可读性。',
      reasonEn: 'Safe default with readable acting and motion.',
      rank: 2,
    },
  ]

  let picked: StyleRecommendation[]
  if (/宫廷|palace|权谋/i.test(theme)) {
    picked = [pool[0], pool[1], pool[2]]
  } else if (/玄幻|古风|武侠|xianxia|wuxia/i.test(theme)) {
    picked = [pool[3], pool[1], pool[6]]
  } else if (/末世|喜剧|囤货|apocalypse/i.test(theme)) {
    picked = [pool[4], pool[1], pool[6]]
  } else if (/赛博|cyber/i.test(theme)) {
    picked = [pool[5], pool[2], pool[6]]
  } else {
    picked = [pool[1], pool[6], pool[2]]
  }

  return picked.map((item, index) => ({ ...item, rank: index + 1 }))
}

export const RESOLUTION_PRESETS = [
  { id: '720p', zh: '720P 标清', en: '720P SD' },
  { id: '1080p', zh: '1080P 高清', en: '1080P HD' },
] as const

export function estimateStepSeconds(stepId: string | undefined): string {
  switch (stepId) {
    case 'script':
    case 'bible':
      return '20–45s'
    case 'seed_assets':
    case 'assert_locked':
      return '1–5s'
    case 'char_sheet':
    case 'stills':
      return '30–90s'
    case 'storyboard':
    case 'video_prompts':
    case 'animatic':
      return '20–60s'
    case 'video_notes':
    case 'assemble':
      return '15–40s'
    default:
      return '30–60s'
  }
}
