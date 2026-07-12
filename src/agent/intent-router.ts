// [XJC] 分级意图路由（Token 优化地基）
//
// 目的：用户消息进入执行前先做「分级意图判定」，据此裁剪本轮的工具集与系统提示词层级，
// 避免无论意图如何都全量挂载 30+ 工具、注入超大 system prompt（连「你好」都付全部固定开销）。
//
// - Stage 0：确定性规则（零成本，覆盖高频）——闲聊/寒暄/能力咨询、以及生图/改图/视频。
// - Stage 1：轻量单发模型兜底（仅在短消息且 Stage 0 未命中时触发，复用当前激活模型）。
//
// 保守原则（第一版铁律）：只有「高置信的安全类别」才裁剪，其余一律回退到 full（等同现状），
// 附件、复杂/不确定请求都保持全量工具，绝不因为省 token 而破坏既有能力。

import type { MediaIntent } from './media-intent.ts'
import { runSingleCompletion } from './persona-optimizer.ts'
import { getLogger } from '../logger/index.ts'

export type IntentCategory = 'chitchat' | 'image' | 'video' | 'translate' | 'tasks' | 'knowledge' | 'other'

/**
 * 工具挂载策略：full=全量（现状）；media=仅媒体相关；tasks=仅定时任务管理；
 * knowledge=仅知识库检索；minimal=仅极少通用工具（闲聊/纯文本任务如翻译）。
 */
export type ToolPolicy = 'minimal' | 'media' | 'tasks' | 'knowledge' | 'full'

/** 系统提示词层级：full=完整（现状）；lean=精简（仅身份/风格/红线 + 当前上下文）。 */
export type PromptTier = 'lean' | 'full'

export interface RoutingDecision {
  category: IntentCategory
  toolPolicy: ToolPolicy
  promptTier: PromptTier
  source:
    | 'disabled'
    | 'stage0-media'
    | 'stage0-chitchat'
    | 'stage0-tasks'
    | 'stage0-knowledge'
    | 'stage0-translate'
    | 'attachments'
    | 'stage1'
    | 'default'
  reason: string
}

export interface IntentClassifier {
  (text: string, opts: { agentModel?: string | null; signal?: AbortSignal; agentId?: string }): Promise<IntentCategory>
}

export interface RouteIntentInput {
  text: string
  /** 本轮附件构成：none=无；images-only=全是图片（改图输入）；mixed=含文档等其它类型。 */
  attachmentsKind: 'none' | 'images-only' | 'mixed'
  /** 来自 resolveMediaTurnContext 的确定性媒体意图（已含挂起确认等逻辑）。 */
  mediaIntent: MediaIntent | null
}

export interface RouteIntentOptions {
  /** 总开关，默认开启；关闭时恒返回 full（等同未接入路由的现状）。 */
  enabled?: boolean
  /** Stage 1 轻量模型分类开关，默认开启。 */
  lightClassifier?: boolean
  /** 可注入的 Stage 1 分类器（测试用；默认走当前激活模型单发）。 */
  classify?: IntentClassifier
  agentModel?: string | null
  signal?: AbortSignal
  agentId?: string
}

/** Stage 1 只对「短消息」生效：明显的长/复杂请求直接走 full，避免为必然全量的结果白白多调一次模型。 */
const LIGHT_CLASSIFIER_MAX_CHARS = 60
/** 闲聊判定的长度上限：更长的消息即便像寒暄也保守走 full。 */
const CHITCHAT_MAX_CHARS = 24

// 纯寒暄 / 致谢 / 告别 / 语气词（整句匹配）。
// 注意：故意不含「好的/ok/收到/了解/明白/嗯/哦」等确认词——它们往往是对上一轮
// 任务提议的放行（如"需要我开始整理吗？"→"好的"），裁掉工具会让任务无法继续。
const GREETING =
  /^(?:你好呀?|您好|哈喽|哈啰|嗨+|嘿+|hi+|hello|hey|早|早安|早上好|中午好|下午好|晚上好|晚安|在吗|在不在|在么|在不|你在吗|谢谢(?:你|啦|了)?|多谢|感谢你?|thanks|thank\s?you|thx|再见|拜拜|bye|goodbye|辛苦了?|你好厉害|你真棒|哈哈+|嘿嘿+)[\s，,。.!！?？~、…]*$/i

// 能力 / 身份咨询（用文字回答即可，不需要工具）
const META_ABILITY =
  /(?:你是谁|你叫什么|你的名字|介绍一下(?:你自己|自己|一下)?|自我介绍|你能(?:做|干|帮我做)(?:什么|啥|些什么|哪些)|你会(?:做|干)?什么|能做(?:什么|啥|哪些)|有(?:什么|哪些)(?:功能|能力|技能)|怎么(?:用|使用)你|你能帮我(?:做|干)什么)|(?:who\s+are\s+you|what\s+can\s+you\s+do|introduce\s+yourself|your\s+name)/i

// 确认/放行词：常是对上一轮任务提议的肯定（"要我开始吗？"→"好的"），必须保持全量工具，
// 且不允许进入 Stage 1（轻量分类器看不到历史，几乎必然把它们误判成闲聊）。
const BARE_AFFIRMATION =
  /^(?:好的?|好呀|好嘞|行(?:的|啊|吧)?|可以(?:的|了|啊)?|没问题|嗯+|哦+|噢+|是的?|对的?|确认|同意|继续|开始吧?|做吧|去吧|ok(?:ay)?|yes|yeah|yep|sure|confirm|proceed|go\s?ahead|收到|了解|明白|知道了)[\s，,。.!！?？~、…]*$/i

// 任务信号：出现即不算纯闲聊（动词 / 文件类型 / 路径 / URL / 记忆诉求）
const TASK_SIGNAL =
  /帮我|请帮|帮忙|生成|制作|做(?:一|个|份|张|完)|写(?:一|个|篇|份|下|个)|画(?:一|个|张|幅)?|翻译|总结|概括|整理|分析|统计|计算|查(?:一下|询|找|查)?|搜索|检索|下载|上传|发送|发给|发到|读取|打开|运行|执行|安装|创建|建(?:一|个)|列出|删除|修改|改(?:一下|成|个)|优化|重构|规划|安排|提取|转换|录音|转写|记住|记得|我叫|我是谁|周报|报告|文档|表格|ppt|excel|word|pdf|邮件|视频|图片?|https?:\/\/|[a-zA-Z]:\\|\/\w/i

// 文件/落盘引用：出现即说明纯文本档位不够用（需要读写文件/下载），相关窄档位一律回退 full。
const FILE_REF =
  /https?:\/\/|[a-zA-Z]:\\|(?:^|[\s"'（(])\/\w|\.(?:docx?|xlsx?|pptx?|pdf|csv|txt|md|png|jpe?g|gif|webp|zip|mp[34])\b|文件|文档|附件|保存|落盘|写入|导出|输出到/i

// 纯文本翻译：内容就在对话里（本句或上文），零工具即可完成。带文件/落盘引用的翻译走 full。
const TRANSLATE =
  /^(?:请|帮我|给我|麻烦)?\s*(?:把|将)?[^。！？!?\n]{0,60}(?:翻译成?|译成|翻成)|^(?:请|帮我|给我|麻烦)?\s*翻译|\btranslate\b/i

// 定时任务管理：建/查/改/停提醒与定时任务，只需要 task 工具（任务到点执行时才需要完整能力）。
const TASK_MGMT =
  /定时任务|(?:提醒我)|(?:每(?:天|周|月|小时)|每隔|工作日|周[一二三四五六日末]).{0,24}(?:提醒|发我|推送|汇报|简报|执行|运行)|(?:查看|列出|看看|取消|删除|暂停|恢复|停掉|关掉|修改|调整).{0,10}(?:定时|提醒|任务列表)/i

// 知识库问答：显式提到知识库/资料库才路由（最强锚点，避免误伤普通检索请求）。
const KNOWLEDGE_QA = /知识库|资料库/

/** 确定性闲聊判定：短、无任务信号、命中寒暄或能力咨询。能力咨询优先于任务信号排除。 */
export function isChitchat(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const compact = t.replace(/\s+/g, '')
  if (compact.length > CHITCHAT_MAX_CHARS) return false
  if (BARE_AFFIRMATION.test(t)) return false
  if (META_ABILITY.test(t)) return true
  if (TASK_SIGNAL.test(t)) return false
  if (GREETING.test(t)) return true
  return false
}

function parseCategory(raw: string): IntentCategory {
  const s = raw.toLowerCase()
  if (/\bchitchat\b|闲聊|寒暄/.test(s)) return 'chitchat'
  if (/\bvideo\b|视频/.test(s)) return 'video'
  if (/\bimage\b|图片|图像|生图/.test(s)) return 'image'
  return 'other'
}

const CLASSIFIER_SYSTEM_PROMPT = [
  '你是意图分类器。判断用户这句话属于哪一类，只输出一个类别词，不要解释、不要标点。',
  '类别：',
  '- chitchat：纯闲聊、问候、感谢、告别，或询问你是谁/你能做什么',
  '- image：让你生成图片或修改图片',
  '- video：让你生成视频',
  '- other：其它一切需要动用工具、读写文件、联网检索、办公处理、编程、数据分析、定时任务等的请求',
  '只输出：chitchat 或 image 或 video 或 other',
].join('\n')

const DEFAULT_CLASSIFIER: IntentClassifier = async (text, opts) => {
  const raw = await runSingleCompletion(CLASSIFIER_SYSTEM_PROMPT, text.slice(0, 200), {
    agentModel: opts.agentModel,
    agentId: opts.agentId,
    purpose: 'intent_classification',
    signal: opts.signal,
  })
  return parseCategory(raw)
}

function fullDecision(source: RoutingDecision['source'], reason: string): RoutingDecision {
  return { category: 'other', toolPolicy: 'full', promptTier: 'full', source, reason }
}

/**
 * 分级意图路由：产出本轮的工具/提示词裁剪决策。默认安全——任何不确定都回退 full。
 */
export async function routeIntent(input: RouteIntentInput, options: RouteIntentOptions = {}): Promise<RoutingDecision> {
  if (options.enabled === false) {
    return fullDecision('disabled', 'intent routing disabled')
  }

  // Stage 0 —— 确定性，零成本
  // 媒体意图仅在「无附件或纯图片附件」时裁剪：带文档附件的媒体请求（如"参考这份 PDF 生成海报"）
  // 需要 document 工具解析文档，必须保持全量。
  if (input.mediaIntent && input.attachmentsKind !== 'mixed') {
    const category: IntentCategory = input.mediaIntent === 'generate-video' ? 'video' : 'image'
    return { category, toolPolicy: 'media', promptTier: 'full', source: 'stage0-media', reason: `media intent: ${input.mediaIntent}` }
  }
  if (input.attachmentsKind !== 'none') {
    return fullDecision('attachments', 'has attachments; keep full toolset')
  }
  if (isChitchat(input.text)) {
    return { category: 'chitchat', toolPolicy: 'minimal', promptTier: 'lean', source: 'stage0-chitchat', reason: 'deterministic chitchat' }
  }
  const text = input.text.trim()
  const hasFileRef = FILE_REF.test(text)
  // 定时任务管理：优先于翻译/知识库判定（"每天提醒我翻译打卡"是任务管理不是翻译）。
  if (TASK_MGMT.test(text) && !hasFileRef) {
    return { category: 'tasks', toolPolicy: 'tasks', promptTier: 'full', source: 'stage0-tasks', reason: 'scheduled-task management' }
  }
  if (KNOWLEDGE_QA.test(text) && !hasFileRef) {
    return { category: 'knowledge', toolPolicy: 'knowledge', promptTier: 'full', source: 'stage0-knowledge', reason: 'knowledge-base query' }
  }
  // 纯文本翻译：内容在对话里（本句自带或指上文），零工具完成；提到文件/链接/落盘则回退全量。
  if (TRANSLATE.test(text) && !hasFileRef) {
    return { category: 'translate', toolPolicy: 'minimal', promptTier: 'full', source: 'stage0-translate', reason: 'inline text translation' }
  }

  // Stage 1 —— 轻量模型兜底。仅对「短且无明确任务信号、非裸确认」的消息触发：
  // 长消息或带任务信号（帮我/写/画/翻译…）的必然是 other→full，不值得多花一次分类调用；
  // 裸确认词（"好的"）依赖上一轮上下文，分类器单看本句必然误判，直接保持全量。
  const trimmedText = input.text.trim()
  const compact = trimmedText.replace(/\s+/g, '')
  const eligible = options.lightClassifier !== false
    && compact.length > 0
    && compact.length <= LIGHT_CLASSIFIER_MAX_CHARS
    && !TASK_SIGNAL.test(input.text)
    && !BARE_AFFIRMATION.test(trimmedText)
  if (eligible) {
    const classify = options.classify ?? DEFAULT_CLASSIFIER
    try {
      const category = await classify(input.text, { agentModel: options.agentModel, signal: options.signal, agentId: options.agentId })
      if (category === 'chitchat') return { category, toolPolicy: 'minimal', promptTier: 'lean', source: 'stage1', reason: 'light classifier: chitchat' }
      if (category === 'image') return { category, toolPolicy: 'media', promptTier: 'full', source: 'stage1', reason: 'light classifier: image' }
      if (category === 'video') return { category, toolPolicy: 'media', promptTier: 'full', source: 'stage1', reason: 'light classifier: video' }
      // other → 落到下方 full
    } catch (err) {
      try {
        getLogger().debug(
          { error: err instanceof Error ? err.message : String(err), category: 'agent' },
          'Intent light classifier failed; falling back to full toolset',
        )
      } catch {
        // 日志是 best-effort（单测环境 logger 未初始化），绝不影响回退到 full。
      }
    }
  }

  return fullDecision('default', 'no confident narrow intent; keep full')
}

const MINIMAL_KEEP = new Set(['mcp__message__send_to_current_chat', 'mcp__memory__remember', 'mcp__memory__recall'])
const MEDIA_KEEP = new Set(['mcp__minimax__understand_image', 'mcp__message__send_to_current_chat', 'read'])
const TASKS_KEEP = new Set(['mcp__task__list_tasks', 'mcp__task__update_task', 'mcp__message__send_to_current_chat', 'mcp__workflow__list_workflows'])
const KNOWLEDGE_KEEP = new Set(['mcp__knowledge__search_knowledge', 'mcp__message__send_to_current_chat', 'mcp__memory__recall'])

/**
 * 按工具策略裁剪工具数组（白名单式：只保留明确需要的，其余丢弃）。
 * full 原样返回；minimal 仅留极少通用工具（闲聊/纯文本翻译）；media 仅留媒体族 + 看图 + 回发 + 读文件；
 * tasks 仅留定时任务管理（含工作流列表，绑定工作流任务要用）；knowledge 仅留知识库检索。
 */
export function filterToolsByPolicy<T extends { name: string }>(tools: T[], policy: ToolPolicy): T[] {
  if (policy === 'full') return tools
  return tools.filter((tool) => {
    const name = tool.name.trim().toLowerCase()
    if (policy === 'minimal') return MINIMAL_KEEP.has(name)
    if (policy === 'tasks') return TASKS_KEEP.has(name)
    if (policy === 'knowledge') return KNOWLEDGE_KEEP.has(name)
    // media
    if (name.startsWith('mcp__media__')) return true
    return MEDIA_KEEP.has(name)
  })
}

/** 窄档位的兜底锚点工具：裁剪后必须仍然包含，否则说明该员工缺此能力，应放弃裁剪回退全量。 */
export const POLICY_ANCHOR_TOOL: Partial<Record<ToolPolicy, string>> = {
  media: 'mcp__media__',
  tasks: 'mcp__task__list_tasks',
  knowledge: 'mcp__knowledge__search_knowledge',
}
