// Stage 1 unit tests for Lucky 13 pure logic.
// Run: npx tsx tests/game13/run.ts  (or node with tsx loader)

import { cardId, freshDeck, parseCardId, shuffled } from "../../src/lib/game13/card";
import { dealCards, moveToDiscard, newPiles } from "../../src/lib/game13/deck";
import { compareHands, evaluate3, evaluate5 } from "../../src/lib/game13/handEval";
import { validateLayout } from "../../src/lib/game13/validateLayout";
import { scoreGame } from "../../src/lib/game13/scoring";
import type { Card } from "../../src/lib/game13/card";

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

function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${msg} expected ${b} got ${a}`);
}

// ---- card helpers
const C = (rank: number, suit: Card["suit"]): Card => ({ rank, suit });

t("card: fresh deck has 52 unique cards", () => {
  const d = freshDeck();
  eq(d.length, 52);
  eq(new Set(d.map(cardId)).size, 52);
});

t("card: shuffle preserves cards", () => {
  const orig = freshDeck();
  const sh = shuffled(orig);
  eq(sh.length, 52);
  eq(new Set(sh.map(cardId)).size, 52);
});

t("card: parseCardId roundtrip", () => {
  const c = C(14, "♠");
  eq(parseCardId(cardId(c)), c);
  eq(parseCardId("99♠"), null);
});

// ---- deck / dealing rules
t("deck: deal empties draw pile before touching discard", () => {
  const p = newPiles();
  p.draw = [C(2, "♠"), C(3, "♠"), C(4, "♠")];
  p.discard = [C(5, "♥")];
  const dealt = dealCards(p, 3);
  eq(dealt.length, 3);
  eq(p.draw.length, 0);
  eq(p.discard.length, 1); // untouched — draw pile covered the deal
});

t("deck: refill from shuffled discard when draw runs out", () => {
  const p = newPiles();
  p.draw = [C(2, "♠")];
  p.discard = [C(5, "♥"), C(9, "♦")];
  const dealt = dealCards(p, 3);
  eq(dealt.length, 3);
  eq(p.draw.length, 0);
  eq(p.discard.length, 0); // all discards consumed (2 needed, 2 available)
});

t("deck: throws when total cards insufficient", () => {
  const p = newPiles();
  p.draw = [];
  p.discard = [C(5, "♥")];
  let threw = false;
  try {
    dealCards(p, 2);
  } catch {
    threw = true;
  }
  assert(threw, "should throw");
});

// ---- hand evaluation
t("eval5: straight flush beats quads", () => {
  const sf = { ...evaluate5([C(9, "♠"), C(10, "♠"), C(11, "♠"), C(12, "♠"), C(13, "♠")]) };
  const quad = { ...evaluate5([C(14, "♠"), C(14, "♥"), C(14, "♦"), C(14, "♣"), C(2, "♠")]) };
  assert(compareHands(sf, quad) > 0, "straight flush should beat four of a kind");
});

t("eval5: A2345 is lowest straight", () => {
  const wheel = evaluate5([C(14, "♠"), C(2, "♥"), C(3, "♦"), C(4, "♣"), C(5, "♠")]);
  const sixHigh = evaluate5([C(6, "♠"), C(2, "♥"), C(3, "♦"), C(4, "♣"), C(5, "♠")]);
  assert(compareHands(sixHigh, wheel) > 0, "6-high straight beats ace-low wheel");
  const broadway = evaluate5([C(10, "♠"), C(11, "♥"), C(12, "♦"), C(13, "♣"), C(14, "♠")]);
  assert(compareHands(broadway, wheel) > 0, "broadway beats wheel");
});

t("eval5: full house vs flush vs straight ordering", () => {
  const fh = evaluate5([C(8, "♠"), C(8, "♥"), C(8, "♦"), C(5, "♣"), C(5, "♠")]);
  const fl = evaluate5([C(14, "♠"), C(12, "♠"), C(9, "♠"), C(6, "♠"), C(2, "♠")]);
  const st = evaluate5([C(9, "♠"), C(10, "♥"), C(11, "♦"), C(12, "♣"), C(13, "♠")]);
  assert(compareHands(fh, fl) > 0, "full house > flush");
  assert(compareHands(fl, st) > 0, "flush > straight");
});

t("eval5: two pair tiebreak by higher pair then kicker", () => {
  const a = evaluate5([C(14, "♠"), C(14, "♥"), C(3, "♦"), C(3, "♣"), C(9, "♠")]);
  const b = evaluate5([C(13, "♠"), C(13, "♥"), C(12, "♦"), C(12, "♣"), C(2, "♠")]);
  assert(compareHands(a, b) > 0, "AA33 9 > KKQQ 2");
  const a2 = evaluate5([C(14, "♠"), C(14, "♥"), C(3, "♦"), C(3, "♣"), C(9, "♠")]);
  const b2 = evaluate5([C(14, "♠"), C(14, "♥"), C(3, "♦"), C(3, "♣"), C(8, "♠")]);
  assert(compareHands(a2, b2) > 0, "same pairs → kicker 9 beats 8");
});

t("eval3: trips > pair > high", () => {
  const trips = evaluate3([C(7, "♠"), C(7, "♥"), C(7, "♦")]);
  const pair = evaluate3([C(7, "♠"), C(7, "♥"), C(2, "♦")]);
  const high = evaluate3([C(14, "♠"), C(13, "♥"), C(2, "♦")]);
  assert(compareHands(trips, pair) > 0, "trips > pair");
  assert(compareHands(pair, high) > 0, "pair > high");
});

// ---- layout validation
const VALID: Parameters<typeof validateLayout>[0] = {
  top: [C(2, "♠"), C(2, "♥"), C(9, "♦")], // pair
  middle: [C(5, "♠"), C(6, "♠"), C(7, "♠"), C(8, "♠"), C(9, "♠")], // straight flush!
  bottom: [C(14, "♠"), C(14, "♥"), C(14, "♦"), C(14, "♣"), C(2, "♠")], // quads
};

t("validate: legal layout passes", () => {
  // NOTE: middle is a straight flush which beats bottom's quads → foul!
  // Use a weaker middle instead.
  const lanes = {
    top: [C(2, "♠"), C(2, "♥"), C(9, "♦")],
    middle: [C(5, "♠"), C(6, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // plain straight
    bottom: [C(14, "♠"), C(14, "♥"), C(14, "♦"), C(14, "♣"), C(2, "♠")],
  };
  const v = validateLayout(lanes);
  eq(v.foul, false, JSON.stringify(v.reasons));
});

t("validate: wrong lane sizes = foul", () => {
  const v = validateLayout({
    top: [C(2, "♠"), C(2, "♥")],
    middle: VALID.middle,
    bottom: VALID.bottom,
  });
  eq(v.foul, true);
});

t("validate: top pair beats middle pair-only? no — 相道 violation caught", () => {
  // top has trips, middle has only two pair → top > middle → foul
  const lanes = {
    top: [C(14, "♠"), C(14, "♥"), C(14, "♦")],
    middle: [C(5, "♠"), C(5, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")],
    bottom: [C(14, "♠"), C(14, "♥"), C(14, "♦"), C(14, "♣"), C(2, "♠")].map((c) => ({
      rank: c.rank === 14 ? 13 : c.rank,
      suit: c.suit,
    })),
  };
  const v = validateLayout(lanes);
  eq(v.foul, true);
  assert(v.reasons.some((r) => r.includes("頭道大過中道")), JSON.stringify(v.reasons));
});

// ---- scoring
t("score: simple lane wins 2 players", () => {
  const a = {
    playerId: "a",
    lanes: {
      top: [C(5, "♠"), C(5, "♥"), C(14, "♦")], // pair of 5s
      middle: [C(5, "♠"), C(6, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // straight
      bottom: [C(14, "♠"), C(14, "♥"), C(14, "♦"), C(14, "♣"), C(2, "♠")], // quads → 中鐵支? no bottom=尾鐵支 +4
    },
  };
  const b = {
    playerId: "b",
    lanes: {
      top: [C(3, "♠"), C(3, "♥"), C(14, "♦")], // pair of 3s
      middle: [C(2, "♦"), C(3, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // high card 9 — wait pair3 > high9? pair > high card → FOUL. Use pair in middle.
      bottom: [C(13, "♠"), C(13, "♥"), C(13, "♦"), C(13, "♣"), C(2, "♠")], // smaller quads 尾鐵支+4 for b... but loses lane
    },
  };
  b.lanes.middle = [C(4, "♦"), C(4, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")]; // pair 4s: top pair3 < mid pair4 < bottom quadsK ✓
  const result = scoreGame({ a: a.lanes, b: b.lanes });
  // a sweeps all 3 lanes → 打槍 ×2 = +6; bonus 尾鐵支+4; 全壘打 doubles swept
  // lanes again (+6) → 6+6+4 = 16. Zero-sum: b -16.
  eq(result.a.total, 16, `sweep+homerun+尾鐵支: ${JSON.stringify(result)}`);
  eq(result.b.total, -16);
});


t("score: 打槍 doubles lane points", () => {
  const a = {
    top: [C(14, "♠"), C(14, "♥"), C(2, "♦")],
    middle: [C(5, "♠"), C(6, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")],
    bottom: [C(14, "♦"), C(13, "♦"), C(12, "♦"), C(11, "♦"), C(10, "♦")], // royal flush ♦
  };
  const b = {
    top: [C(3, "♠"), C(3, "♥"), C(14, "♦")], // pair 3s
    middle: [C(4, "♦"), C(4, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // pair 4s > top pair ✓
    bottom: [C(2, "♥"), C(3, "♥"), C(4, "♥"), C(5, "♥"), C(6, "♥")], // 23456 hearts straight < SF ✓
  };
  const result = scoreGame({ a, b });
  // a sweeps → 打槍 ×2 = +6; 全壘打 doubles swept again → +6; 尾同花順 bonus +5
  // Engine gives 12 (6 scoop + 6 homerun) — bonus NOT included? Verify:
  // Per qywin99: bonus is separate from lane points and NOT doubled. Expected: 6+6+5=17.
  console.log("  actual:", JSON.stringify(result));
  eq(result.a.total, 17, `打槍+全壘打+尾SF bonus: ${JSON.stringify(result)}`);
  eq(result.b.total, -17);
});

t("score: fouled hand loses everything and pays bonuses", () => {
  const good = {
    top: [C(14, "♠"), C(14, "♥"), C(2, "♦")],
    middle: [C(5, "♠"), C(6, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // straight
    bottom: [C(14, "♦"), C(13, "♦"), C(12, "♦"), C(11, "♦"), C(10, "♦")], // SF → +5
  };
  // fouled: top trips bigger than middle pair
  const bad = {
    top: [C(14, "♠"), C(14, "♥"), C(14, "♦")],
    middle: [C(2, "♦"), C(2, "♥"), C(3, "♦"), C(4, "♣"), C(7, "♠")], // pair deuces < top trips → foul
    bottom: [C(2, "♠"), C(2, "♥"), C(3, "♦"), C(4, "♣"), C(7, "♠")],
  };
  const result = scoreGame({ good, bad });
  // foul: good wins 3 lanes (+3) + 尾SF bonus +5 = +8; bad pays it
  eq(result.good.total, 8, `foul+bonus: ${JSON.stringify(result)}`);
  eq(result.bad.total, -8);
  eq(result.bad.foul, true);
});

t("score: 衝三 bonus applies when head trips wins", () => {
  const a = {
    top: [C(14, "♠"), C(14, "♥"), C(14, "♦")], // trips in head!
    middle: [C(5, "♠"), C(6, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // 9-high straight > trips ✓
    bottom: [C(14, "♦"), C(13, "♦"), C(12, "♦"), C(11, "♦"), C(10, "♦")], // royal SF → +5
  };
  const b = {
    top: [C(3, "♠"), C(3, "♥"), C(14, "♦")], // pair 3s
    middle: [C(4, "♦"), C(4, "♥"), C(7, "♦"), C(8, "♣"), C(9, "♠")], // pair 4s > top pair ✓
    bottom: [C(2, "♥"), C(3, "♦"), C(4, "♥"), C(5, "♣"), C(6, "♥")], // mixed straight < SF ✓
  };
  const result = scoreGame({ a, b });
  // a sweeps: 打槍 ×2 = +6; 全壘打再×2 = +6; bonuses: 衝三+3, 尾同花順+5 → 20
  eq(result.a.total, 20, `衝三: ${JSON.stringify(result)}`);
  eq(result.b.total, -20);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
