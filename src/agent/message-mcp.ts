import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { sendToChat } from '../channel/outbound-service.ts'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { validateAttachmentPaths } from '../scheduler/attachments.ts'

const SendToCurrentChatParams = Type.Object({
  text: Type.Optional(Type.String({ description: 'Optional text message or caption to send' })),
  media: Type.Optional(Type.String({ description: 'Optional absolute local path, file:// URL, or HTTP/HTTPS URL of the media/file to send' })),
})

/** 拒绝原因（validateAttachmentPaths 的英文 reason）→ 面向用户的中文说明。 */
const MEDIA_REJECT_REASON_ZH: Record<string, string> = {
  'not an absolute path': '不是绝对路径',
  'agent workspace directory not found': '数字员工工作区目录不存在',
  'file not found': '文件不存在',
  'not a regular file': '不是普通文件',
  'outside the agent workspace': '不在数字员工工作区内',
}

/**
 * 本地媒体（绝对路径 / file:// URL）出站前的工作区边界校验。
 *
 * 安全动机：`send_to_current_chat` 的 media 参数由 agent 可控，远程陌生人可通过 IM 渠道对
 * bot 做 prompt 注入，诱导 agent 把用户密钥/私钥等任意本地文件外泄到攻击者所在会话。
 * 因此本地媒体一律限制在「该 agent 的工作区目录（agents/<agentId>/）」内，复用定时任务附件
 * 同款 realpath + 前缀比对（可防 `../` 与符号链接逃逸）。remote http(s) 不走此约束（由
 * media-fetch 的 SSRF 层负责）。
 */
function assertLocalMediaInWorkspace(media: string, agentId: string): void {
  // remote http(s) 由 SSRF 层负责，不受工作区约束
  if (/^https?:\/\//i.test(media)) return
  // 其它协议（ftp:// 等）交由 normalizeOutboundMedia 统一报「不支持的协议」，此处不拦
  if (!/^file:\/\//i.test(media) && media.includes('://')) return

  let localPath: string
  if (/^file:\/\//i.test(media)) {
    try {
      localPath = fileURLToPath(media)
    } catch {
      throw new Error(`无效的 file:// URL：${media}`)
    }
  } else {
    localPath = media
  }

  const workspaceDir = resolve(getPaths().agents, agentId)
  const { accepted, rejected } = validateAttachmentPaths([localPath], workspaceDir)
  if (accepted.length === 0) {
    const reason = rejected[0]?.reason ?? 'outside the agent workspace'
    const reasonZh = MEDIA_REJECT_REASON_ZH[reason] ?? reason
    throw new Error(`媒体文件必须位于数字员工工作区内，已拒绝发送：${localPath}（原因：${reasonZh}）`)
  }
}

export function createMessageTool(chatId: string, agentId: string): ToolDefinition {
  return {
    name: 'mcp__message__send_to_current_chat',
    label: 'mcp__message__send_to_current_chat',
    description: `Send a message back to the current conversation.

Use this tool when the user explicitly asks you to send text, images, or files back through the current chat channel.`,
    parameters: SendToCurrentChatParams,
    async execute(_toolCallId, args: { text?: string; media?: string }) {
      const text = args.text?.trim() ?? ''
      const media = args.media?.trim()

      if (!text && !media) {
        throw new Error('send_to_current_chat requires either text or media.')
      }

      try {
        if (media) {
          assertLocalMediaInWorkspace(media, agentId)
        }
        const result = await sendToChat({
          chatId,
          text,
          mediaUrl: media,
        })
        return {
          content: [{
            type: 'text',
            text: result.mode === 'media'
              ? 'Message and media were sent to the current chat.'
              : 'Message was sent to the current chat.',
          }],
          details: { mode: result.mode, media },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        getLogger().error({ chatId, agentId, error: msg, media }, 'send_to_current_chat failed')
        throw new Error(`Failed to send to current chat: ${msg}`)
      }
    },
  }
}
