// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useRef } from 'react'
import { getAuthenticatedEventSourceUrl } from '@/api/transport'
import type { LogEntry } from '@/api/client'

export function useLogSSE(
  enabled: boolean,
  onEntry: (entry: LogEntry) => void,
) {
  const onEntryRef = useRef(onEntry)

  useEffect(() => {
    onEntryRef.current = onEntry
  }, [onEntry])

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let es: EventSource | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return
      const delay = Math.min(1000 * (2 ** reconnectAttempt), 10_000)
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, delay)
    }

    const connect = async () => {
      let next: EventSource
      try {
        const url = await getAuthenticatedEventSourceUrl('/api/logs/stream')
        if (disposed) return
        next = new EventSource(url)
      } catch {
        scheduleReconnect()
        return
      }

      es = next
      next.onopen = () => {
        reconnectAttempt = 0
      }
      next.addEventListener('log', (e: MessageEvent) => {
        try {
          const entry = JSON.parse(e.data) as LogEntry
          onEntryRef.current(entry)
        } catch {
          // Ignore parse errors
        }
      })
      next.onerror = () => {
        // A realtime ticket is one-use. Explicitly reconnect to obtain a fresh
        // ticket instead of letting EventSource replay the old URL.
        next.close()
        if (es === next) es = null
        scheduleReconnect()
      }
    }

    void connect()

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      es?.close()
    }
  }, [enabled])
}
