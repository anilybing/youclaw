// [XJC] 定时任务媒体产物内联展示（scheduler media attachments）
/**
 * 目标：让【定时任务】落库的媒体产物在 XiaoJuClaw 应用内也能像 web 聊天一样结构化内联展示。
 *
 * 定时任务结果里的图片/视频通过 [[attach:...]] 标记声明（见 ./attachments.ts）。此前落库只把附件
 * 拼成正文「📎 <路径>」文本行，不会写结构化 messages.attachments，所以应用内不会内联渲染。
 *
 * 这里把 extractAttachments 得到的路径中——位于该任务 agent 工作区内、真实存在、且是图片/视频
 * 扩展名的文件——转成 Attachment[]（{filename, mediaType, filePath}），由 saveTaskMessages 写入
 * messages.attachments，与 web 聊天口径一致（前端 AssistantMessage 用 <img>/<video> 渲染）。
 *
 * 安全边界复用 ./attachments.ts 的 validateAttachmentPaths：绝对路径 + 真实普通文件 + 工作区内
 * （realpath 归一化，防 ../ 与符号链接逃逸）。
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Attachment } from '../types/attachment.ts'
import { MAX_TASK_ATTACHMENTS, validateAttachmentPaths } from './attachments.ts'

/**
 * 图片/视频扩展名 → mediaType。
 * 与 src/agent/media-attachments.ts 保持一致，前端按 image/、video/ 前缀决定内联渲染方式；
 * 非图片/视频扩展名不在表内，不会生成 attachment（如 pptx/xlsx/html 只保留 📎 文本行）。
 */
const MEDIA_EXT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/** 按扩展名推断可内联的媒体类型；非图片/视频返回 null（大小写不敏感）。 */
export function mediaTypeForPath(path: string): string | null {
  return MEDIA_EXT_TYPE[extname(path).toLowerCase()] ?? null
}

/**
 * 单个路径 → 可内联展示的消息附件。
 * - 仅对图片/视频扩展名生成，其余返回 null；
 * - realpath + existsSync 做存在性校验，缺失返回 null；
 * - filename/filePath 均用 realpath 结果，与 web 聊天（src/agent/media-attachments.ts）口径一致。
 *
 * 注意：本函数不做工作区归属校验，调用方须先经 validateAttachmentPaths 过滤
 * （见 buildTaskMediaAttachments）。
 */
export function mediaAttachmentFromPath(path: string): Attachment | null {
  const mediaType = mediaTypeForPath(path)
  if (!mediaType) return null
  let realPath: string
  try {
    realPath = realpathSync(path)
  } catch {
    return null
  }
  if (!existsSync(realPath)) return null
  return { filename: basename(realPath), mediaType, filePath: realPath }
}

/**
 * 从 [[attach:...]] 提取到的路径列表构造定时任务的结构化媒体附件：
 * 1. 先经 validateAttachmentPaths 按 agent 工作区做安全校验（绝对路径 + 真实文件 + 工作区内）；
 * 2. 再仅保留图片/视频扩展名并转 Attachment；
 * 3. 最多返回 MAX_TASK_ATTACHMENTS 个，与渠道投递上限一致。
 *
 * 任何单个路径的意外都跳过，不影响其余附件；无可用媒体时返回空数组。
 */
export function buildTaskMediaAttachments(paths: string[], agentWorkspaceDir: string): Attachment[] {
  if (paths.length === 0) return []

  const { accepted } = validateAttachmentPaths(paths, agentWorkspaceDir)
  const attachments: Attachment[] = []
  for (const path of accepted) {
    const attachment = mediaAttachmentFromPath(path)
    if (!attachment) continue
    attachments.push(attachment)
    if (attachments.length >= MAX_TASK_ATTACHMENTS) break
  }
  return attachments
}
