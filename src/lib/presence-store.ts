// Shared presence state across WS function instances.
// Redis (Upstash/Vercel Marketplace) when REDIS_URL is set; in-memory fallback
// keeps local dev working with a single instance.
import type Redis from 'ioredis'
import type { PresenceUser } from '@/lib/protocol'

const PRESENCE_ZKEY = 'presence:online' // ZSET clientId -> last-seen ms
const PRESENCE_HKEY = 'presence:data' // HASH clientId -> JSON {name, room}

export const STALE_MS = 20_000

export interface PresenceStore {
  touch(entries: Iterable<[string, { name: string; room: string | null }]>): Promise<void>
  remove(clientIds: Iterable<string>): Promise<void>
  pruneStale(): Promise<PresenceUser[]>
  snapshot(): Promise<PresenceUser[]>
}

function parseData(raw: string | null): { name: string; room: string | null } {
  if (!raw) return { name: '?', room: null }
  try {
    const d = JSON.parse(raw) as { name?: string; room?: string | null }
    return { name: d.name ?? '?', room: d.room ?? null }
  } catch {
    return { name: '?', room: null }
  }
}

export class RedisPresenceStore implements PresenceStore {
  constructor(private readonly redis: Redis) {}

  async touch(entries: Iterable<[string, { name: string; room: string | null }]>) {
    const now = Date.now()
    try {
      const pipe = this.redis.multi()
      for (const [clientId, info] of entries) {
        pipe.zadd(PRESENCE_ZKEY, now, clientId)
        pipe.hset(PRESENCE_HKEY, clientId, JSON.stringify(info))
      }
      await pipe.exec()
    } catch (err) {
      console.error('[presence] touch error:', (err as Error).message)
    }
  }

  async remove(clientIds: Iterable<string>) {
    try {
      const pipe = this.redis.multi()
      for (const id of clientIds) {
        pipe.zrem(PRESENCE_ZKEY, id)
        pipe.hdel(PRESENCE_HKEY, id)
      }
      await pipe.exec()
    } catch (err) {
      console.error('[presence] remove error:', (err as Error).message)
    }
  }

  async pruneStale(): Promise<PresenceUser[]> {
    try {
      const cutoff = Date.now() - STALE_MS
      const removed: string[] = await this.redis.zrangebyscore(
        PRESENCE_ZKEY,
        '-inf',
        String(cutoff)
      )
      if (!removed.length) return []
      await this.remove(removed)
      const datas = await this.redis.hmget(PRESENCE_HKEY, ...removed)
      return removed.map((id, i) => ({
        clientId: id,
        ...parseData(datas[i]),
      }))
    } catch (err) {
      console.error('[presence] prune error:', (err as Error).message)
      return []
    }
  }

  async snapshot(): Promise<PresenceUser[]> {
    try {
      const ids: string[] = await this.redis.zrange(PRESENCE_ZKEY, "0", "-1")
      if (!ids.length) return []
      const datas = await this.redis.hmget(PRESENCE_HKEY, ...ids.map(String))
      return ids.map((id, i) => ({ clientId: id, ...parseData(datas[i]) }))
    } catch (err) {
      console.error('[presence] snapshot error:', (err as Error).message)
      return []
    }
  }
}

interface MemEntry extends PresenceUser {
  lastSeen: number
}

export class MemoryPresenceStore implements PresenceStore {
  private readonly m = new Map<string, MemEntry>()

  async touch(entries: Iterable<[string, { name: string; room: string | null }]>) {
    const now = Date.now()
    for (const [clientId, info] of entries) {
      this.m.set(clientId, { clientId, ...info, lastSeen: now })
    }
  }

  async remove(clientIds: Iterable<string>) {
    for (const id of clientIds) this.m.delete(id)
  }

  async pruneStale(): Promise<PresenceUser[]> {
    const now = Date.now()
    const gone: PresenceUser[] = []
    for (const [id, e] of this.m) {
      if (now - e.lastSeen > STALE_MS) {
        this.m.delete(id)
        gone.push({ clientId: e.clientId, name: e.name, room: e.room })
      }
    }
    return gone
  }

  async snapshot(): Promise<PresenceUser[]> {
    return [...this.m.values()].map((e) => ({
      clientId: e.clientId,
      name: e.name,
      room: e.room,
    }))
  }
}

export type { Redis }
