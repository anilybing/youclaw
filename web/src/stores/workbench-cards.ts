// 工作台任务卡 store（能力与时俱进 · 阶段一）：登录后拉取服务端下发的任务卡，
// 与内置卡合并。Sidecar 侧已做「云端 → 本地缓存 → 空」三级降级，前端永远拿得到一份
// （空数组 = 仅用内置卡）。离线版无云端配置，天然只用内置卡。
import { create } from 'zustand'
import { getWorkbenchCards } from '@/api/client'
import { mergeWorkbenchTasks, WORKBENCH_TASKS, type WorkbenchTask } from '@/config/workbench-tasks'

interface WorkbenchCardsState {
  remoteCards: unknown[]
  version: number
  source: 'cloud' | 'cache' | 'default' | 'unloaded'
  loaded: boolean
  /** 有效任务卡 = 内置卡 ∪ 远程卡（远程同 id 覆盖、新 id 追加） */
  effectiveTasks: () => WorkbenchTask[]
  fetchCards: () => Promise<void>
  startPolling: () => void
}

const POLL_INTERVAL_MS = 30 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null

export const useWorkbenchCardsStore = create<WorkbenchCardsState>((set, get) => ({
  remoteCards: [],
  version: 0,
  source: 'unloaded',
  loaded: false,

  effectiveTasks: () => {
    const { remoteCards, loaded } = get()
    if (!loaded || remoteCards.length === 0) return WORKBENCH_TASKS
    return mergeWorkbenchTasks(remoteCards)
  },

  fetchCards: async () => {
    try {
      const payload = await getWorkbenchCards()
      set({
        remoteCards: Array.isArray(payload.cards) ? payload.cards : [],
        version: payload.version || 0,
        source: payload.source,
        loaded: true,
      })
    } catch {
      // Sidecar 不可达（启动竞态等）：保留现状，下轮轮询再试；仍可用内置卡
      set((s) => ({ loaded: s.loaded }))
    }
  },

  startPolling: () => {
    if (pollTimer) return
    void get().fetchCards()
    pollTimer = setInterval(() => {
      void get().fetchCards()
    }, POLL_INTERVAL_MS)
  },
}))
