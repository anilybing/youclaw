// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { create } from 'zustand'

// 'disabled' 仅为与 update-check 的通道类型对齐：离线版 detectUpdate 恒返回
// 「无更新」，运行期不会以 'disabled' 写入本 store。
export type UpdateChannel = 'portable' | 'installer' | 'disabled' | ''

/**
 * 全局「有可用更新」状态：由启动自动检测 / About 页手动检测写入，
 * 侧边栏入口据此显示红点、About 页据此预置「立即更新」，
 * forceUpdate=true 时 ForceUpdateDialog 全屏接管（不可跳过）。
 */
interface UpdateState {
  available: boolean
  version: string
  notes: string
  channel: UpdateChannel
  forceUpdate: boolean
  setAvailable: (info: {
    version: string
    notes: string
    channel: Exclude<UpdateChannel, ''>
    forceUpdate?: boolean
  }) => void
  clear: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  available: false,
  version: '',
  notes: '',
  channel: '',
  forceUpdate: false,
  setAvailable: ({ version, notes, channel, forceUpdate }) =>
    set({ available: true, version, notes, channel, forceUpdate: !!forceUpdate }),
  clear: () => set({ available: false, version: '', notes: '', channel: '', forceUpdate: false }),
}))
