/**
 * AI 漫剧工作室 — 阶段状态机 / 数据结构 / 能力缺口 / 内置工作流定义。
 *
 * 工业化主链（2026-07-14 调研对齐 + token 优化）：
 *   Script(+bible) → Asset Lock → Keyframe → Animatic → Draft I2V → HQ → 后期
 *
 * Token 策略：合并圣经进剧本；削减跨步重复上下文；压缩字段与输出上限；收紧预算。
 * P0：60–90 秒、≤2 角色、≤2 场景、8–12 镜；关键阶段人工门禁。
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
  workflowStepIds: string[]
  requiresGate: boolean
  order: number
}

export const ANIME_DRAMA_STAGES: readonly AnimeDramaStageDef[] = [
  { id: 'idea', order: 0, requiresGate: false, workflowStepIds: [] },
  { id: 'script', order: 1, requiresGate: false, workflowStepIds: ['script'] },
  {
    id: 'assets',
    order: 2,
    requiresGate: true,
    workflowStepIds: ['seed_assets', 'char_sheet', 'gate_assets', 'assert_locked'],
  },
  {
    id: 'storyboard',
    order: 3,
    requiresGate: true,
    workflowStepIds: ['storyboard', 'stills', 'animatic', 'gate_board'],
  },
  { id: 'clips', order: 4, requiresGate: true, workflowStepIds: ['video_prompts', 'gate_video'] },
  { id: 'audio', order: 5, requiresGate: false, workflowStepIds: ['video_notes'] },
  { id: 'final', order: 6, requiresGate: false, workflowStepIds: ['assemble'] },
] as const

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
  continuityTo?: string | null
  costTier?: 'draft' | 'hq'
}

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

export const ANIME_DRAMA_CAPABILITY_GAPS = [
  {
    id: 'structured-script',
    area: '剧本结构化',
    status: 'covered' as const,
    note: '单次 llm 合并剧本+生产圣经；P0 约束写入提示词；控制字段长度以降 token。',
  },
  {
    id: 'asset-lock',
    area: '角色/场景资产锁定',
    status: 'covered' as const,
    note: 'studio_assets + seed + UI 锁定 + studio_assert_locked 硬门禁（未锁定/无参考图则阻断分镜）。',
  },
  {
    id: 'storyboard-stills',
    area: '分镜表 + 关键帧',
    status: 'partial' as const,
    note: 'llm 分镜 + agent 静帧 + animatic 清单；缺单镜重生 API 与拖拽排序持久化。',
  },
  {
    id: 'animatic-gate',
    area: '动态分镜 / Animatic 闸门',
    status: 'partial' as const,
    note: '已有 animatic 步骤输出镜间连续与节奏表；尚无低成本真视频预览拼接自动化。',
  },
  {
    id: 'i2v-clips',
    area: '图生视频镜头（Draft/HQ）',
    status: 'partial' as const,
    note: '提示词包已分 draft/hq；media 无首尾帧一等公民参数；tool 节点未直调 generate_video。',
  },
  {
    id: 'tts-subtitle',
    area: '配音 / 字幕 / 口型',
    status: 'gap' as const,
    note: '无内置 TTS/字幕烧录流水线；assemble 步骤输出制作清单。',
  },
  {
    id: 'ffmpeg-assemble',
    area: '时间线合成导出',
    status: 'covered' as const,
    note: '剪映草稿 + FFmpeg concat 一键合成脚本（studio 草稿包）。',
  },
  {
    id: 'stage-studio-ui',
    area: '专用工作室 UI',
    status: 'covered' as const,
    note: '阶段条 + 运行门禁页；底层复用 /api/workflows。',
  },
  {
    id: 'media-as-tool-node',
    area: 'workflow tool 直调 media',
    status: 'gap' as const,
    note: 'nodes.ts 白名单无 generate_image/video；出图/视频须走 kind=agent。',
  },
  {
    id: 'token-budget',
    area: 'Token 成本控制',
    status: 'covered' as const,
    note: '合并圣经步；削减重复上下文；输出字数上限；预算 maxTotalTokens=36k / maxCostUsd=2.5。',
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
      '工业化主链（token 优化）：单次剧本圣经→资产锁定→分镜关键帧→Animatic→Draft/HQ→清单',
    agentId: 'content-creator',
    inputs: [
      { key: 'premise', label: '故事梗概 / 大纲' },
      { key: 'style', label: '画风（日漫/国风/Q版/写实动态漫，可选）' },
      { key: 'episode_mins', label: '目标时长（分钟，可选，默认 1；P0 建议 ≤1.5）' },
      { key: 'aspect', label: '画幅（9:16 / 16:9，可选，默认 9:16）' },
      { key: 'resolution', label: '分辨率（720p / 1080p，可选，默认 720p）' },
    ],
    budgets: {
      maxSteps: 16,
      maxTotalTokens: 36_000,
      maxCostUsd: 2.5,
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
          '输出可下游消费的漫剧 JSON（不要 Markdown 围栏）。',
          '画风:{{style}}；时长min:{{episode_mins}}(默认1)；画幅:{{aspect}}(默认9:16)；分辨率:{{resolution}}(默认720p)。',
          '梗概:{{premise}}',
          '',
          'P0：targetSeconds=60-90；characters≤2(1lead)；locations≤2；对白≤10字/句；动作外化。',
          '节奏：3s钩子→10s立角色→冲突→结尾卡点。',
          '字段：title,theme,targetSeconds,aspectRatio,style,styleLock,hook,climax,cliffhanger,',
          'characters[{id,name,role,appearance≤80字,personality≤40字}],',
          'locations[{id,name,timeOfDay,mood,visualNotes≤80字无人物}],',
          'props[{id,name,description≤40字}]≤5,',
          'beats[{beatId,summary,dialogue,emotion,characters,locationId}],',
          'consistencyRules[string]（含：禁换脸/禁未锁场景/尾帧锚定下镜首帧）。',
          'appearance/visualNotes 需可直接喂生图；禁止长散文。',
        ].join('\n'),
      },
      {
        id: 'seed_assets',
        title: '播种资产库',
        kind: 'tool',
        tool: 'studio_seed_assets',
        prompt: '',
        args: {
          bibleJson: '{{steps.script.output}}',
        },
      },
      {
        id: 'char_sheet',
        title: '形象设定出图',
        kind: 'agent',
        prompt: [
          '只做出图资产，不出视频。画风:{{style}}；画幅:{{aspect}}。',
          '剧本角色/场景：\n{{steps.script.output}}',
          '已播种：\n{{steps.seed_assets.output}}',
          '任务：为主角(+最多1配角)生成干净白底设定图；场景母版无人物。',
          '调用 mcp__media__generate_image；未配置则提示「设置→语音与媒体」。',
          '输出极简清单：name|refKey|path。提醒用户在资产库锁定并挂图。',
        ].join('\n'),
      },
      {
        id: 'gate_assets',
        title: '锁定形象资产',
        kind: 'approval',
        prompt:
          '请确认设定图无串脸、场景无人物，并在资产库锁定且挂上参考图。确认后将程序校验；未锁定会阻断分镜。',
      },
      {
        id: 'assert_locked',
        title: '校验资产锁定',
        kind: 'tool',
        tool: 'studio_assert_locked',
        prompt: '',
        args: {},
      },
      {
        id: 'storyboard',
        title: '分镜表',
        kind: 'llm',
        prompt: [
          '把剧本拆成镜头 JSON 数组（不要围栏）。',
          '剧本：\n{{steps.script.output}}',
          '锁定资产：\n{{steps.assert_locked.output}}',
          '约束：8-12镜；durationSec3-8；总时长贴 targetSeconds；以切镜为主；continuityTo；默认costTier=draft，仅1-3高潮镜hq。',
          '字段：shotId,index,durationSec,shotSize,cameraMove,characterIds,locationId,visualPrompt,dialogue,continuityTo,costTier,firstFrameIntent,lastFrameIntent。',
          'visualPrompt 引用锁定外貌关键词；禁换脸；禁抽象心理。',
        ].join('\n'),
      },
      {
        id: 'stills',
        title: '关键帧静帧',
        kind: 'agent',
        prompt: [
          '按分镜出首帧；hq/动作镜可补尾帧。画风:{{style}}。',
          '分镜：\n{{steps.storyboard.output}}',
          '锁定资产：\n{{steps.assert_locked.output}}',
          '用 mcp__media__generate_image。预算紧则优先 hq+钩子+结尾。',
          '最终输出只能是 JSON 数组（可代码围栏），不要其它长文：',
          '[{"shotId":"S01","startPath":"<真实本机路径>","endPath":null}]',
          '禁止编造路径。',
        ].join('\n'),
      },
      {
        id: 'animatic',
        title: 'Animatic 节奏表',
        kind: 'llm',
        prompt: [
          '输出 Animatic JSON（不要围栏）。只依据分镜判断节奏/连续；勿复述分镜全文。',
          '分镜：\n{{steps.storyboard.output}}',
          '静帧JSON：\n{{steps.stills.output}}',
          '字段：{totalSeconds,shotCount,pacingNotes[≤5],continuityChain[{fromShotId,toShotId,ok}],riskShots[{shotId,reason,recommend}],draftPlan[{shotId,costTier}],readyForVideo,humanChecklist[≤5]}',
          '问题严重则 readyForVideo=false。',
        ].join('\n'),
      },
      {
        id: 'gate_board',
        title: '确认分镜与 Animatic',
        kind: 'approval',
        prompt: '确认分镜节奏、关键帧与 Animatic.readyForVideo。通过后生成 Draft/HQ I2V 提示词；改镜请拒绝并写 shotId。',
      },
      {
        id: 'video_prompts',
        title: '镜头视频提示词',
        kind: 'llm',
        prompt: [
          '为每镜写 I2V JSON 数组（不要围栏）。firstFrameRef 填 shotId 即可。',
          '分镜：\n{{steps.storyboard.output}}',
          'Animatic：\n{{steps.animatic.output}}',
          '字段：shotId,durationSec,costTier,i2vPrompt(≤80字),cameraMove,firstFrameRef,lastFrameHint,negativePrompt,skipIfBudgetLow。',
          '默认 draft；仅 hq/风险镜精修；短镜、克制运镜、角色一致。',
        ].join('\n'),
      },
      {
        id: 'gate_video',
        title: '确认视频生成',
        kind: 'approval',
        prompt: '确认 I2V 包：先 Draft 后选镜 HQ。本流水线默认只出提示词与清单，不自动批量烧钱出片。',
      },
      {
        id: 'video_notes',
        title: '视频与音画制作清单',
        kind: 'llm',
        prompt: [
          '写制作清单 Markdown，总字数≤700。',
          '含：镜头表(shotId/秒/costTier/I2V摘要)、Draft vs HQ、TTS/BGM/字幕要点、合成与验收。',
          'I2V：\n{{steps.video_prompts.output}}',
          'Animatic：\n{{steps.animatic.output}}',
          '勿粘贴原文长 JSON；只摘要。',
        ].join('\n'),
      },
      {
        id: 'assemble',
        title: '成片交付摘要',
        kind: 'llm',
        prompt: [
          '从清单提炼交付摘要，≤250字：卖点、镜数/时长、Draft/HQ待办、人工项、5个话题标签发布文案。',
          '清单：\n{{steps.video_notes.output}}',
        ].join('\n'),
      },
    ],
    source: 'builtin',
  }
}
