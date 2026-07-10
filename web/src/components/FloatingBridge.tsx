// [XJC] 悬浮窗 → 主窗桥接：悬浮窗点击某条结果时，主窗聚焦后收到 Tauri 事件
// xjc:floating-open-chat，在主窗导航到对应对话。仅桌面端生效。
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatActions } from '@/hooks/useChat'
import { isTauri } from '@/api/transport'

export function FloatingBridge() {
  const navigate = useNavigate()
  // selectedAgentId 仅影响 send 的默认 agent；此处只用 loadChat，传空串即可
  const { loadChat } = useChatActions('')

  useEffect(() => {
    if (!isTauri) return
    let unlisten: (() => void) | null = null
    let disposed = false

    void import('@tauri-apps/api/event').then(({ listen }) => {
      return listen<{ chatId?: string; agentId?: string }>('xjc:floating-open-chat', (event) => {
        const chatId = event.payload?.chatId
        if (!chatId) return
        navigate('/')
        // 透传 agentId 绑定会话，续聊才会路由到产出结果的那个员工
        void loadChat(chatId, event.payload?.agentId || undefined)
      })
    }).then((fn) => {
      if (disposed) { fn(); return }
      unlisten = fn
    }).catch(() => { /* 忽略 */ })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [navigate, loadChat])

  return null
}
