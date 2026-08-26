// Redis persistence for Lucky 13 game state.
// Truth lives in Redis: `game13:<roomId>` JSON + lazy timer expiry via deadline.
// Falls back to in-memory map when REDIS_URL is unset (single instance only).

import type Redis from "ioredis";
import { GameState } from "./types";

const KEY_PREFIX = "game13:";
const TTL_SECONDS = 60 * 60 * 2; // game state expires 2h after last write

interface MemoryGame {
  state: GameState;
}

const g = globalThis as unknown as { __game13Memory?: Map<string, MemoryGame> };
const memory = (g.__game13Memory ??= new Map());

export interface GameStore {
  load(roomId: string): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
  remove(roomId: string): Promise<void>;
}

export class RedisGameStore implements GameStore {
  constructor(private readonly redis: Redis) {}

  async load(roomId: string): Promise<GameState | null> {
    try {
      const raw = await this.redis.get(KEY_PREFIX + roomId);
      if (!raw) return null;
      return JSON.parse(raw) as GameState;
    } catch (err) {
      console.error("[game13] load error:", (err as Error).message);
      return null;
    }
  }

  async save(state: GameState): Promise<void> {
    try {
      await this.redis.set(
        KEY_PREFIX + state.roomId,
        JSON.stringify(state),
        "EX",
        TTL_SECONDS
      );
    } catch (err) {
      console.error("[game13] save error:", (err as Error).message);
    }
  }

  async remove(roomId: string): Promise<void> {
    try {
      await this.redis.del(KEY_PREFIX + roomId);
    } catch (err) {
      console.error("[game13] remove error:", (err as Error).message);
    }
  }
}

export class MemoryGameStore implements GameStore {
  async load(roomId: string): Promise<GameState | null> {
    return memory.get(roomId)?.state ?? null;
  }

  async save(state: GameState): Promise<void> {
    memory.set(state.roomId, { state });
  }

  async remove(roomId: string): Promise<void> {
    memory.delete(roomId);
  }
}

export function createGameStore(redis: Redis | null): GameStore {
  return redis ? new RedisGameStore(redis) : new MemoryGameStore();
}

// ---- Distributed lock -------------------------------------------------------
// Vercel functions scale horizontally: each WS connection can land on a
// different instance, each with its own in-memory cache. Without a lock, lazy
// timer expiry (expireTimer → beginRound) can run concurrently on stale copies
// and last-writer-wins overwrites Redis — dealing cards twice and eventually
// exhausting the deck ("not enough cards"). All mutations must serialize
// through this lock.

const LOCK_PREFIX = "game13:lock:";
const LOCK_TTL_MS = 5000;
const LOCK_WAIT_MS = 4000;
const LOCK_RETRY_MS = 40;

/** Lua: release only if we still own the lock (token match). */
const RELEASE_IF_OWNED = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export async function withLock<T>(
  redis: Redis | null,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!redis) return fn(); // memory store = single instance, no lock needed
  const lockKey = LOCK_PREFIX + key;
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    const got = await redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX");
    if (got === "OK") {
      try {
        return await fn();
      } finally {
        try {
          await redis.eval(RELEASE_IF_OWNED, 1, lockKey, token);
        } catch {
          /* lock expired mid-flight; TTL will clean up */
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error("room busy — another action is being processed, try again");
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

