import { resolve } from 'node:path'
import { readdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import { getPaths } from '../config/index.ts'

const LOG_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.log$/
const DAY_MS = 24 * 60 * 60 * 1000

export interface PinoLogEntry {
  level: number
  time: number
  msg: string
  category?: string  // 'agent' | 'tool_use' | 'task' | undefined (system logs)
  agentId?: string
  chatId?: string
  tool?: string
  durationMs?: number
  [key: string]: unknown
}

const LEVEL_MAP: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
}

export interface ReadLogOptions {
  level?: string
  category?: string    // 'agent' | 'tool_use' | 'system'
  search?: string
  offset?: number
  limit?: number
  order?: 'asc' | 'desc'
}

export interface LogReader {
  getLogDates(): string[]
  readLogEntries(date: string, options: ReadLogOptions): Promise<{
    entries: PinoLogEntry[]
    total: number
    hasMore: boolean
  }>
  cleanOldLogs(retainDays: number): number
}

function listLogDates(logsDir: string): string[] {
  try {
    return readdirSync(logsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
      .map(entry => entry.name.match(LOG_FILE_PATTERN)![1]!)
      .sort((a, b) => b.localeCompare(a))
  } catch {
    return []
  }
}

async function readEntries(logsDir: string, date: string, options: ReadLogOptions): Promise<{
  entries: PinoLogEntry[]
  total: number
  hasMore: boolean
}> {
  const filePath = resolve(logsDir, `${date}.log`)
  if (!existsSync(filePath)) return { entries: [], total: 0, hasMore: false }

  const text = readFileSync(filePath, 'utf-8')
  const lines = text.split('\n').filter(Boolean)

  const minLevel = options.level ? (LEVEL_MAP[options.level] ?? 0) : 0
  const search = options.search?.toLowerCase()
  const offset = options.offset ?? 0
  const limit = options.limit ?? 100
  const order = options.order ?? 'asc'

  const filtered: PinoLogEntry[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as PinoLogEntry
      if (entry.level < minLevel) continue
      // Category filter: 'system' matches entries without a category
      if (options.category) {
        if (options.category === 'system' && entry.category) continue
        if (options.category !== 'system' && entry.category !== options.category) continue
      }
      if (search && !JSON.stringify(entry).toLowerCase().includes(search)) continue
      filtered.push(entry)
    } catch { /* skip non-JSON lines */ }
  }

  // Reverse for desc order so offset=0 returns the newest entries
  if (order === 'desc') filtered.reverse()

  const total = filtered.length
  const entries = filtered.slice(offset, offset + limit)
  return { entries, total, hasMore: offset + limit < total }
}

function removeOldLogs(logsDir: string, retainDays: number, now: Date): number {
  if (!Number.isFinite(retainDays) || retainDays < 0) return 0

  // Log filenames are UTC dates. Use UTC milliseconds as well so retention does
  // not move by a day around local midnight or daylight-saving transitions.
  const cutoffStr = new Date(now.getTime() - Math.trunc(retainDays) * DAY_MS)
    .toISOString()
    .slice(0, 10)

  let deleted = 0
  for (const date of listLogDates(logsDir)) {
    if (date < cutoffStr) {
      try {
        unlinkSync(resolve(logsDir, `${date}.log`))
        deleted++
      } catch {
        // Best effort: a transient lock must not abort the scheduler tick.
      }
    }
  }
  return deleted
}

/**
 * Create an isolated reader for a specific directory.
 * Production callers use the wrappers below; tests can avoid touching the live
 * logger directory (and its model-invocations subdirectory/open handles).
 */
export function createLogReader(logsDir: string, now: () => Date = () => new Date()): LogReader {
  return {
    getLogDates: () => listLogDates(logsDir),
    readLogEntries: (date, options) => readEntries(logsDir, date, options),
    cleanOldLogs: (retainDays) => removeOldLogs(logsDir, retainDays, now()),
  }
}

/** Get all log dates in descending order */
export function getLogDates(): string[] {
  return listLogDates(getPaths().logs)
}

/** Read log entries for a given date, with level/category/keyword filtering and pagination */
export async function readLogEntries(
  date: string,
  options: ReadLogOptions,
): Promise<{ entries: PinoLogEntry[]; total: number; hasMore: boolean }> {
  return readEntries(getPaths().logs, date, options)
}

/** Delete log files older than retainDays */
export function cleanOldLogs(retainDays: number): number {
  return removeOldLogs(getPaths().logs, retainDays, new Date())
}
