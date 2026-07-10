const FORBIDDEN_KEY = /(?:prompt|response|content|arguments?|tool_?args?|file_?path|url|secret|token|api_?key|credential|authorization)/i
const SAFE_TOKEN_METRIC_KEY = /^(?:inputTokens|outputTokens|cacheReadTokens|cacheWriteTokens|totalTokens)$/i
const URL_PATTERN = /\b(?:https?|file):\/\/[^\s"'<>]+/gi
const WINDOWS_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/g
const UNIX_PATH_PATTERN = /(^|[\s("'=])\/(?:Users|home|tmp|var|etc|opt|mnt|data)\/[^\s"'<>]+/g
const SECRET_PATTERN = /\b(?:bearer\s+|sk-|xox[baprs]-|gh[pousr]_)[A-Za-z0-9._~+\/=-]{8,}/gi

function redactString(value: string): string {
  return value
    .replace(URL_PATTERN, '[REDACTED_URL]')
    .replace(WINDOWS_PATH_PATTERN, '[REDACTED_PATH]')
    .replace(UNIX_PATH_PATTERN, (_match, prefix: string) => `${prefix}[REDACTED_PATH]`)
    .replace(SECRET_PATTERN, '[REDACTED_SECRET]')
}

/**
 * Defense-in-depth export sanitizer. The durable schema intentionally contains
 * metadata only; this also removes forbidden fields should a future caller pass
 * richer objects by mistake.
 */
export function redactAgentOpsValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactAgentOpsValue)
  if (!value || typeof value !== 'object') return value

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key) && !SAFE_TOKEN_METRIC_KEY.test(key)) {
      output[key] = '[REDACTED]'
      continue
    }
    output[key] = redactAgentOpsValue(nested)
  }
  return output
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortForStableJson(nested)]),
  )
}

export function stableRedactedJson(value: unknown, pretty = true): string {
  const safe = sortForStableJson(redactAgentOpsValue(value))
  return JSON.stringify(safe, null, pretty ? 2 : 0)
}

export function sanitizeAgentOpsLabel(value: string | undefined | null, fallback = 'unknown'): string {
  const raw = (value ?? '').trim()
  if (
    /(?:https?|file):\/\//i.test(raw)
    || /(?:[A-Za-z]:\\|\\\\)/.test(raw)
    || /(?:^|[\s("'=])\/(?:Users|home|tmp|var|etc|opt|mnt|data)\//i.test(raw)
    || /\b(?:bearer\s+|sk-|xox[baprs]-|gh[pousr]_)[A-Za-z0-9._~+\/=-]{8,}/i.test(raw)
  ) {
    return fallback
  }
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return clean || fallback
}
