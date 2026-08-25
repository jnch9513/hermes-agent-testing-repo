// Hand evaluation for 3-card and 5-card lanes (十三張).
//
// Lane hand types (high → low):
//   5-card: 同花順(straight flush) > 鐵支(four of a kind) > 葫蘆(full house)
//           > 同花(flush) > 順子(straight) > 三條(trips) > 兩對(two pair)
//           > 一對(pair) > 烏龍(high card)
//   3-card: 三條(trips) > 一對(pair) > 烏龍(high card)
//
// Straights: A2345 is the lowest, 10JQKA the highest. Ace plays high or low
// in straights only.

import { Card } from "./card";

export type HandCategory =
  | "straight_flush"
  | "four_of_a_kind"
  | "full_house"
  | "flush"
  | "straight"
  | "three_of_a_kind"
  | "two_pair"
  | "pair"
  | "high_card";

export interface HandValue {
  category: HandCategory;
  /** Ordered tiebreak ranks — most significant first (e.g. quads rank then kicker). */
  tiebreak: number[];
}

const CATEGORY_ORDER: Record<HandCategory, number> = {
  straight_flush: 8,
  four_of_a_kind: 7,
  full_house: 6,
  flush: 5,
  straight: 4,
  three_of_a_kind: 3,
  two_pair: 2,
  pair: 1,
  high_card: 0,
};

/** Compare two evaluated hands. Positive = a wins, negative = b wins, 0 = tie. */
export function compareHands(a: HandValue, b: HandValue): number {
  const catDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (catDiff !== 0) return catDiff;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function counts(cards: Card[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) ?? 0) + 1);
  return m;
}

/**
 * Detect a straight among sorted-unique ranks.
 * Returns the top rank of the straight for tiebreaks (A2345 → 5 as highest... 
 * actually convention: A2345 is the LOWEST straight; its tiebreak value uses 5-high
 * but must lose to every other straight. We encode it as [5,4,3,2,1] with the
 * trailing 1 marking ace-low so it compares below any 6-high straight's [6,5,4,3,2].
 */
function straightInfo(uniqueRanksDesc: number[]): number[] | null {
  if (uniqueRanksDesc.length < 5) return null;

  // Normal run check (A high): e.g. [14,13,12,11,10]
  let run = [uniqueRanksDesc[0]];
  for (let i = 1; i < uniqueRanksDesc.length; i++) {
    if (uniqueRanksDesc[i] === uniqueRanksDesc[i - 1] - 1) {
      run.push(uniqueRanksDesc[i]);
      if (run.length >= 5) return [run[0], run[1], run[2], run[3], run[4]];
    } else {
      run = [uniqueRanksDesc[i]];
    }
  }

  // Ace-low wheel: A,5,4,3,2 → encode below any normal straight.
  const set = new Set(uniqueRanksDesc);
  if (set.has(14) && set.has(5) && set.has(4) && set.has(3) && set.has(2)) {
    return [5, 4, 3, 2, 1]; // 1 marks ace-low; loses to [6,5,4,3,2] and above
  }

  return null;
}

export function evaluate5(cards: Card[]): HandValue {
  if (cards.length !== 5) throw new Error(`evaluate5 needs 5 cards, got ${cards.length}`);

  const ranksDesc = [...cards].sort((x, y) => y.rank - x.rank);
  const uniqDesc = [...new Set(ranksDesc.map((c) => c.rank))];
  const isFlush = cards.every((c) => c.suit === cards[0].suit);
  const cnt = counts(cards);
  const groupsDesc = [...cnt.entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([rank]) => rank);

  const sRun = straightInfo(uniqDesc);
  if (isFlush && sRun) return { category: "straight_flush", tiebreak: sRun };
  if (cnt.get(groupsDesc[0]) === 4) {
    return { category: "four_of_a_kind", tiebreak: [groupsDesc[0], groupsDesc[1]] };
  }
  if (cnt.get(groupsDesc[0]) === 3 && cnt.get(groupsDesc[1]) === 2) {
    return { category: "full_house", tiebreak: [groupsDesc[0], groupsDesc[1]] };
  }
  if (isFlush) {
    return { category: "flush", tiebreak: uniqDesc };
  }
  if (sRun) return { category: "straight", tiebreak: sRun };
  if (cnt.get(groupsDesc[0]) === 3) {
    const kickers = uniqDesc.filter((r) => r !== groupsDesc[0]);
    return { category: "three_of_a_kind", tiebreak: [groupsDesc[0], ...kickers] };
  }
  if (cnt.get(groupsDesc[0]) === 2 && cnt.get(groupsDesc[1]) === 2) {
    const pairs = uniqDesc.filter((r) => cnt.get(r) === 2).sort((a, b) => b - a);
    const kicker = uniqDesc.find((r) => cnt.get(r) === 1)!;
    return { category: "two_pair", tiebreak: [pairs[0], pairs[1], kicker] };
  }
  if (cnt.get(groupsDesc[0]) === 2) {
    const kickers = uniqDesc.filter((r) => r !== groupsDesc[0]);
    return { category: "pair", tiebreak: [groupsDesc[0], ...kickers] };
  }
  return { category: "high_card", tiebreak: uniqDesc };
}

export function evaluate3(cards: Card[]): HandValue {
  if (cards.length !== 3) throw new Error(`evaluate3 needs 3 cards, got ${cards.length}`);

  const uniqDesc = [...new Set(cards.map((c) => c.rank))].sort((a, b) => b - a);
  const cnt = counts(cards);

  if (uniqDesc.length === 1) return { category: "three_of_a_kind", tiebreak: uniqDesc };
  if (uniqDesc.length === 2) {
    const pairRank = uniqDesc.find((r) => cnt.get(r) === 2)!;
    const kicker = uniqDesc.find((r) => cnt.get(r) === 1)!;
    return { category: "pair", tiebreak: [pairRank, kicker] };
  }
  return { category: "high_card", tiebreak: uniqDesc };
}
