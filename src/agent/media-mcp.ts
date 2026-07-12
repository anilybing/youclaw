// [XJC] 媒体生成 MCP 工具（T-B7）：让 agent 在对话中生成图片、按指令修改图片、生成视频。
// 结构对齐 knowledge-mcp。产物落盘 agent 工作区「媒体产出」，返回文件路径；
// 渠道会话可用 send_to_current_chat 把产物直接发给用户（微信/飞书等）。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { assertEditableImagePath, getMediaService, type LocalMediaInputScope } from '../media/service.ts'
import {
  MEDIA_AUTHORIZATION_REQUIRED,
  MEDIA_CALL_LIMIT,
  MediaError,
} from '../media/types.ts'
import { getLogger } from '../logger/index.ts'
import type { MediaToolAuthorization } from './media-intent.ts'

const GenerateImageParams = Type.Object({
  prompt: Type.String({ description: 'Detailed description of the image to generate (Chinese or English). Include subject, style, composition, lighting.' }),
})

const EditImageParams = Type.Object({
  imagePath: Type.String({ description: 'Absolute local path of the source image (must be inside chat attachments or the workspace, e.g. a user-uploaded attachment or a previously generated image in 媒体产出).' }),
  prompt: Type.String({ description: 'Edit instruction describing what to change (e.g. 把背景换成雪山 / remove the text / make the sky brighter). The rest of the image is preserved.' }),
})

const GenerateVideoParams = Type.Object({
  prompt: Type.String({ description: 'Description of the video to generate.' }),
  imagePath: Type.Optional(Type.String({ description: 'Optional source image for image-to-video (same path rules as edit_image).' })),
})

type MediaToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, never>
}

function ok(text: string): MediaToolResult {
  return { content: [{ type: 'text', text }], details: {} }
}

function rethrow(err: unknown, fallback: string): never {
  if (err instanceof MediaError) throw new Error(`${err.code}: ${err.message}`)
  getLogger().error({ error: String(err), category: 'media' }, fallback)
  throw new Error(fallback)
}

export function createMediaTools(params: {
  agentId: string
  workspaceDir: string
  attachmentPaths?: string[]
  authorization: MediaToolAuthorization
  /** 视频轮询期间的取消信号（用户点停止时中断长时间轮询） */
  videoSignal?: AbortSignal
  /** 视频轮询进度回调（runtime 用它把「生成中」提示推给前端） */
  onVideoProgress?: (message: string) => void
}): ToolDefinition[] {
  const service = getMediaService()
  const agentId = params.agentId
  const inputScope: LocalMediaInputScope = {
    workspaceDir: params.workspaceDir,
    attachmentPaths: params.attachmentPaths,
  }
  let imageCalls = 0
  let videoCalls = 0

  const authorizeImageCall = (allowed: boolean, action: string) => {
    if (!allowed) {
      throw new MediaError(
        MEDIA_AUTHORIZATION_REQUIRED,
        `${action}未获得当前用户回合的明确授权，请先确认用户是在执行操作而非咨询能力`,
      )
    }
    if (imageCalls >= 1) {
      throw new MediaError(MEDIA_CALL_LIMIT, '当前用户回合最多执行一次生图或改图；继续生成请先向用户确认')
    }
    imageCalls += 1
  }

  const authorizeVideoCall = () => {
    if (!params.authorization.allowGenerateVideo) {
      throw new MediaError(
        MEDIA_AUTHORIZATION_REQUIRED,
        '视频生成需要用户对本次付费调用进行明确确认',
      )
    }
    if (videoCalls >= 1) {
      throw new MediaError(MEDIA_CALL_LIMIT, '当前用户回合最多执行一次视频生成')
    }
    videoCalls += 1
  }

  return [
    {
      name: 'mcp__media__generate_image',
      label: 'mcp__media__generate_image',
      description:
        'BUILT-IN text-to-image tool (not a skill). 用户明确要求“生成图片/生图/画一张/做海报”且画面信息足够时，直接调用本工具；不要搜索技能，也不要再次索要已在设置中保存的 API Key。 '
        + 'Generate an image from a text prompt using the user-configured image API. '
        + 'COST: each call bills the user\'s API account per image — do not call repeatedly without need; refine the prompt instead. '
        + 'Returns the saved file path (媒体产出 folder). Tell the user the path; in channel chats you may send the file via mcp__message__send_to_current_chat. '
        + 'If not configured, guide the user to 设置 → 语音与媒体.',
      parameters: GenerateImageParams,
      async execute(_id, args: { prompt: string }) {
        try {
          authorizeImageCall(params.authorization.allowGenerateImage, '图像生成')
          const result = await service.generateImage(args.prompt, agentId)
          return ok(JSON.stringify({ saved: result.filePath, note: '图片已生成并保存到「媒体产出」。' }, null, 2))
        } catch (err) {
          rethrow(err, '图像生成失败')
        }
      },
    },
    {
      name: 'mcp__media__edit_image',
      label: 'mcp__media__edit_image',
      description:
        'BUILT-IN image editing tool (not a skill). 用户要求修改已上传或刚生成的图片时直接调用。 '
        + 'Edit an existing local image with a natural-language instruction (instruction-based editing: change background, remove/replace objects, adjust style/text) while preserving the rest. '
        + 'Use when the user uploads an image and asks to modify it, or to iterate on a previously generated image (pass the last output path for multi-turn editing). '
        + 'COST: bills per image. Source image must be inside chat attachments or the workspace. Returns the new file path.',
      parameters: EditImageParams,
      async execute(_id, args: { imagePath: string; prompt: string }) {
        try {
          const safePath = assertEditableImagePath(args.imagePath, inputScope)
          authorizeImageCall(params.authorization.allowEditImage, '图片编辑')
          const result = await service.editImage(safePath, args.prompt, agentId)
          return ok(JSON.stringify({ saved: result.filePath, note: '改图完成，已保存到「媒体产出」。继续修改可把该路径再次传入本工具。' }, null, 2))
        } catch (err) {
          rethrow(err, '改图失败')
        }
      },
    },
    {
      name: 'mcp__media__generate_video',
      label: 'mcp__media__generate_video',
      description:
        'BUILT-IN video generation tool (not a skill). Generate a short video from a text prompt (optionally seeded with a source image for image-to-video). '
        + 'COST: video generation is EXPENSIVE and slow (minutes). POLICY: before calling, you MUST confirm with the user (prompt + that it will bill their API account). '
        + 'Blocks until the video is ready (up to 10 minutes) and returns the saved .mp4 path.',
      parameters: GenerateVideoParams,
      async execute(_id, args: { prompt: string; imagePath?: string }) {
        try {
          const safePath = args.imagePath ? assertEditableImagePath(args.imagePath, inputScope) : undefined
          authorizeVideoCall()
          let lastProgressAt = 0
          const result = await service.generateVideo(args.prompt, agentId, safePath, {
            signal: params.videoSignal,
            onProgress: ({ elapsedMs, status }) => {
              if (!params.onVideoProgress) return
              const now = Date.now()
              if (now - lastProgressAt < 15_000) return // 节流：最多每 15 秒提示一次
              lastProgressAt = now
              params.onVideoProgress(`🎬 视频生成中…（已 ${Math.round(elapsedMs / 1000)} 秒，状态 ${status}）\n`)
            },
          })
          return ok(JSON.stringify({ saved: result.filePath, note: '视频已生成并保存到「媒体产出」。' }, null, 2))
        } catch (err) {
          rethrow(err, '视频生成失败')
        }
      },
    },
  ]
}
