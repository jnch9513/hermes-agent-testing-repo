// Playing card representation for Lucky 13 (十三張).
// Ranks: 2-14 where 14 = Ace (A high by default; straights handle A-low too).

export const SUITS = ["♠", "♥", "♦", "♣"] as const;
export type Suit = (typeof SUITS)[number];

export interface Card {
  /** 2-14, 14 = Ace */
  rank: number;
  suit: Suit;
}

/** Unique id for a card — stable across serialization (e.g. "14♠"). */
export function cardId(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function parseCardId(id: string): Card | null {
  const m = id.match(/^(\d+)([♠♥♦♣])$/);
  if (!m) return null;
  const rank = Number(m[1]);
  if (rank < 2 || rank > 14) return null;
  return { rank, suit: m[2] as Suit };
}

/** Full 52-card deck. */
export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

export const RANK_LABELS: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

export function cardLabel(card: Card): string {
  return `${RANK_LABELS[card.rank]}${card.suit}`;
}

/** Fisher-Yates shuffle (returns new array; does not mutate input). */
export function shuffled(cards: Card[], rng: () => number = Math.random): Card[] {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
