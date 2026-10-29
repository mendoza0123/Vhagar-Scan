// THE WALK offers (from 30 Oct 2026). The Inorbit set they replaced — shirt
// 20/30/40%, t-shirt flat ₹499/₹999, mystery envelope, auto cap + keychain — is
// written down in IMS → Admin → Inorbit offers, and its code is POS b9821df.

// Rides every checkout; /api/sales refuses any other value. The discount is
// worked out on the phone, so a phone still holding an older sell screen would
// otherwise bill with that screen's offers.
export const OFFER_SET = "the-walk";

// Buy 2 = 10% · Buy 3 = 20% · Buy 4 or more = 30% off. Every piece counts,
// shirt or t-shirt.
export function tierPct(pieces: number): number {
  return pieces >= 4 ? 30 : pieces === 3 ? 20 : pieces === 2 ? 10 : 0;
}

// The 10-second clock game: a customer who stops the clock at exactly 10.00 s
// gets ₹100 off. There is no clock in the app — staff tap it once they have.
export const CLOCK_OFF = 100;

// The whole bill in one place, so the money can be checked without a phone:
// node scripts/check-offers.ts
export function priceBill(b: {
  subtotal: number;
  pieces: number;
  discount: string | number; // the typed manual discount, in rupees
  tierDismissed: boolean;
  clockWon: boolean;
}) {
  const pct = tierPct(b.pieces);
  const tierAmt = Math.round((b.subtotal * pct) / 100);
  const offTier = !b.tierDismissed && pct > 0 ? tierAmt : 0;
  // never let the clock's ₹100 take a tiny bill below zero
  const offClock = b.clockWon ? Math.min(CLOCK_OFF, Math.max(0, b.subtotal - offTier)) : 0;
  const offerDiscount = offTier + offClock;
  // nor a typed discount
  const discountNum = Math.min(Math.max(0, Number(b.discount) || 0), Math.max(0, b.subtotal - offerDiscount));
  const total = Math.max(0, b.subtotal - discountNum - offerDiscount);
  return { pct, tierAmt, offTier, offClock, offerDiscount, discountNum, total };
}
