// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
/**
 * 售后诊断包导出（P1-3）
 *
 * 调用 Sidecar `/api/commercial/diagnostic` 获取服务端信息，
 * 与浏览器 / Tauri 端的客户端信息合并后下载为 JSON 文件。
 *
 * 不包含：用户 AI Key、激活码明文、JWT、authorization 头。
 */

import { getDiagnosticReport, type DiagnosticReport } from '../api/client'
import { getPortableDiskSpace, isTauri, type PortableDiskSpace } from '../api/transport'
import { ApiError } from './api-error'
import { getUpdateRuntimeDiagnostics, type UpdateRuntimeDiagnostics } from './update-check'

export interface ClientDiagnostic {
  generatedAt: string
  isTauri: boolean
  userAgent: string
  language: string
  timezone: string
  screen: {
    width: number
    height: number
    devicePixelRatio: number
  }
  buildVersion: string
  buildMode: string
}

export interface DiagnosticBundle {
  schema: 'XiaoJuClaw-diagnostic@1'
  client: ClientDiagnostic
  server: DiagnosticReport | { error: string; errorCode?: string; status?: number }
  portableDiskSpace: PortableDiskSpace | null
  update: UpdateRuntimeDiagnostics | null
  user: {
    activated: boolean | null
    creditBalance: number | null
    deviceId: string | null
  }
}

function safeTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

function buildClientDiagnostic(): ClientDiagnostic {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env || {}
  return {
    generatedAt: new Date().toISOString(),
    isTauri,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    language: typeof navigator !== 'undefined' ? navigator.language : '',
    timezone: safeTimezone(),
    screen: {
      width: typeof screen !== 'undefined' ? screen.width : 0,
      height: typeof screen !== 'undefined' ? screen.height : 0,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    },
    buildVersion: typeof env.VITE_APP_VERSION === 'string' ? env.VITE_APP_VERSION : 'dev',
    buildMode: typeof env.MODE === 'string' ? env.MODE : 'development',
  }
}

export interface CollectDiagnosticOptions {
  activated?: boolean | null
  creditBalance?: number | null
  deviceId?: string | null
}

export async function collectDiagnosticBundle(options: CollectDiagnosticOptions = {}): Promise<DiagnosticBundle> {
  let server: DiagnosticBundle['server']
  try {
    server = await getDiagnosticReport()
  } catch (error) {
    if (error instanceof ApiError) {
      server = { error: error.message, errorCode: error.errorCode, status: error.status }
    } else if (error instanceof Error) {
      server = { error: error.message }
    } else {
      server = { error: 'Unknown error' }
    }
  }

  let disk: PortableDiskSpace | null = null
  try {
    disk = await getPortableDiskSpace()
  } catch {
    disk = null
  }

  let update: UpdateRuntimeDiagnostics | null = null
  try {
    update = await getUpdateRuntimeDiagnostics()
  } catch {
    update = null
  }

  return {
    schema: 'XiaoJuClaw-diagnostic@1',
    client: buildClientDiagnostic(),
    server,
    portableDiskSpace: disk,
    update,
    user: {
      activated: options.activated ?? null,
      creditBalance: options.creditBalance ?? null,
      deviceId: options.deviceId ?? null,
    },
  }
}

function formatStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function downloadDiagnosticJson(bundle: DiagnosticBundle): string {
  const filename = `XiaoJuClaw-diagnostic-${formatStamp()}.json`
  const json = JSON.stringify(bundle, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 释放 ObjectURL，避免内存泄漏
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return filename
}

export async function exportDiagnosticBundle(options: CollectDiagnosticOptions = {}): Promise<{ filename: string; bundle: DiagnosticBundle }> {
  const bundle = await collectDiagnosticBundle(options)
  const filename = downloadDiagnosticJson(bundle)
  return { filename, bundle }
}
