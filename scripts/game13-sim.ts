// Deterministic full-game engine sim: 4 players, 5 rounds, verify card accounting
// under the NEW rules (no discard UI; leftover hand swept at round end;
// round-end face-up pause between rounds).
// Run: npx tsx scripts/game13-sim.ts
import {
  createGame, joinGame, startGame, placeCard, unplaceCard, setReady,
  isRevealDue, advanceFromReveal,
} from "../src/lib/game13/engine";
import { GameState } from "../src/lib/game13/types";

function totalCards(s: GameState): number {
  const onBoard = s.players.reduce((n, p) => n + p.placed.length, 0);
  const inHands = s.players.reduce((n, p) => n + p.hand.length, 0);
  return onBoard + inHands + s.drawPile.length + s.discardPile.length;
}

const ids = ["a", "b", "c", "d"];
let s = createGame("sim");
for (const id of ids) joinGame(s, id, id);
s = startGame(s);

let roundNum = 0;
while (s.phase !== "revealing" || s.finalLanes === null) {
  if (s.phase !== "picking") break;
  roundNum = s.round!.round;
  let guard = 0;

  // Play: place mustPlace cards each (with one unplace/re-place to test pullback),
  // then ready. No discard action (new rules).
  while (guard++ < 300) {
    const allDone = s.players.every(
      (p) => p.placedThisRound >= s.round!.mustPlace && p.ready
    );
    if (allDone) break;
    for (const p of s.players) {
      while (p.placedThisRound < s.round!.mustPlace && p.hand.length > 0) {
        const caps = { top: 3, middle: 5, bottom: 5 } as const;
        const lane = (["bottom", "middle", "top"] as const).find(
          (l) => p.placed.filter((pl) => pl.lane === l).length < caps[l]
        );
        if (!lane) break;
        placeCard(s, p.clientId, p.hand[0], lane);
        // Test pull-back once per player per game (first placement of R2):
        if (roundNum === 2 && p.placedThisRound === 1 && !p.hand.includes(p.hand[0])) {
          const last = p.placed[p.placed.length - 1];
          unplaceCard(s, p.clientId, last.card, last.lane);
          placeCard(s, p.clientId, last.card, lane); // put it back
        }
      }
      if (p.placedThisRound >= s.round!.mustPlace && !p.ready) {
        setReady(s, p.clientId, true); // leftover card stays in hand — no discard needed
      }
    }
  }

  // Round ends → revealing pause → advance.
  const totalAfterRound = totalCards(s);
  console.log(
    `R${roundNum} done: phase=${s.phase} reveal=${s.revealUntilMs ? "yes" : "no"} totalCards=${totalAfterRound}` +
      (totalAfterRound !== 52 ? ` ⚠️ LEAK ${totalAfterRound - 52}` : " ✓")
  );
  const phaseAfter = s.phase as string;
  if (phaseAfter === "revealing") {
    (s as { revealUntilMs: number | null }).revealUntilMs = Date.now() - 1; // force due
    s = advanceFromReveal(s);
  }
  if (s.phase !== "picking") break;
}

const finalTotal = totalCards(s);
console.log(`final: phase=${s.phase} totalCards=${finalTotal}`);
if (finalTotal !== 52) {
  console.error("FAIL: cards lost");
  process.exit(1);
}
if (s.phase !== "revealing" || !s.finalLanes) {
  console.error("FAIL: game did not finish");
  process.exit(1);
}
console.log("SIM PASS ✓");
