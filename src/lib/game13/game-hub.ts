// Lucky 13 game hub — wires the engine to WS connections + Redis persistence.
// One GameHub per function instance (module singleton). Cross-instance sync via
// the existing presence broadcast channel pattern.

import type { WebSocket } from "ws";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { cardId } from "./card";
import {
  createGame,
  joinGame,
  startGame,
  placeCard,
  discardCard,
  setReady,
  expireTimer,
  computeScores,
  isExpired,
} from "./engine";
import { createGameStore, type GameStore } from "./redis-state";
import { GameState, Phase, PlayerGameView } from "./types";

const GAME_CHANNEL = "game13:events";

/** What a client sees: own hand in clear, others' hands hidden. */
export interface SafePlayerView {
  clientId: string;
  name: string;
  handCount: number;
  placed: { lane: string; card: Card2 }[];
  ready: boolean;
  online: boolean;
}
type Card2 = { rank: number; suit: string };

export class GameHub {
  private readonly store: GameStore;
  private readonly pub: Redis | null;
  private readonly sub: Redis | null;
  private readonly origin = randomUUID();
  /** roomId -> local sockets interested in that game */
  private readonly sockets = new Map<string, Set<{ ws: WebSocket; clientId: string | null }>>();
  /** lazily cached states to avoid re-parsing per message */
  private readonly cache = new Map<string, GameState>();

  constructor(redis: Redis | null) {
    this.store = createGameStore(redis);
    this.pub = redis;
    this.sub = redis ? redis.duplicate() : null;
    if (this.pub && this.sub) {
      this.sub
        .subscribe(GAME_CHANNEL)
        .catch((err: Error) => console.error("[game13] subscribe:", err.message));
      this.sub.on("message", (channel, payload) => {
        if (channel !== GAME_CHANNEL) return;
        try {
          const { origin, roomId } = JSON.parse(payload) as { origin: string; roomId: string };
          if (origin === this.origin) return;
          // Invalidate cache and push fresh snapshots to our local sockets.
          void this.invalidateAndBroadcast(roomId);
        } catch {
          /* ignore */
        }
      });
    }
  }

  registerSocket(roomId: string, ws: WebSocket): void {
    let set = this.sockets.get(roomId);
    if (!set) {
      set = new Set();
      this.sockets.set(roomId, set);
    }
    set.add({ ws, clientId: null });
    void this.pushSnapshot(roomId).catch(() => {});
  }

  bindClient(roomId: string, ws: WebSocket, clientId: string): void {
    const set = this.sockets.get(roomId);
    for (const entry of set ?? []) {
      if (entry.ws === ws) entry.clientId = clientId;
    }
    void this.pushSnapshot(roomId).catch(() => {});
  }

  unregisterSocket(roomId: string, ws: WebSocket): void {
    const set = this.sockets.get(roomId);
    if (!set) return;
    for (const entry of set) {
      if (entry.ws === ws) {
        set.delete(entry);
        break;
      }
    }
  }

  async handleMessage(roomId: string, ws: WebSocket, raw: unknown): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    const senderEntry = [...(this.sockets.get(roomId) ?? [])].find((e) => e.ws === ws);
    const clientId = senderEntry?.clientId;

    try {
      switch (msg.type) {
        case "game:create": {
          const existing = await this.store.load(roomId);
          if (!existing || existing.phase === "scored") {
            await this.persist(createGame(roomId));
            this.cache.delete(roomId);
          }
          break;
        }
        case "game:join": {
          const state = await this.requireState(roomId);
          joinGame(state, clientId!, String(msg.name ?? "?").slice(0, 32));
          await this.persist(state);
          break;
        }
        case "game:start": {
          const state = await this.requireState(roomId);
          startGame(state);
          await this.persist(state);
          break;
        }
        case "game:place": {
          const state = await this.requireState(roomId);
          placeCard(state, clientId!, msg.card, msg.lane);
          await this.expireIfDue(state);
          await this.persist(state);
          break;
        }
        case "game:discard": {
          const state = await this.requireState(roomId);
          discardCard(state, clientId!, msg.card);
          await this.persist(state);
          break;
        }
        case "game:ready": {
          const state = await this.requireState(roomId);
          setReady(state, clientId!, true);
          await this.maybeScore(state);
          await this.persist(state);
          break;
        }
        default:
          return;
      }

      await this.publishChanged(roomId);
      await this.pushSnapshot(roomId);
    } catch (err) {
      // Send error back to just this socket.
      try {
        ws.send(JSON.stringify({ type: "game:error", message: (err as Error).message }));
      } catch {}
    }
  }

  /**
   * Lazy timer expiry — called on every snapshot push. If deadline passed,
   * auto-play remaining players and advance.
   */
  async expireIfDue(state: GameState): Promise<boolean> {
    if (state.phase === "picking" && isExpired(state)) {
      expireTimer(state);
      await this.maybeScore(state);
      await this.publishChanged(state.roomId);
      return true;
    }
    return false;
  }

  private async maybeScore(state: GameState): Promise<void> {
    if (state.phase === "revealing") {
      // Small dramatic pause handled client-side; score immediately server-side.
      computeScores(state);
    }
  }

  private async requireState(roomId: string): Promise<GameState> {
    let state = this.cache.get(roomId);
    if (!state) {
      const loaded = await this.store.load(roomId);
      if (!loaded) throw new Error("no game in this room yet");
      state = loaded;
      this.cache.set(roomId, state);
    }
    await this.expireIfDue(state);
    return state;
  }

  private async persist(state: GameState): Promise<void> {
    await this.store.save(state);
  }

  private async publishChanged(roomId: string): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.publish(GAME_CHANNEL, JSON.stringify({ origin: this.origin, roomId }));
    } catch (err) {
      console.error("[game13] publish:", (err as Error).message);
    }
  }

  private async invalidateAndBroadcast(roomId: string): Promise<void> {
    this.cache.delete(roomId);
    await this.pushSnapshot(roomId);
  }

  /** Build per-player safe views and send each socket its own version. */
  async pushSnapshot(roomId: string): Promise<void> {
    const set = this.sockets.get(roomId);
    if (!set || set.size === 0) return;

    let state = this.cache.get(roomId) ?? (await this.store.load(roomId));
    if (!state) return;
    this.cache.set(roomId, state);

    // Lazy expiry on read path too.
    const expired = await this.expireIfDue(state);
    if (expired) {
      await this.persist(state);
      await this.publishChanged(roomId);
    }

    for (const entry of set) {
      if (entry.ws.readyState !== entry.ws.OPEN) continue;
      const view = this.safeView(state, entry.clientId);
      try {
        entry.ws.send(JSON.stringify({ type: "game:state", ...view }));
      } catch {}
    }
  }

  private safeView(state: GameState, forClientId: string | null) {
    const players = state.players.map((p): SafePlayerView => ({
      clientId: p.clientId,
      name: p.name,
      handCount: p.hand.length,
      placed: p.placed.map((pl) => ({ lane: pl.lane, card: pl.card })),
      ready: p.ready,
      online: p.online,
    }));

    // Reveal hands only when game over or when it's your own view.
    const revealAll = state.phase === "revealing" || state.phase === "scored";
    const me = state.players.find((p) => p.clientId === forClientId);

    return {
      phase: state.phase as Phase,
      round: state.round?.round ?? null,
      mustPlace: state.round?.mustPlace ?? 0,
      mustDiscard: state.round?.mustDiscard ?? false,
      deadlineMs: state.round?.deadlineMs ?? null,
      players,
      myHand: me && !revealAll ? me.hand : [],
      allHands:
        revealAll && state.finalLanes
          ? Object.fromEntries(
              Object.entries(state.finalLanes).map(([id, lanes]) => [
                id,
                { top: lanes.top.map(cardLabel), middle: lanes.middle.map(cardLabel), bottom: lanes.bottom.map(cardLabel) },
              ])
            )
          : null,
      scores: state.scores,
    };
  }
}

function cardLabel(c: Card2): string {
  return `${c.rank}${c.suit}`;
}

// Singleton per instance.
const g = globalThis as unknown as {
  __game13Hub?: GameHub;
  __presenceRedis?: Redis | null;
};
export function getGameHub(redis: Redis | null): GameHub {
  return (g.__game13Hub ??= new GameHub(redis));
}
