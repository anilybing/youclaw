// [XJC] 媒体生成 MCP 工具（T-B7）：让 agent 在对话中生成图片、按指令修改图片、生成视频。
// 结构对齐 knowledge-mcp。产物落盘 agent 工作区「媒体产出」，返回文件路径；
// 渠道会话可用 send_to_current_chat 把产物直接发给用户（微信/飞书等）。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { assertEditableImagePath, getMediaService } from '../media/service.ts'
import { MediaError } from '../media/types.ts'
import { getLogger } from '../logger/index.ts'

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
  if (err instanceof MediaError) throw new Error(err.message)
  getLogger().error({ error: String(err), category: 'media' }, fallback)
  throw new Error(fallback)
}

export function createMediaTools(params: { agentId: string }): ToolDefinition[] {
  const service = getMediaService()
  const agentId = params.agentId

  return [
    {
      name: 'mcp__media__generate_image',
      label: 'mcp__media__generate_image',
      description:
        'Generate an image from a text prompt using the user-configured image API. '
        + 'COST: each call bills the user\'s API account per image — do not call repeatedly without need; refine the prompt instead. '
        + 'Returns the saved file path (媒体产出 folder). Tell the user the path; in channel chats you may send the file via mcp__message__send_to_current_chat. '
        + 'If not configured, guide the user to 设置 → 语音与媒体.',
      parameters: GenerateImageParams,
      async execute(_id, args: { prompt: string }) {
        try {
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
        'Edit an existing local image with a natural-language instruction (instruction-based editing: change background, remove/replace objects, adjust style/text) while preserving the rest. '
        + 'Use when the user uploads an image and asks to modify it, or to iterate on a previously generated image (pass the last output path for multi-turn editing). '
        + 'COST: bills per image. Source image must be inside chat attachments or the workspace. Returns the new file path.',
      parameters: EditImageParams,
      async execute(_id, args: { imagePath: string; prompt: string }) {
        try {
          const safePath = assertEditableImagePath(args.imagePath)
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
        'Generate a short video from a text prompt (optionally seeded with a source image for image-to-video). '
        + 'COST: video generation is EXPENSIVE and slow (minutes). POLICY: before calling, you MUST confirm with the user (prompt + that it will bill their API account). '
        + 'Blocks until the video is ready (up to 10 minutes) and returns the saved .mp4 path.',
      parameters: GenerateVideoParams,
      async execute(_id, args: { prompt: string; imagePath?: string }) {
        try {
          const safePath = args.imagePath ? assertEditableImagePath(args.imagePath) : undefined
          const result = await service.generateVideo(args.prompt, agentId, safePath)
          return ok(JSON.stringify({ saved: result.filePath, note: '视频已生成并保存到「媒体产出」。' }, null, 2))
        } catch (err) {
          rethrow(err, '视频生成失败')
        }
      },
    },
  ]
}
