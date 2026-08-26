// Lucky 13 game engine — pure-ish state transitions.
// All functions take state and return new state (or mutate + return for perf);
// they never touch network/Redis directly. The hub persists after each call.

import { Card, cardId } from "./card";
import { dealCards, moveToDiscard, newPiles, Piles } from "./deck";
import {
  GameState,
  LANE_CAPACITY,
  Lane,
  Phase,
  PlayerGameView,
  REVEAL_PAUSE_MS,
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
    revealUntilMs: null,
    pendingNextRound: null,
    finalLanes: null,
    scores: null,
    createdAt: Date.now(),
  };
}

export function joinGame(state: GameState, clientId: string, name: string): GameState {
  if (state.phase !== "waiting") throw new Error("game already started");
  if (!clientId) throw new Error("not identified yet (no hello)"); // ghost-seat guard
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
  p.placed.push({ lane, card, round: state.round?.round });
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

/**
 * Pull a card back from a lane into hand. Only THIS round's placements are
 * adjustable (規則: 舊回合擺嘅牌唔郁得). Unlimited re-adjusts within the round.
 */
export function unplaceCard(state: GameState, clientId: string, card: Card, lane: Lane): GameState {
  assertPicking(state);
  const p = requirePlayer(state, clientId);
  if (!state.round) throw new Error("no active round");
  const idx = p.placed.findIndex(
    (pl) => pl.lane === lane && pl.card && cardId(pl.card) === cardId(card)
  );
  if (idx === -1) throw new Error("card not in that lane");
  if ((p.placed[idx].round ?? state.round.round) !== state.round.round) {
    throw new Error("only this round's cards can be pulled back");
  }
  const [entry] = p.placed.splice(idx, 1);
  p.hand.push(entry.card);
  p.placedThisRound = Math.max(0, p.placedThisRound - 1);
  p.ready = false;
  return state;
}

export function setReady(state: GameState, clientId: string, ready: boolean): GameState {
  assertPicking(state);
  const p = requirePlayer(state, clientId);
  // Ready only counts when the player has finished all required actions.
  // Discard requirement is satisfied implicitly: the leftover card stays in
  // hand until round end (no discard UI — KC).
  if (ready && !playerRoundDone(p, state.round!)) {
    throw new Error("finish placing first");
  }
  p.ready = ready;
  maybeCompleteRound(state);
  return state;
}

function playerRoundDone(p: PlayerGameView, round: RoundInfo): boolean {
  // mustDiscard no longer blocks readiness: the leftover card rides in hand
  // and is swept to the discard pile at completeRound.
  return p.placedThisRound >= round.mustPlace;
}

/**
 * Sweep each player's leftover hand into the discard pile at round end
 * (R2-4: the undiscarded 3rd card; R5/others: normally empty already).
 */
function sweepHandsToDiscard(state: GameState): void {
  for (const p of state.players) {
    if (p.hand.length > 0) {
      moveToDiscard({ draw: state.drawPile, discard: state.discardPile }, p.hand);
      p.hand = [];
    }
  }
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

  const mustPlace = state.round.mustPlace;
  for (const p of state.players) {
    if (p.placedThisRound < mustPlace) {
      // Auto-place the rest: fill lanes bottom→middle→top (KC: 未擺哂 幫佢 random).
      while (p.placedThisRound < mustPlace && p.hand.length > 0) {
        const before = p.hand.length;
        for (const lane of ["bottom", "middle", "top"] as const) {
          const laneUsed = p.placed.filter((pl) => pl.lane === lane).length;
          if (laneUsed >= LANE_CAPACITY[lane]) continue;
          placeCardInternal(state, p, p.hand[p.hand.length - 1], lane);
          break;
        }
        if (p.hand.length === before) break; // no lane could take a card
      }
    }
    // Leftover hand rides until round end — sweepHandsToDiscard handles it.
    p.ready = true;
    void rng;
  }
  completeRound(state);
  return state;
}

function placeCardInternal(
  state: GameState,
  p: PlayerGameView,
  card: Card,
  lane: Lane
): void {
  const idx = p.hand.findIndex((c) => cardId(c) === cardId(card));
  if (idx === -1) return;
  const laneUsed = p.placed.filter((pl) => pl.lane === lane).length;
  if (laneUsed >= LANE_CAPACITY[lane]) return;
  p.hand.splice(idx, 1);
  p.placed.push({ lane, card, round: state.round?.round });
}

function completeRound(state: GameState): void {
  const roundNum = state.round!.round;
  // Sweep leftover hands to discard (R2-4: undiscarded 3rd card stays in hand
  // until round end — no discard UI, KC). Then flip all placements face-up:
  // phase=revealing shows every card to everyone for REVEAL_PAUSE_MS before
  // the next round is dealt.
  sweepHandsToDiscard(state);
  if (roundNum >= 5) {
    finishGame(state);
    return;
  }
  state.phase = "revealing";
  state.revealUntilMs = Date.now() + REVEAL_PAUSE_MS;
  state.pendingNextRound = roundNum + 1;
}

/** Is the round-end face-up pause over? */
export function isRevealDue(state: GameState, nowMs: number = Date.now()): boolean {
  return (
    state.phase === "revealing" &&
    state.revealUntilMs !== null &&
    !state.finalLanes && // game-over reveal is handled by scoring, not the pause
    nowMs >= state.revealUntilMs
  );
}

/** After the face-up pause: deal the next round. */
export function advanceFromReveal(state: GameState, rng: () => number = Math.random): GameState {
  if (!isRevealDue(state)) return state;
  const next = state.pendingNextRound;
  state.revealUntilMs = null;
  state.pendingNextRound = null;
  if (next !== null && next >= 2 && next <= 5) {
    beginRound(state, next, rng);
  } else {
    // Nothing pending — shouldn't happen, but don't wedge the room.
    finishGame(state);
  }
  return state;
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

/**
 * Lazy transition driver, called on every locked mutation/read:
 *  - picking + deadline passed → auto-play stragglers, enter face-up reveal
 *  - revealing (mid-game) + pause over → deal next round
 *  - revealing (game over) + pause over → compute final scores
 */
export function driveTransitions(state: GameState): boolean {
  let changed = false;
  if (state.phase === "picking" && isExpired(state)) {
    expireTimer(state);
    changed = true;
  }
  if (state.phase === "revealing") {
    const due = state.revealUntilMs === null || Date.now() >= state.revealUntilMs;
    if (!due) return changed;
    if (state.finalLanes) {
      // Game over: pause elapsed → show scores.
      computeScores(state);
      changed = true;
    } else {
      advanceFromReveal(state);
      changed = true;
    }
  }
  return changed;
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
