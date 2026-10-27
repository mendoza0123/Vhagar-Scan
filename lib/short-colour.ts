// 37 of the 216 live styles hold a whole product description in `products.color`
// — "Dark Green Floral Printed Linen-Cotton Blend Regular Fit Shirt" — and a
// 45mm-wide hang-tag has room for about 22 characters.
//
// Clipping mid-sentence gives "Dark Green Floral Printed Li…", which tells a
// customer nothing. But every one of those values is the SAME shape: the colour
// FIRST, then fabric/fit words. So cut at the first word that describes
// something other than colour and the real answer falls out: "Dark Green".
//
// This is a display fix, not a data fix — the underlying field should still be
// corrected in IMS. It only ever engages on values too long to fit.
const DESCRIPTOR = new Set([
  // pattern / treatment
  "floral", "abstract", "embroidered", "embroidery", "patterned", "pattern",
  "graphic", "print", "printed", "colorblock", "colourblock", "textured",
  // cloth
  "linen", "linen-cotton", "cotton", "blend", "poly", "polyester", "viscose",
  "lyocell", "slub", "rayon", "denim",
  // cut
  "regular", "relaxed", "slim", "oversized", "boxy", "classic", "short", "long",
  "half", "full", "sleeve", "sleeves", "fit", "shirt", "t-shirt", "tshirt", "kurta",
]);

const FITS = 22; // characters that fit the Colour row at the tag's type size

// Words that mean nothing on their own: "DARK BROWN" cut to "DARK" is worse than
// useless, and doesn't tell DARK BROWN from DARK GREEN. These keep their partner.
const MODIFIER = new Set([
  "dark", "light", "off", "deep", "pale", "bright", "multi", "mid", "dull",
  "jet", "hot", "ice", "sky", "navy", "royal", "baby", "dusty", "burnt",
]);

// The shortest label that still identifies a colour — for a carton list, where
// three colours of the same style have to be told apart on one 45mm line.
// One word when one word is a colour; two when the first is only a modifier.
export function oneWordColour(raw: string | null | undefined): string {
  const words = (raw ?? "").trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (!words.length) return "";
  const first = words[0];
  if (words.length > 1 && MODIFIER.has(first.toLowerCase().replace(/[^a-z-]/g, ""))) {
    return `${first} ${words[1]}`;
  }
  return first;
}

export function shortColour(raw: string | null | undefined): string {
  const v = (raw ?? "").trim().replace(/\s+/g, " ");
  if (v.length <= FITS) return v; // the common case — untouched

  // keep the leading words until the description starts
  const words = v.split(" ");
  const colour: string[] = [];
  for (const w of words) {
    if (DESCRIPTOR.has(w.toLowerCase().replace(/[^a-z-]/g, ""))) break;
    colour.push(w);
  }
  const lead = colour.join(" ");
  if (lead && lead.length <= FITS) return lead;

  // no descriptor found (or the colour itself is long) — cut on a word boundary
  // rather than mid-word, so it never reads like a rendering bug
  const cut = (lead || v).slice(0, FITS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 8 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
