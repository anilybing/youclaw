// [XJC-PATCH] T-G6 本地文档摄取一期：轮询调度
//
// 与 T-G1 蒸馏不同，摄取扫描是纯代码任务（不经 agent runtime、不调 LLM），
// 不落 scheduled_tasks 表，用进程内 interval 即可；ingestEnabled 开关随
// 设置更新（routes/ingest.ts 保存后回调 ensureIngestTask）即时生效。

import { getLogger } from '../logger/index.ts'
import { getIngestSettings } from './settings.ts'
import { runFolderIngest, type FolderIngestDeps } from './folder-ingest.ts'

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
