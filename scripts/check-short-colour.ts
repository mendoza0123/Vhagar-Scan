// Self-check for the hang-tag's Colour row.  Run:  node scripts/check-short-colour.ts
// (Node strips the types natively; there is no test runner in this repo.)
import assert from "node:assert/strict";
import { shortColour, oneWordColour } from "../lib/short-colour.ts";

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

// --- oneWordColour: the carton list, where colours must be told apart on one line
// The first three are the three real colours inside CTN-2026-0001; if any two of
// them collapsed to the same text the label would be useless.
const oneWord: [string, string][] = [
  ["BLACK BROWN STRIPE", "BLACK"],
  ["DARK BROWN", "DARK BROWN"],   // "DARK" alone says nothing
  ["BEIGE", "BEIGE"],
  ["WHITE RED", "WHITE"],
  ["Off-White Floral Embroidered Linen Blend", "Off-White"], // hyphen is one word
  ["Ivory and Olive Patterned Linen", "Ivory"],
  ["  NAVY   BLUE  ", "NAVY BLUE"],
  ["Multicolor Abstract Print", "Multicolor"],
  ["", ""],
];
for (const [input, want] of oneWord) {
  const got = oneWordColour(input);
  assert.equal(got, want, `oneWordColour(${JSON.stringify(input)}) === ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
assert.equal(oneWordColour(null), "");
assert.equal(oneWordColour(undefined), "");

// the three colours in the real carton must stay distinguishable from each other
const trio = ["BLACK BROWN STRIPE", "DARK BROWN", "BEIGE"].map(oneWordColour);
assert.equal(new Set(trio).size, 3, `carton colours collapsed together: ${trio.join(" / ")}`);

console.log(`oneWordColour: ${oneWord.length + 3} checks passed`);
