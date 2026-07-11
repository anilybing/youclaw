// [XJC] Deterministic media intent + per-turn billing authorization.
import type { MediaStatus } from '../media/types.ts'

export type MediaIntent = 'generate-image' | 'edit-image' | 'generate-video'

export interface MediaToolAuthorization {
  allowGenerateImage: boolean
  allowEditImage: boolean
  allowGenerateVideo: boolean
  reason: string
}

export interface MediaTurnContext {
  intent: MediaIntent | null
  authorization: MediaToolAuthorization
  systemInstruction: string | null
}

const EMPTY_AUTHORIZATION: MediaToolAuthorization = {
  allowGenerateImage: false,
  allowEditImage: false,
  allowGenerateVideo: false,
  reason: 'No explicit media action was authorized for this turn',
}
const VIDEO_CONFIRM_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_VIDEO_CONFIRMATIONS = 1024
const pendingVideoConfirmations = new Map<string, number>()

const META_REQUEST =
  /(?:能不能|能否|可以吗|是否可以|会不会|支持吗|(?:能|会|支持).{0,16}(?:吗|么)$|如何|怎么|怎样|教程|文档|说明|介绍|解释|提示词|prompt|为什么|失败|报错|无法|不能用|排查)|\b(?:can you|are you able|how (?:do|to)|tutorial|documentation|explain|troubleshoot|prompt only)\b/i
const NEGATED_MEDIA_ACTION =
  /(?:不要|别|无需|不需要|禁止)[^，,。！？!?\n]{0,16}(?:生成|生图|画|绘制|制作|创建|修改|编辑|改图)|\b(?:do not|don't|dont|no need to)\s+(?:generate|create|draw|edit|make)\b/i
const EDIT_IMAGE =
  /(?:改图|图生图|重绘)|(?:修改|编辑|更换|替换|换成|改成|去掉|移除).{0,18}(?:图片|图像|照片|背景)|(?:图片|图像|照片).{0,20}(?:换成|改成|替换为|去掉|移除)|\b(?:edit|modify|retouch|replace).{0,20}(?:image|picture|photo|background)\b|\bremove the background\b/i
const GENERATE_VIDEO =
  /(?:生成|制作|创建|做)[^。！？!?\n]{0,36}(?:视频|短片|动画)|(?:文生视频|图生视频)|(?:图片|图像|照片).{0,18}(?:变成|改成|生成).{0,10}(?:视频|短片|动画)|\b(?:generate|create|make|turn).{0,36}(?:video|animation|clip)\b/i
const GENERATE_IMAGE =
  /(?:生成|制作|创建|画|绘制|做)(?:一张|一个|一些|几张)?[^。！？!?\n]{0,48}(?:图片|图像|海报|封面|配图|头像|商品图)|(?:生图|文生图)|^(?:请|帮我|给我)?\s*(?:画|绘制)\s*\S+|\b(?:generate|create|draw|make).{0,48}(?:image|picture|poster|cover)\b/i
const SIMPLE_CONFIRM = /^(?:确认|同意|授权|继续生成|继续|yes|confirm|approved?|proceed)[。.!！\s]*$/i
const CANCEL_CONFIRM = /^(?:取消|算了|不生成了|停止|cancel|stop)[。.!！\s]*$/i

function splitClauses(text: string): string[] {
  return text
    .split(/[，,。；;！？!?\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function hasVideoAnchoredConfirmation(text: string): boolean {
  return splitClauses(text).some((clause) => {
    const hasVideo = /(?:视频|短片|动画)|\b(?:video|animation|clip)\b/i.test(clause)
    const hasConfirmation = /(?:确认|同意|授权|继续)|\b(?:confirm|approved?|i agree|proceed)\b/i.test(clause)
    return hasVideo && hasConfirmation
  })
}

function detectClauseIntent(clause: string): MediaIntent | null {
  if (!clause || NEGATED_MEDIA_ACTION.test(clause) || META_REQUEST.test(clause)) return null
  // Video wins over edit for phrases such as “把图片改成 5 秒视频”.
  if (GENERATE_VIDEO.test(clause)) return 'generate-video'
  if (EDIT_IMAGE.test(clause)) return 'edit-image'
  if (GENERATE_IMAGE.test(clause)) return 'generate-image'
  return null
}

export function detectMediaIntent(text: string): MediaIntent | null {
  for (const clause of splitClauses(text)) {
    const intent = detectClauseIntent(clause)
    if (intent) return intent
  }
  return null
}

function configuredFor(intent: MediaIntent, status?: MediaStatus): boolean | undefined {
  if (!status) return undefined
  if (intent === 'generate-image') return status.imageConfigured
  if (intent === 'edit-image') return status.imageEditConfigured
  return status.videoConfigured
}

function toolFor(intent: MediaIntent): string {
  if (intent === 'generate-image') return 'mcp__media__generate_image'
  if (intent === 'edit-image') return 'mcp__media__edit_image'
  return 'mcp__media__generate_video'
}

function hasEssentialMediaDetails(intent: MediaIntent, text: string): boolean {
  const providerAndActionWords =
    /(?:请|帮我|给我|调用|使用|通过|一下|一个|一张|一些|几张|硅基流动|siliconflow|api|接口|生成|制作|创建|绘制|画|做|图片|图像|生图|海报|封面|配图|头像|商品图|修改|编辑|改图|图生图|视频|短片|动画)/gi
  const remaining = text
    .replace(providerAndActionWords, '')
    .replace(/[\s，,。；;！？!?：:"'“”‘’()（）_-]+/g, '')
  if (intent === 'edit-image') {
    return remaining.length >= 2 || /(?:背景|文字|主体|颜色|亮度|尺寸|裁剪|去掉|移除|换成|改成)/.test(text)
  }
  return remaining.length >= 2
}

function buildConfiguredInstruction(intent: MediaIntent, tool: string): string {
  if (intent === 'generate-video') {
    return (
      `<runtime_media_instruction>\n` +
      `The user has explicitly confirmed the billed video generation request. ` +
      `Use \`${tool}\` at most once in this turn with the agreed prompt. ` +
      `Do not use skill discovery and do not ask for an API Key.\n` +
      `</runtime_media_instruction>`
    )
  }
  return (
    `<runtime_media_instruction>\n` +
    `The user explicitly requested ${intent}; the corresponding built-in media configuration is ready. ` +
    `Use \`${tool}\` at most once in this turn when essential visual details are present. ` +
    `Do not use skill discovery and do not ask the user to paste an API Key. ` +
    `If essential visual content is missing, ask only for that content without calling the tool.\n` +
    `</runtime_media_instruction>`
  )
}

export function resolveMediaTurnContext(
  chatId: string,
  text: string,
  status?: MediaStatus,
  now = Date.now(),
): MediaTurnContext {
  for (const [pendingChatId, expiresAt] of pendingVideoConfirmations) {
    if (expiresAt <= now) pendingVideoConfirmations.delete(pendingChatId)
  }
  while (pendingVideoConfirmations.size > MAX_PENDING_VIDEO_CONFIRMATIONS) {
    const oldest = pendingVideoConfirmations.keys().next().value
    if (typeof oldest !== 'string') break
    pendingVideoConfirmations.delete(oldest)
  }
  const pendingUntil = pendingVideoConfirmations.get(chatId)
  if (pendingUntil !== undefined && pendingUntil <= now) pendingVideoConfirmations.delete(chatId)

  if (CANCEL_CONFIRM.test(text.trim())) {
    pendingVideoConfirmations.delete(chatId)
    return {
      intent: null,
      authorization: { ...EMPTY_AUTHORIZATION, reason: 'The pending media request was cancelled' },
      systemInstruction: null,
    }
  }

  const hasPendingVideo = (pendingVideoConfirmations.get(chatId) ?? 0) > now
  const intent = detectMediaIntent(text)
  const confirmsPendingVideo =
    hasPendingVideo && (SIMPLE_CONFIRM.test(text.trim()) || hasVideoAnchoredConfirmation(text))
  if (confirmsPendingVideo) {
    pendingVideoConfirmations.delete(chatId)
    const configured = status?.videoConfigured
    return {
      intent: 'generate-video',
      authorization: {
        ...EMPTY_AUTHORIZATION,
        allowGenerateVideo: configured === true,
        reason: configured === true ? 'Confirmed video generation' : 'Video generation is not configured',
      },
      systemInstruction: configured === true
        ? buildConfiguredInstruction('generate-video', toolFor('generate-video'))
        : '<runtime_media_instruction>Video generation is not configured. Guide the user to 设置 → 语音与媒体; do not call skills or request a secret in chat.</runtime_media_instruction>',
    }
  }

  if (!intent) {
    return { intent: null, authorization: { ...EMPTY_AUTHORIZATION }, systemInstruction: null }
  }
  if (intent !== 'generate-video') pendingVideoConfirmations.delete(chatId)

  const configured = configuredFor(intent, status)
  const tool = toolFor(intent)
  if (configured === false) {
    return {
      intent,
      authorization: { ...EMPTY_AUTHORIZATION, reason: `${intent} is not configured` },
      systemInstruction:
        `<runtime_media_instruction>The user requested ${intent}, but it is not configured. ` +
        `Do not call skills or ask for an API Key in chat. Guide the user to 设置 → 语音与媒体.</runtime_media_instruction>`,
    }
  }

  if (intent === 'generate-video' && !hasVideoAnchoredConfirmation(text)) {
    pendingVideoConfirmations.set(chatId, now + VIDEO_CONFIRM_TTL_MS)
    return {
      intent,
      authorization: { ...EMPTY_AUTHORIZATION, reason: 'Video generation requires explicit billed-call confirmation' },
      systemInstruction:
        '<runtime_media_instruction>The user requested video generation, but has not explicitly confirmed the billed call. Ask for confirmation of the prompt and cost. Do not call the video tool yet.</runtime_media_instruction>',
    }
  }

  const isConfigured = configured === true
  if (isConfigured && !hasEssentialMediaDetails(intent, text)) {
    return {
      intent,
      authorization: { ...EMPTY_AUTHORIZATION, reason: `Essential ${intent} details are missing` },
      systemInstruction:
        `<runtime_media_instruction>The built-in ${intent} capability is configured, but the user has not provided enough subject/content details. ` +
        `Ask only what they want to create or change. Do not call the media tool yet, do not search for skills, and do not ask for an API Key.</runtime_media_instruction>`,
    }
  }
  return {
    intent,
    authorization: {
      ...EMPTY_AUTHORIZATION,
      allowGenerateImage: intent === 'generate-image' && isConfigured,
      allowEditImage: intent === 'edit-image' && isConfigured,
      allowGenerateVideo: intent === 'generate-video' && isConfigured,
      reason: isConfigured ? `Explicit ${intent} request` : 'Media configuration status is unknown',
    },
    systemInstruction: isConfigured
      ? buildConfiguredInstruction(intent, tool)
      : `<runtime_media_instruction>The user requested ${intent}, but configuration status is unknown. Do not search for skills or ask for a secret. If the tool is unavailable, guide the user to 设置 → 语音与媒体.</runtime_media_instruction>`,
  }
}

export function clearMediaConfirmationState(): void {
  pendingVideoConfirmations.clear()
}
