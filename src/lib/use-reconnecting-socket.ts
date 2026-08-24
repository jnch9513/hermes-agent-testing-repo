'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

const RECONNECT_BASE_MS = 100
const RECONNECT_MAX_MS = 5000

// Self-reconnecting WebSocket hook (exponential backoff + jitter on drop).
export function useReconnectingSocket(
  getUrl: () => string,
  onMessage: (data: string) => void
): { connectionState: ConnectionState; send: (data: string) => void } {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const wsRef = useRef<WebSocket | null>(null)

  const getUrlRef = useRef(getUrl)
  const onMessageRef = useRef(onMessage)
  useEffect(() => {
    getUrlRef.current = getUrl
    onMessageRef.current = onMessage
  }, [getUrl, onMessage])

  useEffect(() => {
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let closedByUs = false

    const connect = () => {
      const ws = new WebSocket(getUrlRef.current())
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        setConnectionState('connected')
      }
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') onMessageRef.current(e.data)
      }
      ws.onclose = () => {
        wsRef.current = null
        if (closedByUs) return
        setConnectionState('disconnected')
        const base = Math.min(RECONNECT_BASE_MS * 2 ** attempt++, RECONNECT_MAX_MS)
        const delay = Math.max(0, base + base * 0.5 * (Math.random() * 2 - 1))
        reconnectTimer = setTimeout(connect, delay)
      }
      ws.onerror = () => setConnectionState('error' as ConnectionState)
    }

    connect()

    return () => {
      closedByUs = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [])

  const send = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
  }, [])

  return { connectionState, send }
}
