// Lane layout validation (相道 / 3-5-5 rules).
//
// Rules (confirmed with KC):
// - Lanes must be exactly 頭道 3 / 中道 5 / 尾道 5 cards.
// - Lane strength must be non-decreasing head → middle → tail
//   (頭道 ≤ 中道 ≤ 尾道). Violation = 烏龍 (fouled hand).
// - The check happens only when ALL players have completed 13 cards.

import { Card } from "./card";
import { compareHands, evaluate3, evaluate5 } from "./handEval";

export const LANE_SIZES = { top: 3, middle: 5, bottom: 5 } as const;

export interface LayoutValidation {
  /** true = fouled (烏龍): wrong lane sizes or lanes out of order. */
  foul: boolean;
  reasons: string[];
}

export interface ThreeLanes {
  top: Card[]; // 頭道, 3 cards
  middle: Card[]; // 中道, 5 cards
  bottom: Card[]; // 尾道, 5 cards
}

export function validateLayout(lanes: ThreeLanes): LayoutValidation {
  const reasons: string[] = [];

  if (
    lanes.top.length !== LANE_SIZES.top ||
    lanes.middle.length !== LANE_SIZES.middle ||
    lanes.bottom.length !== LANE_SIZES.bottom
  ) {
    reasons.push(
      `lane sizes must be 3-5-5, got ${lanes.top.length}-${lanes.middle.length}-${lanes.bottom.length}`
    );
    return { foul: true, reasons };
  }

  const top = evaluate3(lanes.top);
  const middle = evaluate5(lanes.middle);
  const bottom = evaluate5(lanes.bottom);

  if (compareHands(top, middle) > 0) {
    reasons.push("頭道大過中道（相道）");
  }
  if (compareHands(middle, bottom) > 0) {
    reasons.push("中道大過尾道（相道）");
  }

  return { foul: reasons.length > 0, reasons };
}
