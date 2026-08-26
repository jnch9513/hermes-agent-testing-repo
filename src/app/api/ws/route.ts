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

    const gameHub = getGameHub(redis)
    // Piggyback game-phase transitions on the presence heartbeat so rounds
    // advance even when no client sends messages (serverless has no timers).
    const presence = getHub()
    presence.driveGameRooms = () => gameHub.driveAllRooms()

    getHub().handleConnection(ws, gameHub)
  })
}
