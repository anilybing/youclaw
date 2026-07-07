// 商业化远程配置 store（T-C5）：登录后拉取 + 30 分钟轮询刷新。
// Sidecar 侧已做「云端 → 本地缓存 → 内置默认」三级降级，前端永远拿得到配置。
import { create } from 'zustand'
import { getRemoteConfig, type RemoteConfigPayload } from '@/api/client'

export interface Announcement {
  text: string
  link: string
  until: string
}

interface RemoteConfigState {
  configs: Record<string, unknown>
  version: number
  source: RemoteConfigPayload['source'] | 'unloaded'
  /** 布尔功能开关（未知 key 返回兜底值） */
  flag: (key: string, fallback?: boolean) => boolean
  announcement: () => Announcement | null
  fetchRemoteConfig: () => Promise<void>
  startPolling: () => void
}

const POLL_INTERVAL_MS = 30 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null

export const useRemoteConfigStore = create<RemoteConfigState>((set, get) => ({
  configs: {},
  version: 0,
  source: 'unloaded',

  flag: (key, fallback = false) => {
    const value = get().configs[key]
    return typeof value === 'boolean' ? value : fallback
  },

  announcement: () => {
    const raw = get().configs['announcement']
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Partial<Announcement>
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!text) return null
    const until = typeof item.until === 'string' ? item.until : ''
    if (until && Date.parse(until) < Date.now()) return null
    return { text, link: typeof item.link === 'string' ? item.link : '', until }
  },

  fetchRemoteConfig: async () => {
    try {
      const payload = await getRemoteConfig()
      set({ configs: payload.configs, version: payload.version, source: payload.source })
    } catch {
      // Sidecar 不可达（启动竞态等）：保留现状，下轮轮询再试
    }
  },

  startPolling: () => {
    if (pollTimer) return
    void get().fetchRemoteConfig()
    pollTimer = setInterval(() => {
      void get().fetchRemoteConfig()
    }, POLL_INTERVAL_MS)
  },
}))
