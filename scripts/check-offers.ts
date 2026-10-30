// Self-check for THE WALK bill maths.  Run:  node scripts/check-offers.ts
// (Node strips the types natively; there is no test runner in this repo.)
import assert from "node:assert/strict";
import { tierPct, priceBill, CLOCK_OFF } from "../lib/offers.ts";

// Buy 2 = 20% · Buy 3 = 25% · Buy 4 or more = 30%
for (const [pieces, pct] of [[0, 0], [1, 0], [2, 20], [3, 25], [4, 30], [5, 30], [12, 30]])
  assert.equal(tierPct(pieces), pct, `${pieces} pieces`);
assert.equal(CLOCK_OFF, 100);

const bill = (subtotal: number, pieces: number, o: Partial<{ discount: string; tierDismissed: boolean; clockWon: boolean }> = {}) =>
  priceBill({ subtotal, pieces, discount: o.discount ?? "0", tierDismissed: o.tierDismissed ?? false, clockWon: o.clockWon ?? false });

// [subtotal, pieces, options, offTier, offClock, typed discount kept, total]
const cases: [number, number, Parameters<typeof bill>[2], number, number, number, number][] = [
  [1299, 1, {}, 0, 0, 0, 1299],                                   // one piece: no offer
  [2000, 2, {}, 400, 0, 0, 1600],                                 // buy 2: 20%
  [3000, 3, {}, 750, 0, 0, 2250],                                 // buy 3: 25%
  [4000, 4, {}, 1200, 0, 0, 2800],                                // buy 4: 30%
  [6000, 6, {}, 1800, 0, 0, 4200],                                // 6 pieces: still 30%
  [2498, 2, {}, 500, 0, 0, 1998],                                 // 20% of 2,498 = 499.6, rounds to 500
  [2999, 3, {}, 750, 0, 0, 2249],                                 // 25% of 2,999 = 749.75, rounds to 750
  [2000, 2, { clockWon: true }, 400, 100, 0, 1500],               // clock stacks with Buy 2
  [1299, 1, { clockWon: true }, 0, 100, 0, 1199],                 // clock alone, one piece
  [1, 1, { clockWon: true }, 0, 1, 0, 0],                         // ₹1 test bill: clock can't go below zero
  [3000, 3, { tierDismissed: true }, 0, 0, 0, 3000],              // staff removed the offer
  [3000, 3, { tierDismissed: true, clockWon: true }, 0, 100, 0, 2900],
  [3000, 3, { discount: "100", clockWon: true }, 750, 100, 100, 2050], // all three together
  [1000, 1, { discount: "5000" }, 0, 0, 1000, 0],                 // typed discount capped at what's left
  [2000, 2, { discount: "abc" }, 400, 0, 0, 1600],                // junk in the box counts as nothing
];
for (const [subtotal, pieces, o, offTier, offClock, discountNum, total] of cases) {
  const r = bill(subtotal, pieces, o);
  const what = `${pieces} pcs ₹${subtotal} ${JSON.stringify(o)}`;
  assert.equal(r.offTier, offTier, `offTier — ${what}`);
  assert.equal(r.offClock, offClock, `offClock — ${what}`);
  assert.equal(r.discountNum, discountNum, `discount — ${what}`);
  assert.equal(r.total, total, `total — ${what}`);
  // what the bill stores (discount = typed + offers) always reconciles
  assert.equal(subtotal - r.discountNum - r.offerDiscount, r.total, `reconciles — ${what}`);
  assert.ok(r.total >= 0, `never negative — ${what}`);
}

console.log(`offers: ${cases.length} bills + tier table OK`);
