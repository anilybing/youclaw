// [XJC] 本地 OCR MCP 工具（本地智能 C 轮：发票/截图/扫描件离线文字识别）
//
// 引擎：RapidOCR（纯本地 onnxruntime，中文识别强，图片不出本机）——依赖由
// setup-local-intelligence 脚本安装进 pytools 目录（便携 tools 或数据目录），
// 未安装时本工具不挂载（与 isVlmAvailable 同款按需注册）。
// 路径安全与 voice/media 同款：realpath + 附件/工作区白名单 + 扩展名白名单 + 大小上限。

import { Type } from '@mariozechner/pi-ai'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { realpathSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'
import { detectPytoolsCapabilities, runLocalOcr } from '../pytools/runtime.ts'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** 低于该置信度的识别行标注【低置信】，提醒模型/用户核对 */
const LOW_CONFIDENCE = 0.65

/** 与 voice-mcp assertReadableAudioPath 同款：双侧 realpath 防 symlink 逃逸 */
export function assertReadableImagePath(rawPath: string): string {
  const ext = extname(rawPath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`仅支持图片文件（${[...IMAGE_EXTENSIONS].join('/')}）`)
  }
  let real: string
  try {
    real = realpathSync(resolve(rawPath))
  } catch {
    throw new Error('图片文件不存在或不可读')
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
    throw new Error('图片必须位于聊天附件或工作区目录内（请让用户把图片作为附件发到对话里）')
  }
  return real
}

const OcrParams = Type.Object({
  imagePath: Type.String({ description: 'Absolute local path of the image to OCR (must be inside chat attachments or the workspace — e.g. a user-uploaded invoice/screenshot from this message\'s attachment list).' }),
})

/** OCR 结果格式化：文本行 + 低置信标注（供模型引用与用户核对） */
export function formatOcrLines(lines: Array<{ text: string; score: number }>): string {
  return lines
    .map((line) => (line.score < LOW_CONFIDENCE ? `${line.text}【低置信 ${Math.round(line.score * 100)}%】` : line.text))
    .join('\n')
}

/**
 * 本地 OCR 工具（能力探测通过才注册）。
 * 图片全程不出本机——与 mcp__minimax__understand_image（云端视觉理解）互补：
 * 提取文字用 OCR（免费、离线、逐字准确），理解画面内容用视觉模型。
 */
export function createOcrTools(): ToolDefinition[] {
  const caps = detectPytoolsCapabilities()
  if (!caps.ocr) return []

  return [
    {
      name: 'mcp__ocr__extract_text',
      label: 'mcp__ocr__extract_text',
      description:
        'Extract text from a local image (invoice, receipt, screenshot, scanned document) using the built-in fully-local OCR engine — the image never leaves this machine. '
        + 'Use when the user needs the TEXT content of an image: invoice/receipt fields, screenshot text, scanned pages. '
        + 'Prefer this over vision models for text extraction: it is free, offline, and character-accurate for Chinese/English. '
        + 'Limits: png/jpg/jpeg/webp/bmp, ≤20MB. Lines below 65% confidence are marked 【低置信】 — verify those with the user before relying on them.',
      parameters: OcrParams,
      async execute(_id, args: { imagePath: string }) {
        const safePath = assertReadableImagePath((args.imagePath ?? '').trim())
        const size = statSync(safePath).size
        if (size > IMAGE_MAX_BYTES) {
          throw new Error(`图片超过 ${IMAGE_MAX_BYTES / 1024 / 1024}MB 上限，请压缩后再试`)
        }
        const result = await runLocalOcr(safePath)
        if (!result.ok) {
          if (result.error === 'OCR_NOT_INSTALLED') {
            throw new Error('本地 OCR 组件未安装（需运行 setup-local-intelligence 安装脚本）')
          }
          throw new Error(`OCR 识别失败：${result.error ?? '未知错误'}`)
        }
        const lines = result.lines ?? []
        getLogger().info({ path: safePath, lines: lines.length, elapsedMs: result.elapsed_ms, category: 'pytools' }, 'Local OCR completed')
        if (lines.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ text: '', note: '未识别到文字（图片可能不含文本或分辨率过低）。' }, null, 2) }],
            details: {},
          }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              text: formatOcrLines(lines),
              lineCount: lines.length,
              note: '识别完成（全程本机离线）。【低置信】标注的行请与用户核对后再使用。',
            }, null, 2),
          }],
          details: {},
        }
      },
    },
  ]
}
