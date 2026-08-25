// Scoring engine (標準十三張計分, no special hands in MVP).
//
// Per lane, every pair of players compares: winner +1 / loser -1 per opponent.
// 打槍 (scoop): beat ONE opponent in all 3 lanes → that head-to-head total ×2.
// 全壘打 (home run): beat EVERY opponent in all 3 lanes → extra ×2 on top.
// 加番 bonuses (applied per qualifying lane vs each opponent, MVP set):
//   衝三: 頭道三條 beats opponent → +3
//   中葫蘆: 中道葫蘆 → +2
//   中鐵支 +8 / 尾鐵支 +4
//   中同花順 +10 / 尾同花順 +5
// Fouled hand (烏龍): loses every lane as if high-card, and pays opponents'
// bonuses; cannot win any lane or bonus.

import { Card } from "./card";
import { compareHands, evaluate3, evaluate5 } from "./handEval";
import { ThreeLanes, validateLayout } from "./validateLayout";

export interface PlayerScore {
  playerId: string;
  /** Net score this game. */
  total: number;
  foul: boolean;
  foulReasons: string[];
}

/** Bonus points for a lane beating an opponent (MVP bonus set). */
function laneBonus(lane: "top" | "middle" | "bottom", cards: Card[]): number {
  const v = lane === "top" ? evaluate3(cards) : evaluate5(cards);
  switch (`${lane}:${v.category}`) {
    case "top:three_of_a_kind":
      return 3; // 衝三
    case "middle:full_house":
      return 2; // 中葫蘆
    case "middle:four_of_a_kind":
      return 8; // 中鐵支
    case "bottom:four_of_a_kind":
      return 4; // 尾鐵支
    case "middle:straight_flush":
      return 10; // 中同花順
    case "bottom:straight_flush":
      return 5; // 尾同花順
    default:
      return 0;
  }
}

interface LaneEval {
  foul: boolean;
  value: ReturnType<typeof evaluate3> | ReturnType<typeof evaluate5>;
  bonusBase: { top: number; middle: number; bottom: number };
}

function evalLanes(lanes: ThreeLanes): LaneEval {
  const validation = validateLayout(lanes);
  if (validation.foul) {
    return {
      foul: true,
      value: null as never,
      bonusBase: { top: 0, middle: 0, bottom: 0 },
    };
  }
  const bb = {
    top: laneBonus("top", lanes.top),
    middle: laneBonus("middle", lanes.middle),
    bottom: laneBonus("bottom", lanes.bottom),
  };
  return {
    foul: false,
    value: null as never,
    bonusBase: bb,
  };
}

/**
 * Score a complete game among all players.
 * Returns net score per player.
 */
export function scoreGame(
  hands: Record<string, ThreeLanes>
): Record<string, PlayerScore> {
  const ids = Object.keys(hands);
  const evals = new Map<string, LaneEval>();
  for (const id of ids) evals.set(id, evalLanes(hands[id]));

  const totals = new Map<string, number>(ids.map((id) => [id, 0]));

  // Pairwise lane comparison with scoop/home-run multipliers.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const ea = evals.get(a)!;
      const eb = evals.get(b)!;

      let deltaAB = 0; // net from a's perspective before multipliers
      if (ea.foul && eb.foul) {
        deltaAB = 0;
      } else if (ea.foul || eb.foul) {
        // Fouled player loses all three lanes: winner gets +3 lane points.
        deltaAB = ea.foul ? -3 : 3;
        const winner = ea.foul ? b : a;
        totals.set(winner, (totals.get(winner) ?? 0) + 3);
        totals.set(ea.foul ? a : b, (totals.get(ea.foul ? a : b) ?? 0) - 3);
        // Fouled player still PAYS the non-fouled one's bonuses.
        const wEvals = ea.foul ? eb : ea;
        let bonus = 0;
        for (const lane of ["top", "middle", "bottom"] as const) {
          bonus += wEvals.bonusBase[lane];
        }
        totals.set(winner, (totals.get(winner) ?? 0) + bonus);
        totals.set(ea.foul ? a : b, (totals.get(ea.foul ? a : b) ?? 0) - bonus);
      } else {
        const lanesA = hands[a];
        const lanesB = hands[b];

        const topCmp = compareHands(evaluate3(lanesA.top), evaluate3(lanesB.top));
        const midCmp = compareHands(evaluate5(lanesA.middle), evaluate5(lanesB.middle));
        const botCmp = compareHands(evaluate5(lanesA.bottom), evaluate5(lanesB.bottom));

        deltaAB =
          Math.sign(topCmp) + Math.sign(midCmp) + Math.sign(botCmp);

        // Bonuses only count for the player who WINS that lane.
        let bonusAB = 0; // from a's perspective
        if (topCmp > 0) bonusAB += ea.bonusBase.top;
        else if (topCmp < 0) bonusAB -= eb.bonusBase.top;
        if (midCmp > 0) bonusAB += ea.bonusBase.middle;
        else if (midCmp < 0) bonusAB -= eb.bonusBase.middle;
        if (botCmp > 0) bonusAB += ea.bonusBase.bottom;
        else if (botCmp < 0) bonusAB -= eb.bonusBase.bottom;

        // 打槍: sweep one opponent → lane points ×2 (bonuses unchanged).
        const swept = Math.sign(topCmp) !== 0 &&
          Math.sign(topCmp) === Math.sign(midCmp) &&
          Math.sign(midCmp) === Math.sign(botCmp);
        const lanePts = swept ? deltaAB * 2 : deltaAB;

        totals.set(a, (totals.get(a) ?? 0) + lanePts + bonusAB);
        totals.set(b, (totals.get(b) ?? 0) - lanePts - bonusAB);
        // 全壘打 is decided after the full round-robin below.
      }
    }
  }

  // 全壘打: player beats ALL opponents in all lanes → extra ×2 of their
  // pre-bonus pairwise earnings this game. Applied once per qualifier.
  for (const id of ids) {
    if (evals.get(id)!.foul) continue;
    const others = ids.filter((o) => o !== id);
    const beatsAll = others.every((o) => {
      const cmp = headToHeadSweep(hands[id], hands[o]);
      return cmp === 1;
    });
    if (beatsAll && others.length > 0) {
      // Home run: qualifier's swept earnings double AGAIN, and each opponent
      // pays the extra share too ("輸家則扣相應分數") — keeps the game zero-sum.
      for (const o of others) {
        const c = headToHeadLaneDelta(hands[id], hands[o]);
        const sweptPts = Math.abs(c) === 3 ? c * 2 : c;
        // Add the same amount once more to id, subtract from o.
        totals.set(id, (totals.get(id) ?? 0) + sweptPts);
        totals.set(o, (totals.get(o) ?? 0) - sweptPts);
      }
    }
  }

  const result: Record<string, PlayerScore> = {};
  for (const id of ids) {
    result[id] = {
      playerId: id,
      total: totals.get(id) ?? 0,
      foul: evals.get(id)!.foul,
      foulReasons: validateLayout(hands[id]).reasons,
    };
  }
  return result;
}

/** +1 if a sweeps b in all lanes, -1 if b sweeps a, else 0. */
function headToHeadSweep(a: ThreeLanes, b: ThreeLanes): number {
  const t = Math.sign(compareHands(evaluate3(a.top), evaluate3(b.top)));
  const m = Math.sign(compareHands(evaluate5(a.middle), evaluate5(b.middle)));
  const bo = Math.sign(compareHands(evaluate5(a.bottom), evaluate5(b.bottom)));
  if (t === m && m === bo && t !== 0) return t;
  return 0;
}

/** Raw lane delta (+3..-3) between two non-fouled players. */
function headToHeadLaneDelta(a: ThreeLanes, b: ThreeLanes): number {
  const t = Math.sign(compareHands(evaluate3(a.top), evaluate3(b.top)));
  const m = Math.sign(compareHands(evaluate5(a.middle), evaluate5(b.middle)));
  const bo = Math.sign(compareHands(evaluate5(a.bottom), evaluate5(b.bottom)));
  return t + m + bo;
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}
