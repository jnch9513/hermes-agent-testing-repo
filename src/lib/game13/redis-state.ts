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
