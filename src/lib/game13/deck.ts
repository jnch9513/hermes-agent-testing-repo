// Deck manager: draw pile + discard pile with Lucky 13 refill rules.
//
// Rules (confirmed with KC):
// - Deal from the draw pile first; it must be emptied before touching discards.
// - When the draw pile can't cover the full deal, deal what it has, then shuffle
//   the discard pile and deal the remainder from it.
// - Every time cards are dealt FROM the discard pile, it must be shuffled first.

import { Card, freshDeck, shuffled } from "./card";

export interface Piles {
  draw: Card[];
  discard: Card[];
}

export function newPiles(rng: () => number = Math.random): Piles {
  return { draw: shuffled(freshDeck(), rng), discard: [] };
}

export function moveToDiscard(piles: Piles, cards: Card[]): void {
  piles.discard.push(...cards);
}

/**
 * Deal `count` cards following the priority rules.
 * Returns just the dealt cards. Mutates piles.
 */
export function dealCards(piles: Piles, count: number, rng: () => number = Math.random): Card[] {
  const dealt: Card[] = [];

  // 1) Draw pile first — must be fully emptied before discards are touched.
  const fromDraw = Math.min(count, piles.draw.length);
  if (fromDraw > 0) {
    dealt.push(...piles.draw.splice(0, fromDraw));
  }

  // 2) Remainder from a freshly-shuffled discard pile.
  const remaining = count - dealt.length;
  if (remaining > 0) {
    if (piles.discard.length < remaining) {
      throw new Error(
        `not enough cards: need ${remaining} more but discard pile only has ${piles.discard.length}`
      );
    }
    const shuffledDiscard = shuffled(piles.discard, rng);
    dealt.push(...shuffledDiscard.slice(0, remaining));
    piles.discard = shuffledDiscard.slice(remaining);
  }

  return dealt;
}
