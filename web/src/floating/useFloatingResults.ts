// [XJC] 悬浮窗专用的轻量实时结果监听：独立连 sidecar WebSocket，只收 agent 的
// complete 事件（= AI 出结果），不碰主应用的 chat store，保持悬浮窗轻量。
import { useEffect, useRef, useState } from 'react'
import { getAuthenticatedWebSocketUrl, initBaseUrl } from '@/api/transport'
import { getAgents } from '@/api/client'

export interface FloatingResult {
  id: string
  chatId: string
  agentId: string
  agentName: string
  text: string
  time: string
  read: boolean
}

interface AgentEventLite {
  type: string
  agentId?: string
  chatId?: string
  fullText?: string
  name?: string
  senderName?: string
  timestamp?: string
}

interface Envelope {
  kind: string
  event?: AgentEventLite
}

const MAX_RESULTS = 40

export function useFloatingResults() {
  const [results, setResults] = useState<FloatingResult[]>([])
  const [connected, setConnected] = useState(false)
  const agentNamesRef = useRef<Map<string, string>>(new Map())
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disposedRef = useRef(false)
  const attemptRef = useRef(0)

  useEffect(() => {
    disposedRef.current = false

    // agentId → 显示名（best-effort，失败就退化为 agentId）
    void getAgents()
      .then((list) => {
        const map = new Map<string, string>()
        for (const a of list) map.set(a.id, a.name || a.id)
        agentNamesRef.current = map
      })
      .catch(() => { /* 忽略 */ })

    const scheduleReconnect = () => {
      if (disposedRef.current) return
      if (reconnectRef.current) return
      const delay = Math.min(1000 * 2 ** attemptRef.current, 15000)
      attemptRef.current += 1
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null
        void connect()
      }, delay)
    }

    const connect = async () => {
      if (disposedRef.current) return
      try { await initBaseUrl() } catch { /* 端口探测失败也尝试默认 */ }
      if (disposedRef.current) return

      let ws: WebSocket
      try {
        ws = new WebSocket(await getAuthenticatedWebSocketUrl('/api/ws'))
      } catch {
        scheduleReconnect()
        return
      }
      socketRef.current = ws

      ws.onopen = () => {
        attemptRef.current = 0
        if (!disposedRef.current) setConnected(true)
      }
      ws.onmessage = (message) => {
        let envelope: Envelope
        try {
          envelope = JSON.parse(message.data as string) as Envelope
        } catch {
          return
        }
        if (envelope.kind !== 'agent_event' || !envelope.event) return
        const ev = envelope.event
        if (ev.type !== 'complete') return
        const text = (ev.fullText ?? '').trim()
        if (!text || !ev.chatId) return

        const agentId = ev.agentId ?? ''
        const agentName = agentNamesRef.current.get(agentId) || ev.name || agentId || 'AI'
        const result: FloatingResult = {
          id: `${ev.chatId}:${ev.timestamp ?? Date.now()}`,
          chatId: ev.chatId,
          agentId,
          agentName,
          text,
          time: ev.timestamp ?? new Date().toISOString(),
          read: false,
        }
        setResults((prev) => [result, ...prev.filter((r) => r.id !== result.id)].slice(0, MAX_RESULTS))
      }
      ws.onerror = () => { /* close 会触发重连 */ }
      ws.onclose = () => {
        if (!disposedRef.current) setConnected(false)
        scheduleReconnect()
      }
    }

    void connect()

    return () => {
      disposedRef.current = true
      if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null }
      const ws = socketRef.current
      socketRef.current = null
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try { ws.close() } catch { /* 忽略 */ }
      }
    }
  }, [])

  const markAllRead = () => setResults((prev) => prev.map((r) => ({ ...r, read: true })))
  const clearAll = () => setResults([])
  const unreadCount = results.reduce((n, r) => (r.read ? n : n + 1), 0)

  return { results, connected, unreadCount, markAllRead, clearAll }
}
