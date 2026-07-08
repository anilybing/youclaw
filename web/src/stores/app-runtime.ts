// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { create } from 'zustand'
import {
  ActiveModelProvider,
  checkEnv,
  authLogout,
  getAuthStatus,
  getAuthUser,
  getCloudStatus,
  getCreditBalance,
  getRegistrySources,
  getSettings,
  updateProfile as apiUpdateProfile,
  updateSettings,
  type AuthUser,
  type DependencyStatus,
  type RegistrySelectableSource,
  type RegistrySourceInfo,
} from '@/api/client'
import { getPortableDiskSpace, isTauri } from '@/api/transport'
import { reportTelemetry, syncRemoteStaff, getCloudReachable } from '@/api/client'
import { ApiError } from '@/lib/api-error'
import { useRemoteConfigStore } from './remote-config'
import { useWorkbenchCardsStore } from './workbench-cards'
import { filterVisibleRegistrySources, isThirdPartySkillSourcesEnabled, resolvePreferredRegistrySource } from '@/lib/registry-source'
import { getErrorMessage, logAuthClientEvent } from '@/lib/auth-debug'
import { applyThemeToDOM } from '@/hooks/useTheme'
import { toast, type ExternalToast } from 'sonner'
import { useAppPreferencesStore } from './app-preferences'

type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading' | 'default'

type NotifyOptions = {
  durationMs?: number
  id?: string | number
  description?: ExternalToast['description']
}

type NotifyInput = NotifyOptions & {
  message: string
  type?: ToastType
}

type NotifyMethod = (message: string, options?: NotifyOptions) => string | number

type NotifyFn = ((toast: NotifyInput) => string | number) & {
  success: NotifyMethod
  error: NotifyMethod
  info: NotifyMethod
  warning: NotifyMethod
  loading: NotifyMethod
  message: NotifyMethod
  dismiss: (id?: string | number) => void
}

interface AppRuntimeState {
  cloudEnabled: boolean
  /** 远程 MVP 当前是否可达（连不上远程服务器时为 false，用于降级离线） */
  cloudReachable: boolean
  /** 本会话已进入「离线降级」：云端不可达时放行进入应用，不把用户挡在登录页外 */
  offlineFallback: boolean
  /** 主动进入离线降级（登录页连不上服务器时的逃生口） */
  enterOfflineFallback: () => void
  /** 启动云端可达性监控（自适应轮询 + 监听系统 online/窗口可见事件；幂等） */
  startCloudMonitor: () => void
  /** 云端从不可达恢复：有 token 则无感恢复登录态，并刷新云驱动的能力 */
  handleCloudRecovered: () => Promise<void>

  gitAvailable: boolean
  gitChecked: boolean
  recheckGit: () => Promise<boolean>

  envChecked: boolean
  envDependencies: DependencyStatus[]
  envReady: boolean
  recheckEnv: () => Promise<boolean>

  modelReady: boolean

  registrySource: RegistrySelectableSource
  registrySources: RegistrySourceInfo[]
  setRegistrySource: (source: RegistrySelectableSource) => void
  setRegistrySources: (sources: RegistrySourceInfo[]) => void
  refreshRegistrySources: () => Promise<RegistrySourceInfo[]>

  user: AuthUser | null
  isLoggedIn: boolean
  authLoading: boolean
  fetchUser: () => Promise<void>
  login: () => Promise<void>
  logout: () => Promise<void>
  updateProfile: (params: { displayName?: string; avatar?: string }) => Promise<void>

  creditBalance: number | null
  fetchCreditBalance: () => Promise<void>
  openPayPage: () => Promise<void>

  hydrate: () => Promise<void>
}

let authPollInterval: ReturnType<typeof setInterval> | null = null
let authPollTimeout: ReturnType<typeof setTimeout> | null = null
let portableDiskSpaceInterval: ReturnType<typeof setInterval> | null = null

function clearAuthPolling() {
  if (authPollInterval) {
    clearInterval(authPollInterval)
    authPollInterval = null
  }
  if (authPollTimeout) {
    clearTimeout(authPollTimeout)
    authPollTimeout = null
  }
}

function toToastOptions(options?: NotifyOptions): ExternalToast {
  return {
    id: options?.id,
    description: options?.description,
    duration: options?.durationMs,
  }
}

function dispatchToast(
  type: ToastType,
  message: string,
  options?: NotifyOptions,
): string | number {
  const toastOptions = {
    ...toToastOptions(options),
    duration: options?.durationMs ?? (type === 'loading' ? Infinity : 4000),
  }

  switch (type) {
    case 'error':
      return toast.error(message, toastOptions)
    case 'info':
      return toast.info(message, toastOptions)
    case 'warning':
      return toast.warning(message, toastOptions)
    case 'loading':
      return toast.loading(message, toastOptions)
    case 'default':
      return toast(message, toastOptions)
    case 'success':
    default:
      return toast.success(message, toastOptions)
  }
}

export const notify = Object.assign(
  ({ message, type = 'success', ...options }: NotifyInput) => dispatchToast(type, message, options),
  {
    success: (message: string, options?: NotifyOptions) => dispatchToast('success', message, options),
    error: (message: string, options?: NotifyOptions) => dispatchToast('error', message, options),
    info: (message: string, options?: NotifyOptions) => dispatchToast('info', message, options),
    warning: (message: string, options?: NotifyOptions) => dispatchToast('warning', message, options),
    loading: (message: string, options?: NotifyOptions) => dispatchToast('loading', message, options),
    message: (message: string, options?: NotifyOptions) => dispatchToast('default', message, options),
    dismiss: (id?: string | number) => {
      toast.dismiss(id)
    },
  },
) as NotifyFn

// 商业版应用内导航：store 无路由上下文，通过 history API + popstate 驱动
// react-router；同时广播事件让打开中的弹窗（如设置）自行关闭。
function navigateInApp(path: string): void {
  window.dispatchEvent(new CustomEvent('xjc:navigate', { detail: { path } }))
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// [XJC] 解析默认选中源时按第三方源开关过滤，避免被隐藏的源（clawhub/tencent 等）
// 静默成为当前源；完整列表仍存入 registrySources，由选择器按开关展示。
function visibleRegistrySources(sources: RegistrySourceInfo[]): RegistrySourceInfo[] {
  const showThirdParty = useAppPreferencesStore.getState().showThirdPartySkillSources
  const remoteEnabled = useRemoteConfigStore.getState().flag('skills.thirdparty_enabled', false)
  return filterVisibleRegistrySources(sources, isThirdPartySkillSourcesEnabled(showThirdParty, remoteEnabled))
}

// app_start 遥测：每次会话只上报一次（登录态确认后触发；失败静默）
let appStartReported = false
function reportAppStartOnce(): void {
  if (appStartReported) return
  appStartReported = true
  void reportTelemetry('app_start', { platform: navigator.platform, portable: isTauri })
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

async function notifyPortableDiskSpace(): Promise<void> {
  if (!isTauri) return
  try {
    const disk = await getPortableDiskSpace()
    if (!disk || disk.warning_level === 'ok') return
    const isCritical = disk.warning_level === 'critical'
    notify.warning(isCritical ? 'U盘容量严重不足' : 'U盘容量不足', {
      id: 'portable-disk-space-warning',
      durationMs: isCritical ? 12000 : 8000,
      description: `当前便携数据目录剩余 ${formatBytes(disk.free_bytes)}（${disk.free_percent.toFixed(1)}%）：${disk.data_dir}`,
    })
  } catch {
    return
  }
}

function startPortableDiskSpaceMonitor() {
  if (!isTauri || portableDiskSpaceInterval) return
  portableDiskSpaceInterval = setInterval(() => {
    void notifyPortableDiskSpace()
  }, 10 * 60 * 1000)
}

// 云端可达性监控：自适应轮询——离线时探测更勤（尽快恢复），在线时较缓（探掉线）。
let cloudMonitorTimer: ReturnType<typeof setTimeout> | null = null
let cloudMonitorStarted = false
let cloudProbing = false
const CLOUD_POLL_ONLINE_MS = 60 * 1000
const CLOUD_POLL_OFFLINE_MS = 15 * 1000

/**
 * 判断一个错误是否属于「远程云端不可达」（连接失败 / 代理层 5xx / 超时），
 * 以区别于「鉴权失败」（401/403）——后者才是真正的未登录，前者应降级离线而非踢下线。
 * 客户端经本地 sidecar 代理云端：sidecar 不可达 → status 0；MVP 宕机经代理 → 5xx。
 */
function isCloudUnreachableError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.status === 0) return true // 网络/连接失败
    if (err.status >= 500) return true // 代理层/云端服务错误（MVP 宕机）
    if (err.errorCode === 'NETWORK_ERROR') return true
    return false // 401/403/400 等：云端有响应，属鉴权/参数问题，不算不可达
  }
  // 非 ApiError（罕见）：保守当作不可达，避免误踢已登录用户
  return true
}

export const useAppRuntimeStore = create<AppRuntimeState>((set, get) => ({
  cloudEnabled: false,
  cloudReachable: true,
  offlineFallback: false,
  enterOfflineFallback: () => set({ offlineFallback: true, cloudReachable: false }),

  startCloudMonitor: () => {
    if (cloudMonitorStarted) return
    cloudMonitorStarted = true

    const probe = async () => {
      if (!get().cloudEnabled) return
      // 定时器与 online/visibilitychange 事件可能并发触发；单探测在飞行时跳过，
      // 避免重复 handleCloudRecovered（双重 fetchUser / 双重「已恢复」提示）。
      if (cloudProbing) return
      cloudProbing = true
      try {
        const { reachable } = await getCloudReachable()
        const was = get().cloudReachable
        if (reachable !== was) set({ cloudReachable: reachable })
        // 掉线→恢复：无感恢复会话 + 刷新云数据（内置兜底，安全）
        if (reachable && !was) await get().handleCloudRecovered()
      } catch {
        if (get().cloudReachable) set({ cloudReachable: false })
      } finally {
        cloudProbing = false
      }
    }

    const scheduleNext = () => {
      if (cloudMonitorTimer) clearTimeout(cloudMonitorTimer)
      // 离线时勤探（尽快恢复），在线时缓探（探掉线）
      const delay = get().cloudReachable ? CLOUD_POLL_ONLINE_MS : CLOUD_POLL_OFFLINE_MS
      cloudMonitorTimer = setTimeout(() => {
        void probe().finally(scheduleNext)
      }, delay)
    }

    // 系统网络恢复 / 窗口重新可见（多为用户本地网络问题）→ 立即探一次，加速恢复
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { void probe() })
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && !get().cloudReachable) void probe()
        })
      }
    }

    void probe().finally(scheduleNext)
  },

  handleCloudRecovered: async () => {
    // 本地仍有 token 但当前未标记登录（多为宕机期被降级）→ 无感恢复登录态
    try {
      const { loggedIn } = await getAuthStatus()
      if (loggedIn && !get().isLoggedIn) {
        await get().fetchUser()
        await get().fetchCreditBalance()
      }
    } catch { /* 恢复过程失败静默，等下一轮轮询 */ }
    // 刷新云驱动的能力（远程配置 / 工作台卡 / 线上数字员工；均云端→缓存→内置兜底）
    void useRemoteConfigStore.getState().fetchRemoteConfig()
    void useWorkbenchCardsStore.getState().fetchCards()
    void syncRemoteStaff().catch(() => {})
    notify.info('已恢复与云服务器的连接')
  },

  gitAvailable: true,
  gitChecked: false,
  recheckGit: async () => {
    await get().recheckEnv()
    return get().gitAvailable
  },

  envChecked: false,
  envDependencies: [],
  envReady: true,
  recheckEnv: async () => {
    try {
      const result = await checkEnv()
      const envReady = result.dependencies
        .filter(d => d.required)
        .every(d => d.available)
      const gitDep = result.dependencies.find(d => d.name === 'git')
      set({
        envDependencies: result.dependencies,
        envChecked: true,
        envReady,
        gitAvailable: gitDep?.available ?? true,
        gitChecked: true,
      })
      return envReady
    } catch {
      set({ envChecked: true, envReady: true, gitAvailable: true, gitChecked: true })
      return true
    }
  },

  modelReady: false,

  registrySource: 'xiaojuclaw',
  registrySources: [],
  setRegistrySource: (registrySource) => set({ registrySource }),
  setRegistrySources: (registrySources) => set({ registrySources }),
  refreshRegistrySources: async () => {
    try {
      const [settings, sources] = await Promise.all([
        getSettings(),
        getRegistrySources(),
      ])
      const locale = useAppPreferencesStore.getState().locale
      const registrySource = resolvePreferredRegistrySource(visibleRegistrySources(sources), settings.defaultRegistrySource, locale)
      set({ registrySources: sources, registrySource })
      return sources
    } catch {
      return get().registrySources
    }
  },

  user: null,
  isLoggedIn: false,
  authLoading: false,
  fetchUser: async () => {
    try {
      set({ authLoading: true })
      const user = await getAuthUser()
      if (!user.name) {
        user.name = `User_${user.id.slice(0, 6)}`
      }
      if (!user.avatar) {
        user.avatar = `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user.name)}`
      }
      void logAuthClientEvent('info', 'Auth user fetched successfully', {
        userId: user.id,
        hasEmail: !!user.email,
      })
      set({ user, isLoggedIn: true, authLoading: false, cloudReachable: true })
      reportAppStartOnce()
    } catch (err) {
      void logAuthClientEvent('warn', 'Failed to fetch auth user', {
        error: getErrorMessage(err),
      })
      if (isCloudUnreachableError(err)) {
        // 云端不可达：不要清除登录态（避免网络抖动/服务器宕机把已登录用户踢下线），
        // 转为离线降级，让用户仍能用本地模型 + 内置数字员工。
        set({ authLoading: false, cloudReachable: false, offlineFallback: true })
      } else {
        // 真正的鉴权失败（token 失效等）：正常登出。
        set({ user: null, isLoggedIn: false, authLoading: false, cloudReachable: true })
      }
    }
  },

  login: async () => {
    // 商业版：仅保留应用内登录页（手机号/邮箱），外跳云端 OAuth 已移除，
    // 防止任何指向管理后台的浏览器跳转。
    void logAuthClientEvent('info', 'Login redirected to in-app login page')
    navigateInApp('/login')
  },

  logout: async () => {
    clearAuthPolling()
    try {
      await authLogout()
    } catch {
      // Always clear local UI state even if backend request fails
    }
    set({ user: null, isLoggedIn: false, authLoading: false, creditBalance: null })
  },

  updateProfile: async (params) => {
    const updatedUser = await apiUpdateProfile(params)
    set({ user: updatedUser })
  },

  creditBalance: null,
  fetchCreditBalance: async () => {
    try {
      const { balance } = await getCreditBalance()
      set({ creditBalance: balance })
    } catch {
      set({ creditBalance: null })
    }
  },

  openPayPage: async () => {
    // 商业版：充值 = 应用内「激活与设备」页兑换激活码，不打开任何外部网页
    navigateInApp('/activation')
  },

  hydrate: async () => {
    await useAppPreferencesStore.persist.rehydrate()
    applyThemeToDOM(useAppPreferencesStore.getState().theme)
    void notifyPortableDiskSpace()
    startPortableDiskSpaceMonitor()
    // 远程配置：立即拉取 + 30 分钟轮询（Sidecar 侧有缓存/默认值兜底）
    useRemoteConfigStore.getState().startPolling()
    // 工作台任务卡：服务端下发能力（内置卡兜底）；同样立即拉取 + 30 分钟轮询
    useWorkbenchCardsStore.getState().startPolling()
    // 数字员工：拉取服务端下发的员工定义并落地（已登录才生效；离线/未登录静默跳过）
    void syncRemoteStaff().catch(() => {})

    await get().recheckEnv()

    try {
      const [cloudStatus, settings, registrySources] = await Promise.all([
        getCloudStatus(),
        getSettings(),
        getRegistrySources().catch(() => [] as RegistrySourceInfo[]),
      ])
      const { enabled } = cloudStatus
      const locale = useAppPreferencesStore.getState().locale
      set({
        cloudEnabled: enabled,
        registrySources,
        registrySource: resolvePreferredRegistrySource(visibleRegistrySources(registrySources), settings.defaultRegistrySource, locale),
      })

      if (enabled) {
        const { loggedIn } = await getAuthStatus()
        if (loggedIn) {
          // fetchUser 内部会区分「云端不可达」与「鉴权失败」：不可达则自动降级离线，
          // 不会把已登录用户踢下线。
          await get().fetchUser()
          await get().fetchCreditBalance()
        } else {
          // 未登录：探测远程云端是否可达。连不上就降级为离线可用，避免用户卡在登录页无法使用。
          try {
            const { reachable } = await getCloudReachable()
            if (!reachable) set({ cloudReachable: false, offlineFallback: true })
          } catch {
            set({ cloudReachable: false, offlineFallback: true })
          }
        }
        // 启动持续可达性监控：自适应轮询 + 系统网络/窗口事件触发，掉线可探、恢复无感重连
        get().startCloudMonitor()
      }

      const { provider } = settings.activeModel

      if (!enabled && provider === ActiveModelProvider.Builtin) {
        await updateSettings({ activeModel: { provider: ActiveModelProvider.Custom } })
        set({ modelReady: settings.customModels.length > 0 })
      } else if (provider === ActiveModelProvider.Custom) {
        const model = settings.activeModel.id
          ? settings.customModels.find((m) => m.id === settings.activeModel.id)
          : settings.customModels[0]
        set({ modelReady: !!model })
      } else {
        set({ modelReady: true })
      }
    } catch {
      // Backend not ready, ignore
    }
  },
}))
