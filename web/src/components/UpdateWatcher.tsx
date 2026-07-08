// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect } from 'react'
import { toast } from 'sonner'
import { isTauri } from '@/api/transport'
import { useI18n } from '@/i18n'
import { detectUpdate, getUpdateChannel } from '@/lib/update-check'
import { useUpdateStore } from '@/stores/update'

// 启动 8s 后首次检测（避开启动高峰），之后每 6 小时轮询一次。
const FIRST_DELAY_MS = 8000
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
const LAST_VERSION_KEY = 'xjc-last-run-version'

/**
 * 后台更新哨兵：无 UI，仅负责「启动自动检测 + 定时轮询 + 更新成功回执」。
 *   - 发现新版：写全局 update store（驱动侧边栏红点 + 强更弹窗）+ 可点击 toast，
 *     点「去更新」经 xjc:open-settings 事件打开设置→关于页完成更新。
 *   - forceUpdate 版本：不发 toast，由 ForceUpdateDialog 全屏接管。
 *   - 更新成功回执：本地记录上次运行版本，版本变化时提示「已更新到 vX」，
 *     让「下载→替换→重启」的闭环对用户可见。
 */
export function UpdateWatcher() {
  const { t } = useI18n()

  // 更新成功回执：只在启动时判断一次。
  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string>('get_version')
        .then((v) => {
          const prev = localStorage.getItem(LAST_VERSION_KEY)
          localStorage.setItem(LAST_VERSION_KEY, v)
          if (prev && prev !== v) {
            toast.success(`${t.settings.updatedToVersion} v${v}`, { id: 'xjc-update-done', duration: 6000 })
          }
        })
        .catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isTauri) return
    let cancelled = false
    let first: ReturnType<typeof setTimeout> | null = null
    let interval: ReturnType<typeof setInterval> | null = null

    const run = async () => {
      const res = await detectUpdate()
      if (cancelled || !res.available) return
      useUpdateStore.getState().setAvailable({
        version: res.version,
        notes: res.notes,
        channel: res.channel,
        forceUpdate: res.forceUpdate,
      })
      // 强更由 ForceUpdateDialog 全屏接管，不再叠加 toast。
      if (res.forceUpdate) return
      toast.info(`${t.settings.updateAvailableTitle} v${res.version}`, {
        id: 'xjc-update-available',
        duration: 12000,
        description: t.settings.updateAvailableDesc,
        action: {
          label: t.settings.goUpdate,
          onClick: () =>
            window.dispatchEvent(new CustomEvent('xjc:open-settings', { detail: { tab: 'about' } })),
        },
      })
    }

    // 离线版（通道烧死为 'disabled'）整体 no-op：连首检/轮询定时器都不注册。
    void getUpdateChannel().then((channel) => {
      if (cancelled || channel === 'disabled') return
      first = setTimeout(run, FIRST_DELAY_MS)
      interval = setInterval(run, POLL_INTERVAL_MS)
    })

    return () => {
      cancelled = true
      if (first) clearTimeout(first)
      if (interval) clearInterval(interval)
    }
    // t 仅用于 toast 文案，随语言变化无需重启检测；挂载即启动一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
