// Game state types for Lucky 13 (幸運十三張).
// Server-side truth; serialized to Redis as JSON.

import type { Card } from "./card";

export type Phase =
  | "waiting" // players joining, not started
  | "dealing" // brief transition: cards dealt, shown to owners
  | "picking" // main phase: place/discard within timer
  | "revealing" // all hands revealed (post round 5)
  | "scored"; // final scores computed and shown

export type Lane = "top" | "middle" | "bottom";

export interface PlayerGameView {
  clientId: string;
  name: string;
  /** Cards currently in hand (only meaningful for the owning player's view). */
  hand: Card[];
  /** Cards placed on the board so far — public info. */
  placed: { lane: Lane; card: Card }[];
  /** Cards placed THIS round (reset each deal). */
  placedThisRound: number;
  ready: boolean;
  online: boolean;
}

export interface RoundInfo {
  round: number; // 1..5
  dealCounts: Record<string, number>; // per player this round
  deadlineMs: number | null; // epoch ms; null = no active timer
  /** How many cards each player must place this round. */
  mustPlace: number;
  /** Whether discarding is required after placing (rounds 2-4). */
  mustDiscard: boolean;
}

export interface GameState {
  roomId: string;
  phase: Phase;
  players: PlayerGameView[];
  drawPile: Card[];
  discardPile: Card[];
  round: RoundInfo | null;
  /** Per-player lanes once all 13 cards are down (post game). */
  finalLanes: Record<string, { top: Card[]; middle: Card[]; bottom: Card[] }> | null;
  scores: Record<string, number> | null;
  createdAt: number;
}

/** Server-side per-player secret state (never sent to other players). */
export interface PlayerSecret {
  clientId: string;
  name: string;
}

export const ROUND_PLAN = [
  { round: 1, deal: 5, mustPlace: 5, mustDiscard: false },
  { round: 2, deal: 3, mustPlace: 2, mustDiscard: true },
  { round: 3, deal: 3, mustPlace: 2, mustDiscard: true },
  { round: 4, deal: 3, mustPlace: 2, mustDiscard: true },
  { round: 5, deal: 0, mustPlace: 2, mustDiscard: false }, // dealt from discard pile only
] as const;

export const ROUND_SECONDS = 30;

/** Max cards per lane across the whole game. */
export const LANE_CAPACITY: Record<Lane, number> = {
  top: 3,
  middle: 5,
  bottom: 5,
};
