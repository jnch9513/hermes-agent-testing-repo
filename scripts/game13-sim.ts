// Deterministic full-game engine sim: 4 players, 5 rounds, verify card accounting.
// Run: npx tsx scripts/game13-sim.ts
import { createGame, joinGame, startGame, placeCard, discardCard, setReady } from "../src/lib/game13/engine";
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

for (let round = 1; round <= 5; round++) {
  // Play until every player has placed mustPlace (+discard if required), then ready.
  let guard = 0;
  while (guard++ < 200) {
    const allDone = s.players.every((p) => {
      if (!s.round) return true;
      return p.placedThisRound >= s.round.mustPlace && (!s.round.mustDiscard || p.hand.length === 0);
    });
    if (allDone) break;
    for (const p of s.players) {
      if (!s.round) continue;
      while (p.placedThisRound < s.round.mustPlace && p.hand.length > 0) {
        const caps = { top: 3, middle: 5, bottom: 5 } as const;
        const lane = (["bottom", "middle", "top"] as const).find(
          (l) => p.placed.filter((pl) => pl.lane === l).length < caps[l]
        );
        if (!lane) break;
        try {
          placeCard(s, p.clientId, p.hand[0], lane);
        } catch {
          break;
        }
      }
      if (s.round.mustDiscard && p.placedThisRound >= s.round.mustPlace && p.hand.length > 0) {
        discardCard(s, p.clientId, p.hand[0]);
      }
    }
  }
  for (const p of s.players) setReady(s, p.clientId, true);
  const total = totalCards(s);
  console.log(
    `after R${round}: phase=${s.phase} round=${s.round?.round ?? "-"} totalCards=${total}` +
      (total !== 52 ? ` ⚠️ CARD LEAK (${52 - total})` : " ✓")
  );
  if (s.phase !== "picking") break;
}
console.log("final:", s.phase, "| scores computed by hub after reveal");
if (totalCards(s) !== 52) {
  console.error("FAIL: cards lost");
  process.exit(1);
}
console.log("SIM PASS ✓");
