// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { isTauri } from '@/api/transport'
import { getSettings } from '@/api/client'

export type UpdateChannel = 'portable' | 'installer' | 'disabled'
export type UpdateReleaseChannel = 'stable' | 'beta'

export interface UpdateCohort {
  name: string
  bucket: number
  identity: string
  source: string
  partial: boolean
}

export interface UpdateCheckResult {
  available: boolean
  version: string
  notes: string
  channel: UpdateChannel
  forceUpdate: boolean
  releaseId: string
  releaseChannel: UpdateReleaseChannel
  cohort: UpdateCohort
  signatureVerification: string
}

export interface UpdateProgress {
  phase: 'downloading' | 'downloaded' | 'applying'
  percent: number
  downloaded: number
  total: number
}

export interface UpdateStartupStatus {
  previousFailure: boolean
  relaunchSuccess: boolean
  version: string
  updateType: string
}

export interface UpdateRuntimeDiagnostics {
  version: string
  releaseChannel: UpdateReleaseChannel
  updateType: UpdateChannel
  commit: string
  provenanceStatus: string
  provenanceVariant: string
  provenanceDirty: boolean | null
  signatureVerification: string
  signatureKeyId: string
  signatureVersion: string
}

const EMPTY_COHORT: UpdateCohort = {
  name: '',
  bucket: 0,
  identity: '',
  source: '',
  partial: false,
}

function noUpdate(
  channel: UpdateChannel = 'installer',
  releaseChannel: UpdateReleaseChannel = 'stable',
): UpdateCheckResult {
  return {
    available: false,
    version: '',
    notes: '',
    channel,
    forceUpdate: false,
    releaseId: '',
    releaseChannel,
    cohort: EMPTY_COHORT,
    signatureVerification: 'not-checked',
  }
}

export async function getUpdateReleaseChannel(): Promise<UpdateReleaseChannel> {
  try {
    const settings = await getSettings()
    return settings.update?.channel === 'beta' ? 'beta' : 'stable'
  } catch {
    return 'stable'
  }
}

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
 *   - 安装版：Rust 使用 Tauri updater API 动态绑定 stable/beta 端点
 *   - 离线版（'disabled'）：直接按「无更新」返回，不发起任何检查
 * 任何异常一律按「无更新」降级，绝不打断用户。
 */
export async function detectUpdate(
  cloudEnabled = true,
  suppressErrors = true,
): Promise<UpdateCheckResult> {
  if (!isTauri || !cloudEnabled) return noUpdate('disabled')
  try {
    const channel = await getUpdateChannel()
    if (channel === 'disabled') return noUpdate('disabled')
    const releaseChannel = await getUpdateReleaseChannel()
    const { invoke } = await import('@tauri-apps/api/core')

    if (channel === 'portable') {
      const info = await invoke<{
        available: boolean
        version: string
        notes: string
        force_update: boolean
        release_id: string
        release_channel: UpdateReleaseChannel
        cohort: UpdateCohort
        signature_verification: string
      }>(
        'portable_update_check',
        { channel: releaseChannel },
      )
      return {
        available: !!(info && info.available),
        version: (info && info.version) || '',
        notes: (info && info.notes) || '',
        channel,
        forceUpdate: !!(info && info.available && info.force_update),
        releaseId: info?.release_id || '',
        releaseChannel: info?.release_channel === 'beta' ? 'beta' : releaseChannel,
        cohort: info?.cohort || EMPTY_COHORT,
        signatureVerification: info?.signature_verification || 'not-checked',
      }
    }

    const info = await invoke<{
      available: boolean
      version: string
      notes: string
      force_update: boolean
      release_id: string
      release_channel: UpdateReleaseChannel
      cohort: UpdateCohort
      signature_verification: string
    }>('installer_update_check', { channel: releaseChannel })
    return {
      available: !!info?.available,
      version: info?.version || '',
      notes: info?.notes || '',
      channel,
      forceUpdate: !!info?.force_update,
      releaseId: info?.release_id || '',
      releaseChannel: info?.release_channel === 'beta' ? 'beta' : releaseChannel,
      cohort: info?.cohort || EMPTY_COHORT,
      signatureVerification: info?.signature_verification || 'not-checked',
    }
  } catch (error) {
    if (!suppressErrors) throw error
    return noUpdate()
  }
}

async function applyWithProgress(
  command: 'portable_update_apply' | 'installer_update_apply',
  eventName: 'portable-update-progress' | 'installer-update-progress',
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<UpdateProgress>(eventName, (event) => {
    onProgress?.(event.payload)
  })
  try {
    await invoke(command)
  } finally {
    unlisten()
  }
}

export async function applyPortableUpdate(onProgress?: (progress: UpdateProgress) => void): Promise<void> {
  await applyWithProgress('portable_update_apply', 'portable-update-progress', onProgress)
}

export async function applyInstallerUpdate(onProgress?: (progress: UpdateProgress) => void): Promise<void> {
  await applyWithProgress('installer_update_apply', 'installer-update-progress', onProgress)
}

export async function getUpdateStartupStatus(): Promise<UpdateStartupStatus> {
  if (!isTauri) return { previousFailure: false, relaunchSuccess: false, version: '', updateType: '' }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<UpdateStartupStatus>('get_update_startup_status')
}

export async function flushUpdateTelemetry(): Promise<void> {
  if (!isTauri) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('flush_update_telemetry')
}

export async function getUpdateRuntimeDiagnostics(): Promise<UpdateRuntimeDiagnostics | null> {
  if (!isTauri) return null
  const releaseChannel = await getUpdateReleaseChannel()
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<UpdateRuntimeDiagnostics>('get_update_diagnostics', { channel: releaseChannel })
}
