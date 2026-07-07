// [XJC-PATCH] T-G6 本地文档摄取一期：轮询调度（G6.2 渠道消息日摘要同驻本文件）
//
// 与 T-G1 蒸馏不同，摄取扫描是纯代码任务（不经 agent runtime、不调 LLM），
// 不落 scheduled_tasks 表，用进程内 interval 即可；ingestEnabled 开关随
// 设置更新（routes/ingest.ts 保存后回调 ensureIngestTask）即时生效。

import { getLogger } from '../logger/index.ts'
import { getIngestSettings } from './settings.ts'
import { runFolderIngest, type FolderIngestDeps } from './folder-ingest.ts'
import { runChannelDigest } from './channel-ingest.ts'

/** 扫描周期：15 分钟（轮询 mtime 而非 fs.watch，U 盘/网络盘更可靠） */
export const INGEST_INTERVAL_MS = 15 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let running = false
/** 最近一次注入的依赖（index.ts 启动时传入；路由触发的 re-ensure 复用） */
let lastDeps: FolderIngestDeps = {}

async function tick(): Promise<void> {
  if (running) return // 上一轮未结束（如大量 PDF 解析中）则跳过本轮
  running = true
  try {
    await runFolderIngest(lastDeps)
  } catch (err) {
    getLogger().warn(
      { error: err instanceof Error ? err.message : String(err), category: 'folder-ingest' },
      'Folder ingest tick failed',
    )
  } finally {
    running = false
  }
}

export interface EnsureIngestTaskResult {
  enabled: boolean
  active: boolean
}

/**
 * 按设置开关拉起/停掉摄取轮询。幂等：重复调用不产生重复 interval。
 * @param deps index.ts 启动时注入 hasAgent；设置保存后的 re-ensure 不传（复用上次的）
 * @param options.immediate 开启时是否立即先扫一轮（默认 true；测试可关）
 */
export function ensureIngestTask(deps?: FolderIngestDeps, options?: { immediate?: boolean }): EnsureIngestTaskResult {
  if (deps) lastDeps = deps
  const enabled = getIngestSettings().ingestEnabled

  if (enabled && !timer) {
    timer = setInterval(() => { void tick() }, INGEST_INTERVAL_MS)
    if (options?.immediate !== false) void tick()
    getLogger().info({ intervalMs: INGEST_INTERVAL_MS, category: 'folder-ingest' }, 'Folder ingest polling started')
  } else if (!enabled && timer) {
    clearInterval(timer)
    timer = null
    getLogger().info({ category: 'folder-ingest' }, 'Folder ingest polling stopped')
  }

  return { enabled, active: timer !== null }
}

/** 停掉轮询（测试清理用） */
export function stopIngestTask(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// ===== [G6.2] 渠道消息日摘要：每日 23:40 本地时刻触发一次 =====
//
// 设计取舍：
// - 固定 23:40 赶在 G1 日蒸馏（23:50）之前，让蒸馏当轮就能消化渠道段；
// - 自重臂 setTimeout 而非 interval——跨日界后重新计算下一个 23:40，
//   睡眠唤醒导致的漂移由「fire 时再算下一次」自愈；
// - 应用在 23:40 前退出则当日渠道段缺失，可接受：G1 蒸馏仍会读
//   memory/logs/ 的截断版对话，信息不丢，只是少了聚合段；
// - 开关 channelDigestEnabled 在 fire 时读取：关着就跳过本轮但保持重臂，
//   用户重新打开无需重启。

export const CHANNEL_DIGEST_HOUR = 23
export const CHANNEL_DIGEST_MINUTE = 40

let digestTimer: ReturnType<typeof setTimeout> | null = null

/** 距下一个本地 23:40 的毫秒数（已过今日窗口则取明日） */
export function msUntilNextDigest(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), CHANNEL_DIGEST_HOUR, CHANNEL_DIGEST_MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function armDigestTimer(): void {
  digestTimer = setTimeout(() => {
    try {
      runChannelDigest(lastDeps)
    } catch (err) {
      getLogger().warn(
        { error: err instanceof Error ? err.message : String(err), category: 'channel-digest' },
        'Channel digest run failed',
      )
    } finally {
      armDigestTimer() // 无论成败都重臂到下一个 23:40
    }
  }, msUntilNextDigest())
}

/** 拉起渠道摘要定时器。幂等：已有定时器则不重复。 */
export function ensureChannelDigestTask(deps?: FolderIngestDeps): { active: boolean } {
  if (deps) lastDeps = deps
  if (!digestTimer) {
    armDigestTimer()
    getLogger().info(
      { hour: CHANNEL_DIGEST_HOUR, minute: CHANNEL_DIGEST_MINUTE, category: 'channel-digest' },
      'Channel digest daily timer armed',
    )
  }
  return { active: digestTimer !== null }
}

/** 停掉渠道摘要定时器（测试清理用） */
export function stopChannelDigestTask(): void {
  if (digestTimer) {
    clearTimeout(digestTimer)
    digestTimer = null
  }
}
