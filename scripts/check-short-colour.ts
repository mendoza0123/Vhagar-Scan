// Self-check for the hang-tag's Colour row.  Run:  node scripts/check-short-colour.ts
// (Node strips the types natively; there is no test runner in this repo.)
import assert from "node:assert/strict";
import { shortColour } from "../lib/short-colour.ts";

// every case below is a REAL value from products.color in the live database
const cases: [string, string][] = [
  // short enough to print as-is — must come through untouched
  ["WHITE BLACK CHECKS", "WHITE BLACK CHECKS"],
  ["MAROON CHECKS", "MAROON CHECKS"],
  ["Beige and Brown", "Beige and Brown"],
  ["BLACK", "BLACK"],
  ["Rust Plaid", "Rust Plaid"],
  // too long — the colour is the leading words, the rest describes the garment
  ["Dark Green Floral Printed Linen-Cotton Blend Regular Fit Shirt", "Dark Green"],
  ["Off-White Floral Embroidered Linen Blend Regular Fit Shirt", "Off-White"],
  ["Multicolor Abstract Print Linen Blend Short Sleeve Shirt", "Multicolor"],
  ["Ivory and Olive Patterned Linen Blend Short Sleeve Shirt", "Ivory and Olive"],
  ["Brown and Mustard Colorblock Cotton Short Sleeve Shirt", "Brown and Mustard"],
  ["Beige Embroidered Linen-Cotton Blend Relaxed Fit Shirt", "Beige"],
  ["Beige Abstract Print Linen Blend Relaxed Shirt", "Beige"],
  // nothing to work with
  ["", ""],
];

for (const [input, want] of cases) {
  const got = shortColour(input);
  assert.equal(got, want, `shortColour(${JSON.stringify(input)}) === ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

// a long value with NO descriptor word must still fit, and must not cut mid-word
const src = "Something Extremely Lengthy Unrecognised Here";
const odd = shortColour(src);
assert.ok(odd.length <= 23, `fallback too long: ${odd}`);
assert.ok(odd.endsWith("…"), `fallback should be marked as clipped: ${odd}`);
// word boundary = what we kept is a prefix of the source, and the source
// continues with a space (never half a word)
const kept = odd.slice(0, -1);
assert.ok(src.startsWith(kept), `fallback is not a prefix of the source: ${odd}`);
assert.ok(src[kept.length] === " ", `fallback cut mid-word: ${odd}`);

// null/undefined must not throw — 5 live styles have no colour at all
assert.equal(shortColour(null), "");
assert.equal(shortColour(undefined), "");

console.log(`shortColour: ${cases.length + 5} checks passed`);
