// Lucky 13 game engine — pure-ish state transitions.
// All functions take state and return new state (or mutate + return for perf);
// they never touch network/Redis directly. The hub persists after each call.

import { Card, cardId } from "./card";
import { dealCards, moveToDiscard, newPiles, Piles } from "./deck";
import {
  GameState,
  LANE_CAPACITY,
  Phase,
  PlayerGameView,
  ROUND_PLAN,
  ROUND_SECONDS,
  RoundInfo,
} from "./types";
import { scoreGame } from "./scoring";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

function findPlayer(state: GameState, clientId: string): PlayerGameView | undefined {
  return state.players.find((p) => p.clientId === clientId);
}

/** Cards still in this player's hand that are NOT yet placed or discarded. */
function handCount(p: PlayerGameView): number {
  return p.hand.length;
}

/** Create a fresh waiting-state game. */
export function createGame(roomId: string): GameState {
  return {
    roomId,
    phase: "waiting",
    players: [],
    drawPile: [],
    discardPile: [],
    round: null,
    finalLanes: null,
    scores: null,
    createdAt: Date.now(),
  };
}

export function joinGame(state: GameState, clientId: string, name: string): GameState {
  if (state.phase !== "waiting") throw new Error("game already started");
  if (state.players.some((p) => p.clientId === clientId)) return state; // rejoin = no-op
  if (state.players.length >= MAX_PLAYERS) throw new Error("table full (4)");
  state.players.push({
    clientId,
    name,
    hand: [],
    placed: [],
    placedThisRound: 0,
    ready: false,
    online: true,
  });
  return state;
}

export function leaveGame(state: GameState, clientId: string): GameState {
  if (state.phase === "waiting") {
    state.players = state.players.filter((p) => p.clientId !== clientId);
  } else {
    // Mid-game leaving marks offline; timer auto-plays their turns.
    const p = findPlayer(state, clientId);
    if (p) p.online = false;
  }
  return state;
}

/** Start the game: needs 2-4 players, deals round 1. */
export function startGame(state: GameState, rng: () => number = Math.random): GameState {
  if (state.phase !== "waiting") throw new Error("already started");
  if (state.players.length < MIN_PLAYERS) throw new Error(`need ${MIN_PLAYERS}+ players`);
  const piles = newPiles(rng);
  state.drawPile = piles.draw;
  state.discardPile = piles.discard;
  return beginRound(state, 1, rng);
}

/** Deal cards for a round and set the picking phase with a deadline. */
function beginRound(state: GameState, roundNum: number, rng: () => number): GameState {
  const plan = ROUND_PLAN[roundNum - 1];
  const perPlayer = plan.deal;

  // Deal for ALL players from a single shared piles view so draw-priority and
  // discard-refill work across the whole table, then assign per player.
  if (roundNum === 5) {
    // Final round: shuffle remaining discards and deal them all evenly
    // (規則: R5 直接由棄牌堆派，派出前必須洗牌).
    const shuffledDiscard = [...state.discardPile];
    for (let i = shuffledDiscard.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffledDiscard[i], shuffledDiscard[j]] = [shuffledDiscard[j], shuffledDiscard[i]];
    }
    const perPlayer5 = Math.floor(shuffledDiscard.length / state.players.length);
    let idx = 0;
    for (const p of state.players) {
      p.hand.push(...shuffledDiscard.slice(idx, idx + perPlayer5));
      idx += perPlayer5;
      p.placedThisRound = 0;
      p.ready = false;
    }
    state.discardPile = shuffledDiscard.slice(idx);
  } else {
    const piles: Piles = { draw: state.drawPile, discard: state.discardPile };
    for (const p of state.players) {
      const dealt = perPlayer > 0 ? dealCards(piles, perPlayer, rng) : [];
      p.hand.push(...dealt);
      p.placedThisRound = 0;
      p.ready = false;
    }
    // Write back mutated pile arrays (dealCards splices/reassigns).
    state.drawPile = piles.draw;
    state.discardPile = piles.discard;
  }

  state.round = {
    round: roundNum,
    dealCounts: Object.fromEntries(state.players.map((p) => [p.clientId, perPlayer])),
    deadlineMs: Date.now() + ROUND_SECONDS * 1000,
    mustPlace: plan.mustPlace,
    mustDiscard: plan.mustDiscard,
  };
  state.phase = "picking";
  return state;
}

/**
 * Place a card from hand into a lane. Card is immediately public.
 * Placed cards cannot be moved (規則: 擺左落去嘅牌係冇得變).
 */
export function placeCard(
  state: GameState,
  clientId: string,
  card: Card,
  lane: "top" | "middle" | "bottom"
): GameState {
  assertPicking(state);
  const p = requirePlayer(state, clientId);
  const idx = p.hand.findIndex((c) => cardId(c) === cardId(card));
  if (idx === -1) throw new Error("card not in your hand");

  // Lanes are PER PLAYER (each player owns 頭3/中5/尾5).
  const laneUsed = p.placed.filter((pl) => pl.lane === lane).length;
  if (laneUsed >= LANE_CAPACITY[lane]) {
    throw new Error(`your ${lane} lane full`);
  }

  const roundMustPlace = state.round?.mustPlace ?? 0;
  if (p.placedThisRound >= roundMustPlace) {
    throw new Error(`you can only place ${roundMustPlace} cards this round`);
  }

  p.hand.splice(idx, 1);
  p.placed.push({ lane, card });
  p.placedThisRound++;

  maybeCompleteRound(state);
  return state;
}

/** Discard one card from hand (rounds 2-4: exactly 1 per round). */
export function discardCard(state: GameState, clientId: string, card: Card): GameState {
  assertPicking(state);
  const p = requirePlayer(state, clientId);
  const idx = p.hand.findIndex((c) => cardId(c) === cardId(card));
  if (idx === -1) throw new Error("card not in your hand");
  if (!state.round?.mustDiscard) throw new Error("no discard allowed this round");
  if (p.placedThisRound < (state.round.mustPlace ?? 0)) {
    throw new Error("place your cards before discarding");
  }

  const [removed] = p.hand.splice(idx, 1);
  moveToDiscard({ draw: state.drawPile, discard: state.discardPile }, [removed]);

  maybeCompleteRound(state);
  return state;
}

export function setReady(state: GameState, clientId: string, ready: boolean): GameState {
  assertPicking(state);
  const p = requirePlayer(state, clientId);
  // Ready only counts when the player has finished all required actions.
  if (ready && !playerRoundDone(p, state.round!)) {
    throw new Error("finish placing/discarding first");
  }
  p.ready = ready;
  maybeCompleteRound(state);
  return state;
}

function playerRoundDone(p: PlayerGameView, round: RoundInfo): boolean {
  const placedOk = p.placedThisRound >= round.mustPlace;
  const discardOk = !round.mustDiscard || handCount(p) === 0;
  return placedOk && discardOk;
}

function maybeCompleteRound(state: GameState): void {
  if (!state.round || state.phase !== "picking") return;
  const allDone =
    state.players.length > 0 &&
    state.players.every((p) => playerRoundDone(p, state.round!) && p.ready);
  if (allDone) completeRound(state);
}

/** Called when timer expires: auto-play anyone not finished. */
export function expireTimer(state: GameState, rng: () => number = Math.random): GameState {
  if (state.phase !== "picking" || !state.round) return state;

  for (const p of state.players) {
    // Auto-place up to mustPlace using simple heuristic: fill bottom→middle→top
    while (p.placedThisRound < state.round.mustPlace && p.hand.length > 0) {
      const before = p.hand.length;
      for (const lane of ["bottom", "middle", "top"] as const) {
        const laneUsed = p.placed.filter((pl) => pl.lane === lane).length;
        if (laneUsed >= LANE_CAPACITY[lane]) continue;
        placeCardInternal(state, p, p.hand[p.hand.length - 1], lane);
        break;
      }
      if (p.hand.length === before) break; // no lane could take a card
    }
    if (state.round.mustDiscard && p.hand.length > 0) {
      const [discarded] = p.hand.splice(0, 1);
      moveToDiscard({ draw: state.drawPile, discard: state.discardPile }, [discarded]);
    }
    p.ready = true;
  }
  completeRound(state);
  return state;
}

function placeCardInternal(
  state: GameState,
  p: PlayerGameView,
  card: Card,
  lane: "top" | "middle" | "bottom"
): void {
  const idx = p.hand.findIndex((c) => cardId(c) === cardId(card));
  if (idx === -1) return;
  const laneUsed = p.placed.filter((pl) => pl.lane === lane).length;
  if (laneUsed >= LANE_CAPACITY[lane]) return;
  p.hand.splice(idx, 1);
  p.placed.push({ lane, card });
}

function completeRound(state: GameState): void {
  const roundNum = state.round!.round;
  // Move this round's placed cards into persistent per-player lane tracking:
  // we keep them inside `placed` until game end, then split by lane.

  if (roundNum >= 5) {
    finishGame(state);
  } else {
    beginRound(state, roundNum + 1, Math.random);
  }
}


function finishGame(state: GameState): void {
  const finalLanes: Record<string, { top: Card[]; middle: Card[]; bottom: Card[] }> = {};
  for (const p of state.players) {
    const lanes = { top: [] as Card[], middle: [] as Card[], bottom: [] as Card[] };
    for (const pl of p.placed) lanes[pl.lane].push(pl.card);
    finalLanes[p.clientId] = lanes;
  }
  state.finalLanes = finalLanes;
  state.scores = null;
  state.phase = "revealing";
}

/** Compute scores once revealing is done (called by hub after reveal delay). */
export function computeScores(state: GameState): GameState {
  if (state.phase !== "revealing" || !state.finalLanes) throw new Error("not in reveal phase");
  const result = scoreGame(state.finalLanes);
  state.scores = Object.fromEntries(
    Object.entries(result).map(([id, s]) => [id, s.total])
  );
  state.phase = "scored";
  return state;
}

// ---- helpers

function assertPicking(state: GameState): void {
  if (state.phase !== "picking") throw new Error("not in picking phase");
}

function requirePlayer(state: GameState, clientId: string): PlayerGameView {
  const p = findPlayer(state, clientId);
  if (!p) throw new Error("you are not in this game");
  return p;
}

/** Is the current round's deadline passed? (Lazy check against Redis truth.) */
export function isExpired(state: GameState, nowMs: number = Date.now()): boolean {
  return !!state.round?.deadlineMs && nowMs > state.round.deadlineMs;
}
