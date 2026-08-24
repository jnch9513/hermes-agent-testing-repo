// Per-instance WebSocket hub for presence.
// Local sockets live here; cross-instance fan-out goes through Redis pub/sub.
// State (who is online, which room) lives in the shared presence store.
import type { WebSocket } from 'ws'
import { Redis } from 'ioredis'
import { randomUUID } from 'node:crypto'
import {
  parseClientFrame,
  type PresenceUser,
  type ServerFrame,
} from '@/lib/protocol'
import {
  MemoryPresenceStore,
  RedisPresenceStore,
  type PresenceStore,
} from '@/lib/presence-store'

const HEARTBEAT_MS = 5000
const BROADCAST_CHANNEL = 'presence:frames'

interface ConnState {
  clientId: string | null
}

export class PresenceHub {
  private readonly store: PresenceStore
  private readonly pub: Redis | null
  private readonly sub: Redis | null
  private readonly origin = randomUUID()
  private readonly localClients = new Map<WebSocket, ConnState>()
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor() {
    const url = process.env.REDIS_URL
    if (url) {
      this.pub = new Redis(url)
      this.sub = this.pub.duplicate()
      this.pub.on('error', (err) => console.error('[redis] pub:', err.message))
      this.sub.on('error', (err) => console.error('[redis] sub:', err.message))
      this.wireRelay()
      this.store = new RedisPresenceStore(this.pub)
    } else {
      this.pub = null
      this.sub = null
      this.store = new MemoryPresenceStore()
    }
    this.startHeartbeat()
  }

  private startHeartbeat() {
    if (this.heartbeat) return
    this.heartbeat = setInterval(async () => {
      try {
        const entries: [string, { name: string; room: string | null }][] = []
        for (const [, state] of this.localClients) {
          if (!state.clientId) continue
          const info = this.infoByClient.get(state.clientId)
          if (info) entries.push([state.clientId, info])
        }
        if (entries.length) await this.store.touch(entries)
        const gone = await this.store.pruneStale()
        if (gone.length || entries.length) await this.broadcastPresence()
        for (const u of gone) {
          void u // departures are implicit in the next presence frame
        }
      } catch (err) {
        console.error('[presence] heartbeat:', (err as Error).message)
      }
    }, HEARTBEAT_MS)
  }

  // clientId -> last known {name, room}; lets heartbeats re-touch without the
  // client resending hello.
  private readonly infoByClient = new Map<string, { name: string; room: string | null }>()

  handleConnection(ws: WebSocket) {
    this.localClients.set(ws, { clientId: null })

    ws.on('message', async (data) => {
      const frame = parseClientFrame(typeof data === 'string' ? data : String(data))
      if (!frame) return
      const state = this.localClients.get(ws)
      if (!state) return

      if (frame.type === 'hello') {
        state.clientId = frame.clientId
        this.infoByClient.set(frame.clientId, { name: frame.name, room: null })
        await this.store.touch([[frame.clientId, { name: frame.name, room: null }]])
        await this.broadcastPresence()
      }

      if (frame.type === 'join room' && state.clientId) {
        const info = this.infoByClient.get(state.clientId)
        if (info) {
          info.room = frame.room
          await this.store.touch([[state.clientId, info]])
          await this.broadcastPresence()
        }
      }
    })

    ws.on('close', async () => {
      const state = this.localClients.get(ws)
      this.localClients.delete(ws)
      if (state?.clientId) {
        this.infoByClient.delete(state.clientId)
        await this.store.remove([state.clientId])
        await this.broadcastPresence()
      }
    })
  }

  /** Send current presence to every socket on every instance. */
  async broadcastPresence() {
    const users = await this.store.snapshot()
    users.sort((a, b) => a.name.localeCompare(b.name))
    this.deliverLocal({ type: 'presence', users })
    if (this.pub) {
      try {
        await this.pub.publish(
          BROADCAST_CHANNEL,
          JSON.stringify({ origin: this.origin, frame: { type: 'presence', users } })
        )
      } catch (err) {
        console.error('[redis] publish:', (err as Error).message)
      }
    }
  }

  private deliverLocal(frame: ServerFrame) {
    const payload = JSON.stringify(frame)
    for (const [ws] of this.localClients) {
      if (ws.readyState === ws.OPEN) ws.send(payload)
    }
  }

  private wireRelay() {
    if (!this.sub) return
    this.sub
      .subscribe(BROADCAST_CHANNEL)
      .catch((err: Error) => console.error('[redis] subscribe:', err.message))
    this.sub.on('message', (channel, payload) => {
      if (channel !== BROADCAST_CHANNEL) return
      try {
        const { origin, frame } = JSON.parse(payload) as {
          origin: string
          frame: ServerFrame
        }
        if (origin === this.origin) return // our own publish came back
        this.deliverLocal(frame)
      } catch {
        /* ignore malformed frames */
      }
    })
  }
}

// One hub per function instance (module-level singleton survives warm invocations).
const g = globalThis as unknown as { __presenceHub?: PresenceHub }
export function getHub(): PresenceHub {
  return (g.__presenceHub ??= new PresenceHub())
}

export type { PresenceUser }
