// [XJC] 把内置媒体工具（生图/对话式改图/生视频）本回合产出的文件，收集为可在对话中
// 内联展示的消息附件。runtime 在 tool_execution_end 时调用，随 complete 事件一起下发，
// 由 router 落库到 messages.attachments，前端 AssistantMessage 用 <img>/<video> 渲染。
import { existsSync, realpathSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Attachment } from '../types/attachment.ts'

/** 会产出可展示媒体文件的内置工具（与 media-mcp.ts 的工具名保持一致） */
const MEDIA_TOOL_NAMES = new Set<string>([
  'mcp__media__generate_image',
  'mcp__media__edit_image',
  'mcp__media__generate_video',
])

/** 产物扩展名 → mediaType（前端按 image/ 与 video/ 前缀决定内联渲染方式） */
const EXT_MEDIA_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export function isMediaTool(toolName: string): boolean {
  return MEDIA_TOOL_NAMES.has(toolName)
}

/** media 工具返回 { content: [{ type: 'text', text: JSON({saved, note}) }] }；从中取产物路径。 */
function extractSavedPath(result: unknown): string | null {
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    const text = (part as { text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    try {
      const parsed = JSON.parse(text) as { saved?: unknown }
      if (typeof parsed.saved === 'string' && parsed.saved.trim().length > 0) {
        return parsed.saved.trim()
      }
    } catch {
      // 非 JSON 文本（如错误说明）忽略
    }
  }
  return null
}

/**
 * 从一次 media 工具的 tool_execution_end 结果构造消息附件。
 * 产物由本机 media service 生成、路径可信；仍做扩展名白名单 + realpath 存在性校验做防御。
 * 无法识别或产物缺失时返回 null。
 */
export function mediaAttachmentFromToolResult(
  toolName: string,
  result: unknown,
  isError: boolean,
): Attachment | null {
  if (isError || !isMediaTool(toolName)) return null
  const saved = extractSavedPath(result)
  if (!saved) return null
  const mediaType = EXT_MEDIA_TYPE[extname(saved).toLowerCase()]
  if (!mediaType) return null
  let realPath: string
  try {
    realPath = realpathSync(saved)
  } catch {
    return null
  }
  if (!existsSync(realPath)) return null
  return { filename: basename(realPath), mediaType, filePath: realPath }
}
