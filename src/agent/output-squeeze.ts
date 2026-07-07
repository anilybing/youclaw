/**
 * output-squeeze.ts — 工具输出压缩层（T-G2）
 *
 * runtime 工具结果进入模型上下文前的确定性压缩管道：
 * 超阈值输出按内容形态截断（JSON → 结构骨架；代码/日志 → 头尾行；长文本 → 头尾字符），
 * 原文落盘 <数据目录>/tool-cache/ 供模型按需回读。
 *
 * 白名单跳过：内置技能 CLI 单行 JSON 契约（{"ok":true / {"ok":false 开头）、
 * 长度未超阈值、工具名在 opts.skipTools 中。
 *
 * 开关：远程配置 'ai.output_squeeze'（默认 true，每次工具执行时重读，改配置即时生效）。
 */
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'

/** 默认触发阈值：8000 字符 ≈ 2k token */
export const DEFAULT_THRESHOLD_CHARS = 8000

// 行模式（代码/日志）参数：行数达到下限时保留头尾行
const LINE_MODE_MIN_LINES = 120
const HEAD_LINES = 80
const TAIL_LINES = 30
// 字符模式（普通长文本）参数
const HEAD_CHARS = 3000
const TAIL_CHARS = 1000
// JSON 结构骨架参数
const JSON_SAMPLE_ITEMS = 3
const JSON_SAMPLE_CHARS = 160
const JSON_MAX_KEYS = 30
// tool-cache 防膨胀：文件数超上限时删除最旧的一批
const CACHE_MAX_FILES = 200
const CACHE_PRUNE_COUNT = 50

export interface SqueezeOptions {
  /** 触发压缩的字符数阈值（默认 DEFAULT_THRESHOLD_CHARS） */
  thresholdChars?: number
  /** 跳过压缩的工具名列表（大小写不敏感） */
  skipTools?: string[]
}

export interface SqueezeResult {
  /** 压缩后的文本（末尾含原文落盘路径提示） */
  text: string
  originalChars: number
  squeezedChars: number
  /** 原文完整内容的落盘绝对路径 */
  cachedPath: string
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * 是否需要压缩：长度超阈值，且不命中白名单
 * （技能 CLI 单行 JSON 契约 / opts.skipTools）。
 */
export function shouldSqueeze(toolName: string, text: string, opts: SqueezeOptions = {}): boolean {
  const threshold = opts.thresholdChars ?? DEFAULT_THRESHOLD_CHARS
  if (typeof text !== 'string' || text.length <= threshold) return false

  // 内置技能 CLI 契约：单行 JSON 以 {"ok":true / {"ok":false 开头，结构化结果不可截断
  const head = text.trimStart()
  if (head.startsWith('{"ok":true') || head.startsWith('{"ok":false')) return false

  if (opts.skipTools?.some((name) => normalizeName(name) === normalizeName(toolName))) return false
  return true
}

function truncateLine(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length} 项)`
  switch (typeof value) {
    case 'string':
      return `string(${value.length} 字符)`
    case 'object':
      return `object(${Object.keys(value as object).length} 键)`
    default:
      return truncateLine(String(value), 40)
  }
}

/** JSON 结构骨架：顶层 key + 数组长度 + 前 N 项示例；非对象/数组返回空串走文本截断 */
function buildJsonSkeleton(parsed: unknown): string {
  const lines: string[] = []

  if (Array.isArray(parsed)) {
    lines.push(`[JSON 结构骨架] 顶层为数组，共 ${parsed.length} 项`)
    for (let i = 0; i < Math.min(JSON_SAMPLE_ITEMS, parsed.length); i += 1) {
      lines.push(`  示例[${i}]: ${truncateLine(JSON.stringify(parsed[i]) ?? 'undefined', JSON_SAMPLE_CHARS)}`)
    }
    return lines.join('\n')
  }

  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>)
    lines.push(`[JSON 结构骨架] 顶层为对象，共 ${entries.length} 个键`)
    for (const [key, value] of entries.slice(0, JSON_MAX_KEYS)) {
      let desc = describeValue(value)
      if (Array.isArray(value) && value.length > 0) {
        desc += `，首项示例: ${truncateLine(JSON.stringify(value[0]) ?? 'undefined', JSON_SAMPLE_CHARS)}`
      } else if (typeof value === 'string' && value.length > 40) {
        desc += ` ${truncateLine(JSON.stringify(value), 48)}`
      }
      lines.push(`  ${key}: ${desc}`)
    }
    if (entries.length > JSON_MAX_KEYS) {
      lines.push(`  …其余 ${entries.length - JSON_MAX_KEYS} 个键省略…`)
    }
    return lines.join('\n')
  }

  // 标量 JSON（长字符串/数字）没有结构可提炼，交给文本截断分支
  return ''
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function sanitizeToolName(toolName: string): string {
  const safe = toolName.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
  return safe || 'tool'
}

function formatStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 目录文件数超过上限时删除最旧的一批（按 mtime，尽力而为） */
function pruneCacheDir(dir: string): void {
  try {
    const names = readdirSync(dir)
    if (names.length <= CACHE_MAX_FILES) return
    const entries: Array<{ path: string; mtime: number }> = []
    for (const name of names) {
      const fullPath = resolve(dir, name)
      try {
        entries.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs })
      } catch {
        // 文件可能已被并发删除，跳过
      }
    }
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const entry of entries.slice(0, CACHE_PRUNE_COUNT)) {
      try {
        unlinkSync(entry.path)
      } catch {
        // 删除失败不阻断写入
      }
    }
  } catch {
    // 目录读取失败不阻断写入
  }
}

/** 原文写入 <数据目录>/tool-cache/<yyyyMMdd-HHmmss>-<tool>-<rand4>.txt，返回绝对路径 */
function writeOriginalToCache(toolName: string, text: string): string {
  const dir = resolve(getPaths().data, 'tool-cache')
  mkdirSync(dir, { recursive: true })
  pruneCacheDir(dir)
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  const filePath = resolve(dir, `${formatStamp(new Date())}-${sanitizeToolName(toolName)}-${rand}.txt`)
  writeFileSync(filePath, text, 'utf8')
  return filePath
}

function buildCacheNote(cachedPath: string): string {
  return `[输出过长已压缩，完整内容存于 ${cachedPath}，需要完整内容时用读取文件工具查看]`
}

/**
 * 压缩超长文本：按内容形态选择策略，原文落盘并在结果末尾追加回读提示。
 * 注意：本函数不做 shouldSqueeze 门控，调用方自行判断。
 */
export function squeezeText(toolName: string, text: string, opts: SqueezeOptions = {}): SqueezeResult {
  const threshold = opts.thresholdChars ?? DEFAULT_THRESHOLD_CHARS
  // 自定义小阈值时按比例收缩头尾窗口，保证压缩结果不明显超出阈值
  const headChars = Math.min(HEAD_CHARS, Math.max(200, Math.floor(threshold * 0.6)))
  const tailChars = Math.min(TAIL_CHARS, Math.max(100, Math.floor(threshold * 0.2)))

  const cachedPath = writeOriginalToCache(toolName, text)

  let body = ''
  const parsed = tryParseJson(text)
  if (parsed !== undefined) {
    body = buildJsonSkeleton(parsed)
  }

  if (!body) {
    const lines = text.split('\n')
    if (lines.length >= LINE_MODE_MIN_LINES) {
      // 代码/日志形态：保留头尾行
      body = [
        ...lines.slice(0, HEAD_LINES),
        `…中间省略 ${lines.length - HEAD_LINES - TAIL_LINES} 行…`,
        ...lines.slice(-TAIL_LINES),
      ].join('\n')
    } else {
      // [G3-HOOK] 自然语言长文本后续可走 hint:fast 模型语义摘要（消费模型路由配置）；
      // 本期纯确定性截断：零成本、零依赖、可单测。
      body = `${text.slice(0, headChars)}\n…中间省略 ${text.length - headChars - tailChars} 字符…\n${text.slice(text.length - tailChars)}`
    }
  }

  // 兜底：超长行/超大骨架仍可能超阈值，做字符级二次截断保证进上下文体积上限
  if (body.length > threshold) {
    body = `${body.slice(0, headChars)}\n…中间再省略 ${body.length - headChars - tailChars} 字符…\n${body.slice(body.length - tailChars)}`
  }

  const finalText = `${body}\n${buildCacheNote(cachedPath)}`
  return {
    text: finalText,
    originalChars: text.length,
    squeezedChars: finalText.length,
    cachedPath,
  }
}

/**
 * 读取远程配置缓存中的 'ai.output_squeeze' 开关。
 * 默认 true；文件缺失/解析失败/键非布尔值一律按 true（保守开启）。
 */
function readSqueezeFlag(): boolean {
  try {
    const cachePath = resolve(getPaths().data, 'remote-config-cache.json')
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      configs?: Record<string, unknown>
    }
    const value = parsed?.configs?.['ai.output_squeeze']
    if (typeof value === 'boolean') return value
    return true
  } catch {
    return true
  }
}

function safeLog(level: 'info' | 'warn', fields: Record<string, unknown>, message: string): void {
  try {
    getLogger()[level](fields, message)
  } catch {
    // logger 未初始化（纯函数单测场景）时静默
  }
}

/** 对工具结果的 content 文本项应用压缩；压缩自身出错时回退原结果，不影响工具语义 */
function applySqueezeToResult(
  toolName: string,
  result: AgentToolResult<unknown>,
  opts: SqueezeOptions,
): AgentToolResult<unknown> {
  try {
    // 外部 MCP 工具实现是运行时 JS，防御非规范返回结构
    if (!result || !Array.isArray(result.content)) return result

    let squeezedAny = false
    const content = result.content.map((item) => {
      if (!item || item.type !== 'text' || typeof item.text !== 'string') return item
      if (!shouldSqueeze(toolName, item.text, opts)) return item
      const squeezed = squeezeText(toolName, item.text, opts)
      squeezedAny = true
      safeLog('info', {
        tool: toolName,
        originalChars: squeezed.originalChars,
        squeezedChars: squeezed.squeezedChars,
        cachedPath: squeezed.cachedPath,
      }, 'Tool output squeezed')
      return { ...item, text: squeezed.text }
    })

    return squeezedAny ? { ...result, content } : result
  } catch (error) {
    safeLog('warn', {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    }, 'Output squeeze failed, returning original result')
    return result
  }
}

/**
 * 包装工具列表：execute 结果超阈值时压缩后再返回。
 * - 保持数组顺序与工具的 name/label/渲染函数等属性不变
 * - 工具自身抛出的异常原样透传
 * - 每次执行时重读 'ai.output_squeeze' 开关，配置改变即时生效
 */
export function wrapToolsWithSqueeze(tools: ToolDefinition[], opts: SqueezeOptions = {}): ToolDefinition[] {
  return tools.map((tool) => wrapSingleTool(tool, opts))
}

function wrapSingleTool(tool: ToolDefinition, opts: SqueezeOptions): ToolDefinition {
  const originalExecute = tool.execute.bind(tool)
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx)
      if (!readSqueezeFlag()) return result
      return applySqueezeToResult(tool.name, result, opts)
    },
  }
}
