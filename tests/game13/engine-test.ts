// Stage 2 test: simulate a full 4-player game through the engine.
// Verifies the KC-confirmed invariants:
// - 4 players × 13 cards = 52, no duplicates
// - R1 deal 5 place 5; R2-4 deal 3 place 2 discard 1; R5 from discard pile only
// - Draw pile priority; discard shuffled before dealing from it
// - Pile accounting per round: 場上/牌堆/棄牌堆 matches KC's numbers

import { cardId } from "../../src/lib/game13/card";
import {
  createGame,
  joinGame,
  startGame,
  placeCard,
  discardCard,
  setReady,
  expireTimer,
  computeScores,
} from "../../src/lib/game13/engine";

let pass = 0;
let fail = 0;

function t(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`❌ ${name}: ${(e as Error).message}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Deterministic RNG so tests are reproducible. */
function makeRng() {
  let seed = 42;
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

const NAMES = ["KC", "阿明", "John", "Susan"];

t("full game: 4 players complete 5 rounds without issue", () => {
  const rng = makeRng();
  let state = createGame("poker-a");
  for (const n of NAMES) state = joinGame(state, `p-${n}`, n);
  state = startGame(state, rng);

  assert(state.phase === "picking", `phase after start: ${state.phase}`);
  assert(state.round?.round === 1, "round 1");

  // Per-round pile accounting (KC's numbers) — verified via snapshots.
  const snapshots: Record<number, any> = {};

  for (let round = 1; round <= 5; round++) {
    assert(state.round?.round === round, `on round ${state.round?.round}, want ${round}`);

    // Every player completes the round.
    for (const p of state.players) {
      const mustPlace = state.round!.mustPlace;
      const mustDiscard = state.round!.mustDiscard;

      // Place required cards: spread across lanes top/middle/bottom legally.
      const lanes = ["bottom", "middle", "top"] as const;
      while (p.placedThisRound < mustPlace && p.hand.length > 0) {
        const card = p.hand[0];
        let placedOk = false;
        for (const lane of lanes) {
          try {
            state = placeCard(state, p.clientId, card, lane);
            placedOk = true;
            break;
          } catch {
            continue; // lane full, try next
          }
        }
        if (!placedOk) throw new Error(`no lane capacity for ${JSON.stringify(card)} r${round}`);
      }

      if (mustDiscard) {
        assert(p.hand.length === 1, `r${round} ${p.clientId}: hand=${p.hand.length} before discard, want 1`);
        state = discardCard(state, p.clientId, p.hand[0]);
      }

      // Capture accounting BEFORE the final setReady — the last ready
      // triggers completeRound → beginRound which deals the next hand.
      if (p === state.players[state.players.length - 1]) {
        snapshots[round] = {
          table: state.players.reduce((n: number, q: any) => n + q.placed.length, 0),
          hands: state.players.reduce((n: number, q: any) => n + q.hand.length, 0),
          draw: state.drawPile.length,
          discard: state.discardPile.length,
        };
      }

      state = setReady(state, p.clientId, true);
    }

    // Verify pile accounting at ROUND END (before next deal) — KC's numbers.
    if (round === 1) {
      eq(snapshots[1], { table: 20, hands: 0, draw: 32, discard: 0 }, "r1 end");
    }
    if (round === 2) {
      eq(snapshots[2], { table: 28, hands: 0, draw: 20, discard: 4 }, "r2 end");
    }
    if (round === 3) {
      eq(snapshots[3], { table: 36, hands: 0, draw: 8, discard: 8 }, "r3 end");
    }
    if (round === 4) {
      eq(snapshots[4], { table: 44, hands: 0, draw: 0, discard: 8 }, "r4 end");
    }
    if (round === 5) {
      eq(snapshots[5], { table: 52, hands: 0, draw: 0, discard: 0 }, "r5 end");
    }

    // Round completed → next round began (or reveal on r5).
    if (round < 5) {
      assert(state.phase === "picking", `after r${round}: ${state.phase}`);
      assert(state.round?.round === round + 1, `advanced to r${state.round?.round}`);
    }
  }

  // Game over → revealing phase
  assert(state.phase === "revealing", `final phase: ${state.phase}`);

  // All players have exactly 13 placed cards.
  for (const p of state.players) {
    eq(p.placed.length, 13, `${p.clientId} placed`);
    eq(p.hand.length, 0, `${p.clientId} hand empty`);
  }

  // No duplicate cards anywhere.
  const allCards = state.players.flatMap((p) => p.placed.map((pl) => cardId(pl.card)));
  eq(new Set(allCards).size, 52, "unique 52 cards on table");

  // Compute scores.
  state = computeScores(state);
  assert(state.phase === "scored", `phase after scores: ${state.phase}`);
  const total = Object.values(state.scores ?? {}).reduce((a, b) => a + b, 0);
  eq(total, 0, "scores are zero-sum");
});

function eq(actual: unknown, expected: unknown, label = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${label}: expected ${b}, got ${a}`);
}

t("timer expiry auto-plays unfinished players", () => {
  const rng = makeRng();
  let state = createGame("poker-a");
  for (const n of NAMES) state = joinGame(state, `q-${n}`, n);
  state = startGame(state, rng);

  // Only first player acts; others idle until timer expires.
  const p0 = state.players[0];
  while (p0.placedThisRound < 5) {
    const card = p0.hand[0];
    for (const lane of ["bottom", "middle", "top"] as const) {
      try {
        state = placeCard(state, p0.clientId, card, lane);
        break;
      } catch {
        continue;
      }
    }
  }
  state = setReady(state, p0.clientId, true);

  // Others don't act. Simulate expiry by clearing deadline then expiring.
  if (state.round) state.round.deadlineMs = Date.now() - 1000;
  state = expireTimer(state, rng);

  // Expiry auto-plays everyone, completes r1, and deals r2.
  assert(state.round?.round === 2, `advanced to r${state.round?.round}`);
  assert(state.phase === "picking", `phase: ${state.phase}`);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
