import { experimental_upgradeWebSocket } from '@vercel/functions'
import type { WebSocket } from 'ws'
import { getHub } from '@/lib/presence-hub'

export const dynamic = 'force-dynamic'

export function GET() {
  return experimental_upgradeWebSocket((ws: WebSocket) => {
    getHub().handleConnection(ws)
  })
}
