// [XJC] 语音转写 MCP 工具（丰富性强化 · 录音→纪要真能力）
//
// 语音 ASR 基建（settings.voice.asr，OpenAI 兼容 /audio/transcriptions）此前只服务于
// 聊天输入框的麦克风按钮——agent 自己不能转写用户给的录音文件，"录音→会议纪要"断在第一步。
// 本工具补上：agent 可转写本地音频文件（会议录音、语音备忘），再接 meeting-notes 等技能成稿。
// 路径安全与 media 同款：双侧 realpath + 附件/工作区白名单 + 扩展名白名单 + 大小上限。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { getVoiceService } from '../voice/service.ts'
import { VoiceError } from '../voice/types.ts'
import { getLogger } from '../logger/index.ts'

/** 常见录音格式（OpenAI 兼容网关普遍支持；amr 等冷门格式请用户先转码） */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.webm', '.ogg', '.flac', '.aac', '.mp4', '.mpga', '.mpeg'])
/** 本地上限对齐主流网关（硅基流动 50MB / OpenAI 25MB，超限由 provider 报错前先拦截大头） */
const AUDIO_MAX_BYTES = 50 * 1024 * 1024
/** 长录音转写给足时间（网关侧一般 1h 音频内同步返回） */
const TRANSCRIBE_TIMEOUT_MS = 120_000

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.mp4': 'audio/mp4',
  '.mpga': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
}

/** 与 media/service.assertEditableImagePath 同款：双侧 realpath 防 symlink 逃逸 */
export function assertReadableAudioPath(rawPath: string): string {
  const ext = extname(rawPath).toLowerCase()
  if (!AUDIO_EXTENSIONS.has(ext)) {
    throw new Error(`仅支持音频文件（${[...AUDIO_EXTENSIONS].join('/')}），其它格式请先转码`)
  }
  let real: string
  try {
    real = realpathSync(resolve(rawPath))
  } catch {
    throw new Error('音频文件不存在或不可读')
  }
  const allowedRoots = [
    resolve(getPaths().data, 'attachments'),
    resolve(getPaths().workspace),
  ].map((root) => {
    try { return realpathSync(root) } catch { return root }
  })
  const normalized = process.platform === 'win32' ? real.toLowerCase() : real
  const allowed = allowedRoots.some((root) => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root
    return normalized === r || normalized.startsWith(`${r}\\`) || normalized.startsWith(`${r}/`)
  })
  if (!allowed) {
    throw new Error('音频文件必须位于聊天附件或工作区目录内（请让用户把录音作为附件发到对话里）')
  }
  return real
}

const TranscribeParams = Type.Object({
  audioPath: Type.String({ description: 'Absolute local path of the audio file to transcribe (must be inside chat attachments or the workspace — e.g. a user-uploaded recording from this message\'s attachment list).' }),
})

export function createVoiceTools(): ToolDefinition[] {
  return [
    {
      name: 'mcp__voice__transcribe_audio',
      label: 'mcp__voice__transcribe_audio',
      description:
        'Transcribe a local audio file (meeting recording, voice memo) to text using the user-configured speech-to-text service. '
        + 'Use when the user uploads a recording and asks for a transcript, meeting minutes, or a summary — transcribe first, then process the text (e.g. with the meeting-notes skill). '
        + 'Limits: common audio formats, ≤50MB (provider may enforce stricter limits, e.g. duration ≤1h). '
        + 'If speech recognition is not configured, guide the user to 设置 → 语音与媒体.',
      parameters: TranscribeParams,
      async execute(_id, args: { audioPath: string }) {
        const safePath = assertReadableAudioPath((args.audioPath ?? '').trim())
        const size = statSync(safePath).size
        if (size > AUDIO_MAX_BYTES) {
          throw new Error(`音频超过 ${AUDIO_MAX_BYTES / 1024 / 1024}MB 上限，请压缩或分段后再试`)
        }
        const ext = extname(safePath).toLowerCase()
        try {
          const audio = new Uint8Array(readFileSync(safePath))
          const result = await getVoiceService().transcribe(audio, MIME_BY_EXT[ext] ?? 'application/octet-stream', {
            filename: basename(safePath),
            timeoutMs: TRANSCRIBE_TIMEOUT_MS,
          })
          getLogger().info({ path: safePath, bytes: size, chars: result.text.length, category: 'voice' }, 'Audio transcribed via MCP tool')
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ transcript: result.text, note: '转写完成。请基于 transcript 继续用户的原始诉求（如整理会议纪要）。' }, null, 2) }],
            details: {},
          }
        } catch (err) {
          if (err instanceof VoiceError) throw new Error(err.message)
          throw new Error(`转写失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },
    },
  ]
}
