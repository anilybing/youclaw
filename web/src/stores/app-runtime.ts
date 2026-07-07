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
import { reportTelemetry } from '@/api/client'
import { useRemoteConfigStore } from './remote-config'
import { resolvePreferredRegistrySource } from '@/lib/registry-source'
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

export const useAppRuntimeStore = create<AppRuntimeState>((set, get) => ({
  cloudEnabled: false,

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
      const registrySource = resolvePreferredRegistrySource(sources, settings.defaultRegistrySource, locale)
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
      set({ user, isLoggedIn: true, authLoading: false })
      reportAppStartOnce()
    } catch (err) {
      void logAuthClientEvent('warn', 'Failed to fetch auth user', {
        error: getErrorMessage(err),
      })
      set({ user: null, isLoggedIn: false, authLoading: false })
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
        registrySource: resolvePreferredRegistrySource(registrySources, settings.defaultRegistrySource, locale),
      })

      if (enabled) {
        const { loggedIn } = await getAuthStatus()
        if (loggedIn) {
          await get().fetchUser()
          await get().fetchCreditBalance()
        }
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
