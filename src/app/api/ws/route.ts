import { experimental_upgradeWebSocket } from '@vercel/functions'
import type { WebSocket } from 'ws'
import { Redis } from 'ioredis'
import { getHub } from '@/lib/presence-hub'
import { getGameHub } from '@/lib/game13/game-hub'

export const dynamic = 'force-dynamic'

export function GET() {
  return experimental_upgradeWebSocket((ws: WebSocket) => {
    const url = process.env.REDIS_URL
    const redis = url ? new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 5 }) : null
    if (redis) redis.on('error', (err) => console.error('[redis] game:', err.message))

    getHub().handleConnection(ws, getGameHub(redis))
  })
}
