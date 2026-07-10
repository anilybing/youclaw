import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { StartupError } from './pages/StartupError'
import { FloatingApp } from './floating/FloatingApp'
import { I18nProvider } from './i18n'
import { initBaseUrl } from './api/transport'
import { useAppRuntimeStore } from './stores/app'
import { useAppPreferencesStore } from './stores/app-preferences'
import { applyThemeToDOM } from './hooks/useTheme'
import './index.css'
import 'streamdown/styles.css'

// [XJC] 悬浮提醒窗：同一前端 bundle，?view=floating 时渲染精简的 FloatingApp，
// 跳过登录/hydrate 等主应用启动流程。
const isFloatingView = new URLSearchParams(window.location.search).get('view') === 'floating'

// Add class for non-Mac platforms to override native scrollbar via CSS
if (navigator.platform && !navigator.platform.startsWith('Mac')) {
  document.documentElement.classList.add('custom-scrollbar')
}

const root = createRoot(document.getElementById('root')!)

// [XJC] 淡出并移除即时启动页（index.html 的 #xjc-splash）。React 首帧渲染完成后调用，
// 用 rAF 确保新内容已上屏再淡出，避免闪一下空白。多次调用安全（元素已移除即 no-op）。
function hideSplash() {
  const el = document.getElementById('xjc-splash')
  if (!el) return
  requestAnimationFrame(() => {
    el.classList.add('xjc-hide')
    setTimeout(() => el.remove(), 320)
  })
}

function renderApp() {
  root.render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  )
  hideSplash()
}

function renderError() {
  root.render(
    <StrictMode>
      <I18nProvider>
        <StartupError onRetry={startup} />
      </I18nProvider>
    </StrictMode>,
  )
  hideSplash()
}

async function renderFloating() {
  try {
    await useAppPreferencesStore.persist.rehydrate()
    applyThemeToDOM(useAppPreferencesStore.getState().theme)
  } catch { /* 主题恢复失败用默认 */ }
  root.render(
    <StrictMode>
      <I18nProvider>
        <FloatingApp />
      </I18nProvider>
    </StrictMode>,
  )
  hideSplash()
}

async function startup() {
  const ok = await initBaseUrl()
  if (!ok) {
    renderError()
    return
  }
  // hydrate 内部已自处理离线/错误，但兜底 try/finally 确保任何异常下都渲染并移除启动页，
  // 绝不把用户永久卡在启动页。
  try {
    await useAppRuntimeStore.getState().hydrate()
  } catch (err) {
    console.error('hydrate failed during startup:', err)
  }
  renderApp()
}

if (isFloatingView) {
  void renderFloating()
} else {
  startup()
}
