// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { isTauri } from '@/api/transport'

export type UpdateChannel = 'portable' | 'installer' | 'disabled'

export interface UpdateCheckResult {
  available: boolean
  version: string
  notes: string
  channel: UpdateChannel
  /** MVP 便携清单的 forceUpdate；安装版通道透传 latest.json 的同名字段（拿不到时 false）。 */
  forceUpdate: boolean
}

const NONE: UpdateCheckResult = { available: false, version: '', notes: '', channel: 'installer', forceUpdate: false }

/**
 * 读取 Rust 侧的更新通道：
 *   - 'portable'：便携版，走双 exe 就地替换
 *   - 'installer'：安装版，走 Tauri updater
 *   - 'disabled'：离线版，编译期烧死禁用自动更新
 * 取不到时按安装版处理（与旧行为一致）。
 */
export async function getUpdateChannel(): Promise<UpdateChannel> {
  if (!isTauri) return 'installer'
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const c = await invoke<string>('get_update_channel')
    return c === 'portable' || c === 'disabled' ? c : 'installer'
  } catch {
    return 'installer'
  }
}

/**
 * 统一的「只检测不下载」更新查询，供启动自动检测与 About 页复用：
 *   - 便携版：Rust portable_update_check（内部逐文件 sha256 比对 + 防降级）
 *   - 安装版：Tauri updater check()（不触发下载）
 *   - 离线版（'disabled'）：直接按「无更新」返回，不发起任何检查
 * 任何异常一律按「无更新」降级，绝不打断用户。
 */
export async function detectUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri) return NONE
  try {
    const channel = await getUpdateChannel()
    if (channel === 'disabled') return NONE

    if (channel === 'portable') {
      const { invoke } = await import('@tauri-apps/api/core')
      const info = await invoke<{ available: boolean; version: string; notes: string; force_update: boolean }>(
        'portable_update_check'
      )
      return {
        available: !!(info && info.available),
        version: (info && info.version) || '',
        notes: (info && info.notes) || '',
        channel,
        forceUpdate: !!(info && info.available && info.force_update),
      }
    }

    const { check } = await import('@tauri-apps/plugin-updater')
    const upd = await check()
    // Tauri updater 会忽略 latest.json 的未知字段，但 rawJson 里能读到 force_update。
    let forceUpdate = false
    if (upd) {
      const raw = (upd as unknown as { rawJson?: Record<string, unknown> }).rawJson
      forceUpdate = !!(raw && raw['force_update'] === true)
    }
    return {
      available: !!upd,
      version: upd?.version ?? '',
      notes: upd?.body ?? '',
      channel,
      forceUpdate,
    }
  } catch {
    return NONE
  }
}
