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
  unplaceCard,
  discardCard,
  setReady,
  expireTimer,
  computeScores,
  isExpired,
  isRevealDue,
  advanceFromReveal,
  driveTransitions,
} from "./engine";
import { createGameStore, withLock, type GameStore } from "./redis-state";
import { GameState, Phase, PlayerGameView } from "./types";

const GAME_CHANNEL = "game13:events";

/** What a client sees: own hand in clear, others' hands hidden. */
export interface SafePlayerView {
  clientId: string;
  name: string;
  handCount: number;
  placedThisRound: number;
  placed: { lane: string; card: Card2 | null; round?: number }[];
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
      // All mutations serialize through a Redis lock keyed by room. Inside the
      // lock we always reload Redis truth (never trust the instance cache) so
      // multi-instance deployments can't double-deal via stale copies.
      await withLock(this.pub, roomId, async () => {
        // Pre-step: drive all lazy transitions (expired picking → face-up
        // reveal → next round / final scores) before handling this message.
        const preState = await this.store.load(roomId);
        if (preState && driveTransitions(preState)) {
          await this.persist(preState);
          await this.publishChanged(roomId);
        }

        switch (msg.type) {
          case "game:create": {
            const existing = await this.store.load(roomId);
            // Only create when there's no game at all. Scored games are reset by
            // 再嚟一鋪 flow via game:join (auto-restart); waiting/picking games
            // keep their seated players.
            if (!existing) {
              await this.persist(createGame(roomId));
              this.cache.delete(roomId);
            }
            break;
          }
          case "game:join": {
            if (!clientId) throw new Error("not identified yet (no hello)");
            let state = await this.store.load(roomId);
            // Auto-restart flow: joining a scored/absent game starts a fresh one.
            if (!state || state.phase === "scored") {
              state = createGame(roomId);
              await this.persist(state);
              this.cache.delete(roomId);
            }
            // Stale-game recovery: everyone left mid-game → start fresh.
            const allOffline =
              state.players.length > 0 && state.players.every((p) => !p.online);
            if (allOffline && state.phase !== "waiting") {
              state = createGame(roomId);
              await this.persist(state);
              this.cache.delete(roomId);
            }
            joinGame(state, clientId!, String(msg.name ?? "?").slice(0, 32));
            await this.persist(state);
            break;
          }
          case "game:start": {
            const state = await this.reloadForMutation(roomId);
            startGame(state);
            await this.persist(state);
            break;
          }
          case "game:place": {
            const state = await this.reloadForMutation(roomId);
            placeCard(state, clientId!, msg.card, msg.lane);
            await this.expireIfDue(state);
            await this.persist(state);
            break;
          }
          case "game:unplace": {
            const state = await this.reloadForMutation(roomId);
            unplaceCard(state, clientId!, msg.card, msg.lane);
            await this.expireIfDue(state);
            await this.persist(state);
            break;
          }
          case "game:discard": {
            const state = await this.reloadForMutation(roomId);
            discardCard(state, clientId!, msg.card);
            await this.persist(state);
            break;
          }
          case "game:ready": {
            const state = await this.reloadForMutation(roomId);
            setReady(state, clientId!, true);
            await this.maybeScore(state);
            await this.persist(state);
            break;
          }
          default:
            return;
        }
      });

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

  /**
   * Fresh state straight from Redis for a mutation (must be called while
   * holding the room lock). Refreshes the instance cache with the truth so
   * subsequent snapshots reflect the latest cross-instance writes.
   */
  private async reloadForMutation(roomId: string): Promise<GameState> {
    const state = await this.store.load(roomId);
    if (!state) throw new Error("no game in this room yet");
    this.cache.set(roomId, state);
    return state;
  }

  private async persist(state: GameState): Promise<void> {
    await this.store.save(state);
  }

  /** Mark a player offline in the game state (WS closed mid-game). */
  async markOffline(roomId: string, clientId: string): Promise<void> {
    const state = await this.reloadForMutation(roomId).catch(() => null);
    if (!state || state.phase === "waiting" || state.phase === "scored") return;
    const p = state.players.find((pl) => pl.clientId === clientId);
    if (!p?.online) return;
    await withLock(this.pub, roomId, async () => {
      // Re-read inside the lock in case someone else mutated meanwhile.
      const fresh = await this.store.load(roomId);
      if (!fresh) return;
      const fp = fresh.players.find((pl) => pl.clientId === clientId);
      if (!fp?.online) return;
      fp.online = false;
      await this.persist(fresh);
    });
    await this.publishChanged(roomId);
    await this.pushSnapshot(roomId);
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

    // Read path must also serialize — transitions mutate state (auto-play,
    // next-round deal, final scores) and would race across instances otherwise.
    const expired = await withLock(this.pub, roomId, async () => {
      const fresh = await this.store.load(roomId);
      if (!fresh) return false;
      this.cache.set(roomId, fresh);
      if (driveTransitions(fresh)) {
        await this.persist(fresh);
        return true; // publish outside the lock
      }
      return false;
    });
    if (expired) {
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
    const pickingRound = state.round?.round ?? null;
    const revealAll = state.phase === "revealing" || state.phase === "scored";

    const players = state.players.map((p): SafePlayerView => {
      const isSelf = p.clientId === forClientId;
      return {
        clientId: p.clientId,
        name: p.name,
        handCount: p.hand.length,
        placedThisRound: p.placedThisRound,
        placed: p.placed.map((pl) => ({
          lane: pl.lane,
          round: pl.round,
          // Realtime action visibility: while picking, OTHERS see this round's
          // fresh placements as face-down backs; own cards + older rounds
          // (already flipped at a previous round-end) stay visible.
          card:
            !revealAll && !isSelf && pl.round === pickingRound
              ? null
              : pl.card,
        })),
        ready: p.ready,
        online: p.online,
      };
    });

    // Own hand is always private-visible; revealing shows it too (it's swept
    // right after anyway).
    const me = state.players.find((p) => p.clientId === forClientId);

    return {
      phase: state.phase as Phase,
      round: state.round?.round ?? null,
      mustPlace: state.round?.mustPlace ?? 0,
      mustDiscard: state.round?.mustDiscard ?? false,
      deadlineMs: state.round?.deadlineMs ?? null,
      revealUntilMs: state.revealUntilMs,
      players,
      myHand: me?.hand ?? [],
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
