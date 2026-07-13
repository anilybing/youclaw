/**
 * AI 漫剧工作室 — 阶段状态机 / 数据结构 / 能力缺口 / 内置工作流定义。
 *
 * 主链（产品硬规则）：
 *   创意输入 → 结构化剧本 → 角色场景圣经 → 形象资产锁定
 *   → 分镜表 → 分镜静帧 → 分镜视频 → 配音字幕 → 合成成片
 *
 * 每个关键阶段后可挂人工门禁（approval），禁止「一句话直接出片」。
 */

import type { WorkflowBudgets, WorkflowInput, WorkflowStep } from './store'

export const ANIME_DRAMA_WORKFLOW_ID = 'anime-drama-studio-v1'

/** 工作室横向阶段条（UI）— 比工作流 steps 更粗，面向创作者 */
export type AnimeDramaStageId =
  | 'idea'
  | 'script'
  | 'assets'
  | 'storyboard'
  | 'clips'
  | 'audio'
  | 'final'

export type AnimeDramaStageStatus = 'pending' | 'active' | 'gated' | 'done' | 'failed'

export interface AnimeDramaStageDef {
  id: AnimeDramaStageId
  /** 对应内置工作流步骤 id（可一对多） */
  workflowStepIds: string[]
  /** 进入下一阶段前是否需要人工确认 */
  requiresGate: boolean
  order: number
}

export const ANIME_DRAMA_STAGES: readonly AnimeDramaStageDef[] = [
  { id: 'idea', order: 0, requiresGate: false, workflowStepIds: [] },
  { id: 'script', order: 1, requiresGate: true, workflowStepIds: ['script', 'bible'] },
  { id: 'assets', order: 2, requiresGate: true, workflowStepIds: ['char_sheet', 'gate_assets'] },
  { id: 'storyboard', order: 3, requiresGate: true, workflowStepIds: ['storyboard', 'stills', 'gate_board'] },
  { id: 'clips', order: 4, requiresGate: true, workflowStepIds: ['video_prompts', 'gate_video', 'video_notes'] },
  { id: 'audio', order: 5, requiresGate: false, workflowStepIds: ['video_notes'] },
  { id: 'final', order: 6, requiresGate: false, workflowStepIds: ['assemble'] },
] as const

/** 结构化剧本（LLM 输出约定，供下游消费） */
export interface AnimeDramaScriptBeat {
  beatId: string
  summary: string
  dialogue?: string
  emotion?: string
  characters?: string[]
  locationId?: string
}

export interface AnimeDramaCharacterBible {
  id: string
  name: string
  role: 'lead' | 'support' | 'extra'
  appearance: string
  personality?: string
  wardrobeVariants?: string[]
}

export interface AnimeDramaLocationBible {
  id: string
  name: string
  timeOfDay?: string
  mood?: string
  visualNotes: string
}

export interface AnimeDramaScriptDoc {
  title: string
  targetSeconds: number
  aspectRatio: '9:16' | '16:9' | '1:1'
  style: string
  hook: string
  climax: string
  cliffhanger?: string
  characters: AnimeDramaCharacterBible[]
  locations: AnimeDramaLocationBible[]
  beats: AnimeDramaScriptBeat[]
}

/** 分镜表单镜 */
export interface AnimeDramaShot {
  shotId: string
  index: number
  durationSec: number
  shotSize: 'extreme_wide' | 'wide' | 'full' | 'medium' | 'close' | 'extreme_close'
  cameraMove: 'static' | 'push' | 'pull' | 'pan' | 'tilt' | 'orbit'
  characterIds: string[]
  locationId?: string
  visualPrompt: string
  dialogue?: string
  sfx?: string
  transition?: string
  firstFrameIntent?: string
  lastFrameIntent?: string
}

/** 资产锁定包 — 后续分镜/视频必须引用 assetId，不可静默换脸 */
export interface AnimeDramaLockedAsset {
  assetId: string
  kind: 'character' | 'location' | 'prop'
  refCharacterId?: string
  refLocationId?: string
  imagePath?: string
  promptUsed: string
  lockedAt?: string
  version: number
}

export interface AnimeDramaProjectInputs {
  premise: string
  style: string
  episodeMins: string
  aspect: string
}

/**
 * 对照现有 youclaw workflow / media 能力的缺口清单。
 * status: covered = 已可跑通 MVP；partial = 有能力但不完整；gap = 需后续建设。
 */
export const ANIME_DRAMA_CAPABILITY_GAPS = [
  {
    id: 'structured-script',
    area: '剧本结构化',
    status: 'covered' as const,
    note: '用 llm 步骤输出 JSON 约定即可；无专用 schema 校验节点。',
  },
  {
    id: 'asset-lock',
    area: '角色/场景资产锁定',
    status: 'partial' as const,
    note: '可用 agent+mcp__media__generate_image 出设定图；缺独立资产库表与强制引用校验。',
  },
  {
    id: 'storyboard-stills',
    area: '分镜表 + 静帧',
    status: 'partial' as const,
    note: 'llm 出分镜表 + agent 出图；缺分镜拖拽排序持久化与单镜重生 API。',
  },
  {
    id: 'i2v-clips',
    area: '图生视频镜头',
    status: 'partial' as const,
    note: 'mcp__media__generate_video 可用，但贵且无首尾帧/角色参考一等公民参数；tool 节点未注册 media。',
  },
  {
    id: 'tts-subtitle',
    area: '配音 / 字幕 / 口型',
    status: 'gap' as const,
    note: '无内置 TTS/字幕烧录流水线；assemble 步骤仅输出制作清单。',
  },
  {
    id: 'ffmpeg-assemble',
    area: '时间线合成导出',
    status: 'gap' as const,
    note: '无 FFmpeg 合成节点；需人工用剪映/外部工具按清单拼接。',
  },
  {
    id: 'stage-studio-ui',
    area: '专用工作室 UI',
    status: 'covered' as const,
    note: '本模块提供阶段条 + 运行门禁页；底层复用 /api/workflows。',
  },
  {
    id: 'media-as-tool-node',
    area: 'workflow tool 直调 media',
    status: 'gap' as const,
    note: 'nodes.ts 白名单无 generate_image/video；出图/视频须走 kind=agent。',
  },
] as const

export function getAnimeDramaStageByWorkflowStep(stepId: string | undefined | null): AnimeDramaStageId | null {
  if (!stepId) return null
  for (const stage of ANIME_DRAMA_STAGES) {
    if (stage.workflowStepIds.includes(stepId)) return stage.id
  }
  return null
}

export function buildAnimeDramaWorkflowDefinition(): {
  id: string
  name: string
  description: string
  agentId: string
  inputs: WorkflowInput[]
  budgets: WorkflowBudgets
  steps: WorkflowStep[]
  source: 'builtin'
} {
  return {
    id: ANIME_DRAMA_WORKFLOW_ID,
    name: 'AI漫剧制作流水线',
    description:
      '竖屏动态漫剧标准主链：剧本→角色场景圣经→形象资产→分镜表/静帧→视频提示→音画合成清单（含人工门禁）',
    agentId: 'content-creator',
    inputs: [
      { key: 'premise', label: '故事梗概 / 大纲' },
      { key: 'style', label: '画风（日漫/国风/Q版/写实动态漫，可选）' },
      { key: 'episode_mins', label: '目标时长（分钟，可选，默认 1）' },
      { key: 'aspect', label: '画幅（9:16 / 16:9，可选，默认 9:16）' },
    ],
    budgets: {
      maxSteps: 14,
      maxTotalTokens: 48_000,
      maxCostUsd: 3,
      maxActiveDurationMs: 45 * 60_000,
      maxToolCalls: 24,
      unknownCostPolicy: 'allow',
    },
    steps: [
      {
        id: 'script',
        title: '结构化剧本',
        kind: 'llm',
        prompt: [
          '你是短剧编剧。根据梗概写出可被下游消费的**结构化漫剧剧本**（JSON，不要 Markdown 围栏）。',
          '画风偏好：{{style}}；目标时长：{{episode_mins}} 分钟（未填按 1）；画幅：{{aspect}}（未填 9:16）。',
          '梗概：{{premise}}',
          '',
          'JSON 字段必须包含：title, targetSeconds, aspectRatio, style, hook, climax, cliffhanger,',
          'characters[{id,name,role,appearance,personality,wardrobeVariants}],',
          'locations[{id,name,timeOfDay,mood,visualNotes}],',
          'beats[{beatId,summary,dialogue,emotion,characters,locationId}]。',
          '角色至少 1 个 lead；beats 按钩子→冲突升级→高潮→卡点编排；对白口语化、适合竖屏短剧。',
        ].join('\n'),
      },
      {
        id: 'bible',
        title: '角色与场景圣经',
        kind: 'llm',
        prompt: [
          '基于剧本 JSON，整理**生产用角色/场景圣经**（仍输出 JSON）：',
          '{{steps.script.output}}',
          '',
          '为每个 lead/support 角色补全：外貌关键词（发型/五官/服装/配色）、禁止漂移项、表情参考列表。',
          '为每个关键场景补全：空间布局、光色、可复用道具线索。',
          '输出 { characters:[...], locations:[...], consistencyRules:[string] }。',
        ].join('\n'),
      },
      {
        id: 'char_sheet',
        title: '形象设定出图',
        kind: 'agent',
        prompt: [
          '根据角色场景圣经，为主角（及最多 1 个关键配角）生成设定图。',
          '圣经：\n{{steps.bible.output}}',
          '画风：{{style}}；画幅参考：{{aspect}}。',
          '',
          '要求：',
          '1) 先写出每个角色的高质量生图提示词（正面半身或 3/4 视角、干净背景、角色一致性描述）。',
          '2) 调用 mcp__media__generate_image 至少生成主角一张设定图；若服务未配置，明确引导到「设置 → 语音与媒体」。',
          '3) 输出资产清单 Markdown：角色名 / 提示词 / 本地路径 / 建议锁定说明。',
          '4) 不要生成整集分镜视频；本步只做形象资产。',
        ].join('\n'),
      },
      {
        id: 'gate_assets',
        title: '锁定形象资产',
        kind: 'approval',
        prompt:
          '请确认主角/配角设定图与圣经一致且无串脸风险。确认后进入分镜；若需重做形象，请拒绝并说明修改意见。',
      },
      {
        id: 'storyboard',
        title: '分镜表',
        kind: 'llm',
        prompt: [
          '你是分镜导演。把剧本拆成镜头级分镜表（JSON 数组，不要围栏）。',
          '剧本：\n{{steps.script.output}}',
          '圣经：\n{{steps.bible.output}}',
          '形象资产清单：\n{{steps.char_sheet.output}}',
          '',
          '每镜字段：shotId,index,durationSec(3-8),shotSize,cameraMove,characterIds,locationId,',
          'visualPrompt,dialogue,sfx,transition,firstFrameIntent,lastFrameIntent。',
          '总时长贴近 targetSeconds；每镜 visualPrompt 必须引用已锁定角色外貌关键词，禁止换脸描述。',
        ].join('\n'),
      },
      {
        id: 'stills',
        title: '分镜静帧',
        kind: 'agent',
        prompt: [
          '根据分镜表，挑选**最具叙事性的 3-6 个关键镜头**生成静帧（不要一次出全部以免超预算）。',
          '分镜表：\n{{steps.storyboard.output}}',
          '形象资产：\n{{steps.char_sheet.output}}',
          '画风：{{style}}。',
          '',
          '对选中的每镜：用 mcp__media__generate_image 生成首帧静帧；提示词基于 visualPrompt + 锁定角色外貌。',
          '输出表格：shotId / 静帧路径 / 用于 I2V 的首帧说明。服务未配置时停止出图并给出配置指引。',
        ].join('\n'),
      },
      {
        id: 'gate_board',
        title: '确认分镜与静帧',
        kind: 'approval',
        prompt: '请确认分镜表叙事节奏与静帧构图可用。确认后生成镜头视频提示词；若需改镜，请拒绝并写明要改的 shotId。',
      },
      {
        id: 'video_prompts',
        title: '镜头视频提示词',
        kind: 'llm',
        prompt: [
          '为分镜表中每一镜写出**图生视频（I2V）提示词包**（JSON 数组）：',
          '分镜：\n{{steps.storyboard.output}}',
          '静帧清单：\n{{steps.stills.output}}',
          '',
          '每项含：shotId, durationSec, i2vPrompt, cameraMove, firstFrameRef, lastFrameHint, negativePrompt, riskNotes。',
          '强调短镜、运镜克制、角色一致性；标注哪些镜建议付费生成、哪些可跳过。',
        ].join('\n'),
      },
      {
        id: 'gate_video',
        title: '确认视频生成',
        kind: 'approval',
        prompt:
          '视频生成成本较高。请确认 I2V 提示词包无误后再继续；本流水线默认只产出提示词与制作清单，不会在未确认时批量烧钱出片。',
      },
      {
        id: 'video_notes',
        title: '视频与音画制作清单',
        kind: 'llm',
        prompt: [
          '汇总成**可执行的漫剧制作清单**（Markdown）：',
          '1) 镜头顺序表（shotId、秒数、静帧路径、I2V 提示词摘要）',
          '2) 建议生成优先级（P0/P1）与预估费用提醒',
          '3) 配音：按角色拆分 TTS 音色建议 + 对白时间码草稿',
          '4) BGM/音效与情绪曲线',
          '5) 字幕样式与竖屏安全区注意点',
          '6) 合成步骤（剪映/FFmpeg）与验收清单（串脸、穿帮、音画同步）',
          '',
          '剧本标题取自：\n{{steps.script.output}}',
          'I2V 包：\n{{steps.video_prompts.output}}',
          '静帧：\n{{steps.stills.output}}',
        ].join('\n'),
      },
      {
        id: 'assemble',
        title: '成片交付摘要',
        kind: 'llm',
        prompt: [
          '把制作清单收成一页「成片交付摘要」：',
          '- 一句话卖点 / 钩子',
          '- 最终镜头数与目标时长',
          '- 已锁定资产路径',
          '- 待人工完成项（付费 I2V、TTS、时间线合成）',
          '- 可直接复制的发布文案（竖屏短剧风，含 5 个话题标签）',
          '',
          '制作清单：\n{{steps.video_notes.output}}',
        ].join('\n'),
      },
    ],
    source: 'builtin',
  }
}
