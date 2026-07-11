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
const MEDIA_CONFIRM_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_MEDIA_CONFIRMATIONS = 1024
// [XJC] 待确认媒体请求（按会话一条）：视频=待付费确认；生图/改图=已识别意图但内容不足，
// 等用户补内容或明确「授权/确认/生成吧」再放行——让「先问后授权」的多轮流程能闭环。
interface PendingMediaConfirmation {
  intent: MediaIntent
  expiresAt: number
}
const pendingMediaConfirmations = new Map<string, PendingMediaConfirmation>()

const META_REQUEST =
  /(?:能不能|能否|可以吗|是否可以|会不会|支持吗|(?:能|会|支持).{0,16}(?:吗|么)$|如何|怎么|怎样|教程|文档|说明|介绍|解释|提示词|prompt|为什么|失败|报错|无法|不能用|排查|多少钱|花多少钱|花钱吗|要花钱吗|收费吗|收不收费|贵不贵|贵吗|扣费吗|扣多少)|\b(?:can you|are you able|how (?:do|to|much)|does it cost|tutorial|documentation|explain|troubleshoot|prompt only)\b/i
// [XJC] 疑问句（非肯定）：挂起的生图/改图不能被「这个要花钱吗？」「画成什么样？」这类追问误当作放行。
const INTERROGATIVE = /[?？]\s*$|(?:吗|呢|嘛)\s*[?？]?\s*$|^(?:什么|为什么|怎么|怎样|如何|多少|哪|是不是|要不要)/
const NEGATED_MEDIA_ACTION =
  /(?:不要|别|无需|不需要|禁止)[^，,。！？!?\n]{0,16}(?:生成|生图|画|绘制|制作|创建|修改|编辑|改图)|\b(?:do not|don't|dont|no need to)\s+(?:generate|create|draw|edit|make)\b/i
const EDIT_IMAGE =
  /(?:改图|图生图|重绘)|(?:修改|编辑|更换|替换|换成|改成|去掉|移除).{0,18}(?:图片|图像|照片|背景)|(?:图片|图像|照片).{0,20}(?:换成|改成|替换为|去掉|移除)|\b(?:edit|modify|retouch|replace).{0,20}(?:image|picture|photo|background)\b|\bremove the background\b/i
const GENERATE_VIDEO =
  /(?:生成|制作|创建|做)[^。！？!?\n]{0,36}(?:视频|短片|动画)|(?:文生视频|图生视频)|(?:图片|图像|照片).{0,18}(?:变成|改成|生成).{0,10}(?:视频|短片|动画)|\b(?:generate|create|make|turn).{0,36}(?:video|animation|clip)\b/i
const GENERATE_IMAGE =
  /(?:生成|制作|创建|画|绘制|做|设计)(?:一张|一幅|一个|一些|几张|个|张|幅)?[^。！？!?\n]{0,48}(?:图片|图像|海报|封面|配图|头像|商品图|插画|壁纸|表情包|logo|标志|图标|banner|横幅|icon|[\u4e00-\u9fa5]{1,8}图(?!表))|(?:生图|文生图|出图|作图)|^(?:请|帮我|给我)?\s*(?:画|绘制)\s*\S+|\b(?:generate|create|draw|make|design).{0,48}(?:image|picture|poster|cover|logo|banner|icon|illustration|wallpaper|avatar)\b/i
const SIMPLE_CONFIRM = /^(?:确认|同意|授权|继续生成|继续|yes|confirm|approved?|proceed)[。.!！\s]*$/i
// [XJC] 生图/改图闭环：用户对「先前已识别的媒体请求」的口语化肯定/授权（区别于严格的视频付费确认）。
const AFFIRM_MEDIA =
  /^(?:好的?|好呀|好嘞|行|可以了?|没问题|生成吧|开始吧?|做吧|画吧|就这样|就这么办|授权了?|同意了?|ok|okay|sure|go\s?ahead|do it|proceed)[。.!！~\s]*$/i
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
    /(?:请|帮我|给我|调用|使用|通过|一下|一个|一张|一幅|一些|几张|硅基流动|siliconflow|api|接口|生成|制作|创建|绘制|画|做|设计|图片|图像|生图|海报|封面|配图|头像|商品图|宣传图|宣传画|示意图|效果图|插画|插图|壁纸|头图|主图|长图|表情包|logo|标志|图标|banner|横幅|icon|修改|编辑|改图|图生图|视频|短片|动画)/gi
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

function notConfiguredContext(intent: MediaIntent): MediaTurnContext {
  return {
    intent,
    authorization: { ...EMPTY_AUTHORIZATION, reason: `${intent} is not configured` },
    systemInstruction:
      `<runtime_media_instruction>The user requested ${intent}, but it is not configured. ` +
      `Do not call skills or ask for an API Key in chat. Guide the user to 设置 → 语音与媒体.</runtime_media_instruction>`,
  }
}

function authorizedContext(intent: MediaIntent, isConfigured: boolean): MediaTurnContext {
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
      ? buildConfiguredInstruction(intent, toolFor(intent))
      : `<runtime_media_instruction>The user requested ${intent}, but configuration status is unknown. Do not search for skills or ask for a secret. If the tool is unavailable, guide the user to 设置 → 语音与媒体.</runtime_media_instruction>`,
  }
}

function confirmedVideoContext(status?: MediaStatus): MediaTurnContext {
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

/**
 * 生图/改图的多轮闭环：先前一轮已识别意图但内容不足而挂起，本轮用户补内容或明确肯定/授权
 * （「我授权你生成」「确认」「好的，生成吧」「就用橘色爪子」）即视为把这次请求走完。
 * 排除元问题/否定，避免把「这要花钱吗」「先不用」误当成放行。
 */
function continuesPendingImage(text: string, intent: MediaIntent): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (META_REQUEST.test(text) || NEGATED_MEDIA_ACTION.test(text)) return false
  // 明确肯定/授权即放行。
  if (SIMPLE_CONFIRM.test(trimmed) || AFFIRM_MEDIA.test(trimmed)) return true
  // 反问句不算「补充内容」（如「这个要花钱吗？」「画成什么样？」），交回对话由模型解答。
  if (INTERROGATIVE.test(trimmed)) return false
  // 用户在回答我们「想画什么内容」的追问：带有实质内容即放行。
  return hasEssentialMediaDetails(intent, text)
}

function setPendingMedia(chatId: string, intent: MediaIntent, now: number): void {
  pendingMediaConfirmations.set(chatId, { intent, expiresAt: now + MEDIA_CONFIRM_TTL_MS })
}

export function resolveMediaTurnContext(
  chatId: string,
  text: string,
  status?: MediaStatus,
  now = Date.now(),
): MediaTurnContext {
  for (const [pendingChatId, entry] of pendingMediaConfirmations) {
    if (entry.expiresAt <= now) pendingMediaConfirmations.delete(pendingChatId)
  }
  while (pendingMediaConfirmations.size > MAX_PENDING_MEDIA_CONFIRMATIONS) {
    const oldest = pendingMediaConfirmations.keys().next().value
    if (typeof oldest !== 'string') break
    pendingMediaConfirmations.delete(oldest)
  }

  const trimmed = text.trim()
  if (CANCEL_CONFIRM.test(trimmed)) {
    pendingMediaConfirmations.delete(chatId)
    return {
      intent: null,
      authorization: { ...EMPTY_AUTHORIZATION, reason: 'The pending media request was cancelled' },
      systemInstruction: null,
    }
  }

  const pending = pendingMediaConfirmations.get(chatId)
  const intent = detectMediaIntent(text)

  // --- 消费上一轮挂起的媒体请求（闭环关键） ---
  if (pending) {
    if (pending.intent === 'generate-video') {
      // 视频保持严格付费确认（简单确认或「确认……视频」锚定）。
      if (SIMPLE_CONFIRM.test(trimmed) || hasVideoAnchoredConfirmation(text)) {
        pendingMediaConfirmations.delete(chatId)
        return confirmedVideoContext(status)
      }
      if (intent && intent !== 'generate-video') {
        pendingMediaConfirmations.delete(chatId) // 改口去做别的媒体 → 丢弃挂起，走全新识别
      } else if (!intent) {
        return { intent: null, authorization: { ...EMPTY_AUTHORIZATION, reason: 'Awaiting billed video confirmation' }, systemInstruction: null }
      }
      // intent === 'generate-video'（再次发起）→ 落到下方全新处理，重置挂起。
    } else {
      // 生图/改图挂起：用户补内容或明确授权即闭环放行。
      if (intent && intent !== pending.intent) {
        pendingMediaConfirmations.delete(chatId) // 改口去做别的媒体 → 走全新识别
      } else if (continuesPendingImage(text, pending.intent)) {
        pendingMediaConfirmations.delete(chatId)
        const configured = configuredFor(pending.intent, status)
        return configured === false ? notConfiguredContext(pending.intent) : authorizedContext(pending.intent, configured === true)
      } else if (!intent) {
        // 仍不足（如追问「这要花钱吗」）：保留挂起，本轮不触发媒体调用。
        return { intent: null, authorization: { ...EMPTY_AUTHORIZATION, reason: `Awaiting ${pending.intent} content` }, systemInstruction: null }
      }
      // intent === pending.intent（本轮又完整说了一次）→ 落到下方全新处理。
    }
  }

  if (!intent) {
    return { intent: null, authorization: { ...EMPTY_AUTHORIZATION }, systemInstruction: null }
  }

  const configured = configuredFor(intent, status)
  if (configured === false) {
    return notConfiguredContext(intent)
  }

  if (intent === 'generate-video' && !hasVideoAnchoredConfirmation(text)) {
    setPendingMedia(chatId, 'generate-video', now)
    return {
      intent,
      authorization: { ...EMPTY_AUTHORIZATION, reason: 'Video generation requires explicit billed-call confirmation' },
      systemInstruction:
        '<runtime_media_instruction>The user requested video generation, but has not explicitly confirmed the billed call. Ask for confirmation of the prompt and cost. Do not call the video tool yet.</runtime_media_instruction>',
    }
  }

  const isConfigured = configured === true
  if (isConfigured && !hasEssentialMediaDetails(intent, text)) {
    // 生图/改图：挂起本次请求，下一轮补内容/授权即闭环。
    if (intent === 'generate-image' || intent === 'edit-image') setPendingMedia(chatId, intent, now)
    return {
      intent,
      authorization: { ...EMPTY_AUTHORIZATION, reason: `Essential ${intent} details are missing` },
      systemInstruction:
        `<runtime_media_instruction>The built-in ${intent} capability is configured, but the user has not provided enough subject/content details. ` +
        `Ask only what they want to create or change. Do not call the media tool yet, do not search for skills, and do not ask for an API Key.</runtime_media_instruction>`,
    }
  }
  return authorizedContext(intent, isConfigured)
}

export function clearMediaConfirmationState(): void {
  pendingMediaConfirmations.clear()
}
