// [XJC] 定时任务附件投递（scheduler attachment delivery）
/**
 * 附件标记约定：
 *
 * 定时任务的 agent 在回复文本中用独立标记声明要随推送发到渠道的产物文件：
 *
 *   [[attach:<绝对路径>]]
 *
 * - `attach` 关键字大小写不敏感（[[ATTACH:...]] / [[Attach:...]] 均可）。
 * - 路径可以包含空格；不能包含 `]` 或换行（否则视为畸形标记，原样保留不提取）。
 * - 建议每个文件单独一行；同一行写多个标记也能被全部提取。
 * - 提取后标记会从文本中移除；只含标记的行整行删除，并把 3 个以上连续换行压成 2 个。
 * - 安全边界：deliver 侧只接受位于该任务 agent 工作区（agents/<agentId>/）内、
 *   真实存在的普通文件，见 validateAttachmentPaths。
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'

/** 单次任务推送最多携带的附件数，超出的忽略（deliver 侧 warn） */
export const MAX_TASK_ATTACHMENTS = 5

/** 标记正则源码：捕获组 1 = 原始路径（不含 `]` 与换行，两侧空白后续 trim） */
export const ATTACHMENT_MARKER_SOURCE = String.raw`\[\[attach:([^\]\r\n]+)\]\]`

/** 每次新建实例，避免共享 g 标志正则的 lastIndex 状态泄漏 */
export function createAttachmentMarkerRegex(): RegExp {
  return new RegExp(ATTACHMENT_MARKER_SOURCE, 'gi')
}

export interface ExtractedAttachments {
  /** 移除标记并清理多余空行后的文本；无标记时与入参完全一致 */
  cleanText: string
  /** 按出现顺序提取的路径（已 trim，未做存在性/安全校验） */
  paths: string[]
}

/** 从任务回复文本中提取全部 [[attach:...]] 标记 */
export function extractAttachments(text: string): ExtractedAttachments {
  const paths: string[] = []
  const kept: string[] = []

  for (const line of text.split(/\r?\n/)) {
    let extracted = false
    const stripped = line.replace(createAttachmentMarkerRegex(), (match, rawPath: string) => {
      const trimmedPath = rawPath.trim()
      // 路径为空白的畸形标记：不提取、原样保留
      if (!trimmedPath) return match
      extracted = true
      paths.push(trimmedPath)
      return ''
    })

    if (!extracted) {
      kept.push(line)
      continue
    }
    // 整行只有标记（及空白）→ 删除该行，避免留下空行
    if (stripped.trim() === '') continue
    kept.push(stripped.trimEnd())
  }

  // 无标记：原样返回，不做任何空行清理（保证幂等无副作用）
  if (paths.length === 0) {
    return { cleanText: text, paths }
  }

  const cleanText = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { cleanText, paths }
}

export interface RejectedAttachment {
  path: string
  reason: string
}

export interface AttachmentValidationResult {
  /** 通过校验的路径（保留 agent 书写的原始形式） */
  accepted: string[]
  rejected: RejectedAttachment[]
}

/**
 * 安全校验附件路径：必须是绝对路径、真实存在的普通文件、且位于 agent 工作区目录内。
 * 通过 realpath 归一化后做前缀比对，可防 `../` 逃逸与符号链接逃逸；
 * Windows 上大小写不敏感比较。
 */
export function validateAttachmentPaths(
  paths: string[],
  agentWorkspaceDir: string,
): AttachmentValidationResult {
  const accepted: string[] = []
  const rejected: RejectedAttachment[] = []

  let realWorkspaceRoot: string | null = null
  try {
    realWorkspaceRoot = realpathSync(agentWorkspaceDir)
  } catch {
    realWorkspaceRoot = null
  }

  for (const path of paths) {
    if (!isAbsolute(path)) {
      rejected.push({ path, reason: 'not an absolute path' })
      continue
    }
    if (!realWorkspaceRoot) {
      rejected.push({ path, reason: 'agent workspace directory not found' })
      continue
    }

    // realpath 同时解析 ../、符号链接与大小写差异；文件不存在时抛错
    let realPath: string
    try {
      realPath = realpathSync(path)
    } catch {
      rejected.push({ path, reason: 'file not found' })
      continue
    }

    let isFile = false
    try {
      isFile = statSync(realPath).isFile()
    } catch {
      isFile = false
    }
    if (!isFile) {
      rejected.push({ path, reason: 'not a regular file' })
      continue
    }

    if (!isInsideDir(realPath, realWorkspaceRoot)) {
      rejected.push({ path, reason: 'outside the agent workspace' })
      continue
    }

    accepted.push(path)
  }

  return { accepted, rejected }
}

/** 归一化后前缀比对（Windows 大小写不敏感）；入参须均为 realpath 结果 */
function isInsideDir(target: string, root: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (process.platform === 'win32') {
    return target.toLowerCase().startsWith(rootWithSep.toLowerCase())
  }
  return target.startsWith(rootWithSep)
}

/**
 * 桌面会话落库文本：cleanText + 每个附件一行 `📎 <路径>`。
 * 桌面端可读，且不暴露内部 [[attach:]] 标记语法。
 */
export function formatResultWithAttachmentLines(cleanText: string, paths: string[]): string {
  if (paths.length === 0) return cleanText
  const attachmentLines = paths.map((path) => `📎 ${path}`).join('\n')
  return cleanText ? `${cleanText}\n\n${attachmentLines}` : attachmentLines
}
