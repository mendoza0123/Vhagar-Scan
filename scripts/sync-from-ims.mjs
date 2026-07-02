// Re-sync booth stock (Neon) from the live Vhagar IMS (Google Apps Script).
// Pulls current per-size quantities + adds any new styles, so the POS mirrors
// the IMS live stock. Idempotent + re-runnable.
//
//   node scripts/sync-from-ims.mjs            # DRY RUN (no writes) — prints the plan
//   node scripts/sync-from-ims.mjs --apply    # actually write the changes
//
// Reads GAS_STOCK_URL + GAS_API_TOKEN + DATABASE_URL from .env.local.
import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";

config({ path: ".env.local" });
config();

const APPLY = process.argv.includes("--apply");
const SIZES = ["S", "M", "L", "XL", "2XL", "3XL"];

// IMS code -> POS canonical style_code (keeps existing variant_sku/FKs stable).
const ALIAS = {
  "VH-OPL012": "VH-OPL12",
  "VH-OPL015": "VH-OPL15",
  "VH-LLO7": "VH-LL07",
};
const norm = (x) => {
  const c = String(x ?? "").trim().replace(/_+$/, "").toUpperCase();
  return ALIAS[c] || c;
};

// Trust IN HAND (col L) as the per-style total. When the per-size cells disagree,
// reconcile them to IN HAND: 0 -> zero all; over-count -> trim from the largest
// sizes down; under-count -> add the difference to M. Keeps the POS total == sum(IN HAND).
function reconcile(rawSizes, inHand) {
  const out = {};
  SIZES.forEach((s) => (out[s] = Number(rawSizes?.[s]) || 0));
  let sum = SIZES.reduce((a, s) => a + out[s], 0);
  if (sum === inHand) return { sizes: out, changed: false };
  if (inHand <= 0) {
    SIZES.forEach((s) => (out[s] = 0));
    return { sizes: out, changed: true };
  }
  if (sum > inHand) {
    let excess = sum - inHand;
    for (let i = SIZES.length - 1; i >= 0 && excess > 0; i--) {
      const take = Math.min(out[SIZES[i]], excess);
      out[SIZES[i]] -= take;
      excess -= take;
    }
  } else {
    out["M"] += inHand - sum; // rare: IN HAND higher than size cells
  }
  return { sizes: out, changed: true };
}

const { GAS_STOCK_URL, GAS_API_TOKEN, DATABASE_URL } = process.env;
if (!GAS_STOCK_URL || !DATABASE_URL) {
  console.error("Missing GAS_STOCK_URL or DATABASE_URL in .env.local");
  process.exit(1);
}
const sql = neon(DATABASE_URL);

// ---- pull live IMS ----
const data = await (await fetch(`${GAS_STOCK_URL}?action=stock&token=${GAS_API_TOKEN}`)).json();
if (!data?.ok || !Array.isArray(data.products)) {
  console.error("IMS endpoint did not return stock:", data?.error || data);
  process.exit(1);
}

// ---- current POS state ----
const posProducts = await sql`SELECT style_code, name FROM products`;
const posStyleSet = new Set(posProducts.map((p) => p.style_code));
const posVariants = await sql`SELECT variant_sku, style_code, size, qty_on_hand, price, needs_price FROM variants`;
const vBySku = new Map(posVariants.map((v) => [v.variant_sku, v]));

// ---- build the plan ----
const newProducts = []; // {style_code, name}
const newVariants = []; // {variant_sku, style_code, size, qty}
const updVariants = []; // {variant_sku, from, to}
const flags = [];
let totalAfter = 0;

const seenStyle = new Set();
for (const p of data.products) {
  const code = norm(p.style_no);
  const name = String(p.product_name ?? "").replace(/\s+/g, " ").trim();
  const inHand = Number(p.in_hand) || 0;
  const sizeSum = SIZES.reduce((a, s) => a + (Number(p.sizes?.[s]) || 0), 0);
  const { sizes, changed } = reconcile(p.sizes, inHand); // honour IN HAND total
  if (changed)
    flags.push(`${code}: per-size ${sizeSum} reconciled to IN HAND ${inHand} -> ${SIZES.filter((s) => sizes[s]).map((s) => `${s}:${sizes[s]}`).join(" ") || "0"}`);

  if (!posStyleSet.has(code) && !seenStyle.has(code)) newProducts.push({ style_code: code, name });
  seenStyle.add(code);

  for (const size of SIZES) {
    const qty = Number(sizes[size]) || 0;
    const sku = `${code}-${size}`;
    const existing = vBySku.get(sku);
    if (existing) {
      totalAfter += qty;
      if (existing.qty_on_hand !== qty) updVariants.push({ variant_sku: sku, from: existing.qty_on_hand, to: qty });
    } else if (qty > 0) {
      totalAfter += qty;
      newVariants.push({ variant_sku: sku, style_code: code, size, qty });
    }
  }
}

// ---- report ----
const posTotal = posVariants.reduce((a, v) => a + v.qty_on_hand, 0);
console.log(`\n=== IMS → POS sync ${APPLY ? "(APPLY)" : "(DRY RUN — no writes)"} ===`);
console.log(`IMS styles: ${data.products.length}`);
console.log(`POS total qty:  ${posTotal}  ->  ${totalAfter}  (IN HAND / col L basis)`);
console.log(`New styles to add:   ${newProducts.length}  ${newProducts.map((p) => p.style_code).join(", ")}`);
console.log(`New variants to add: ${newVariants.length}`);
console.log(`Variant qty updates: ${updVariants.length}`);
console.log(`Aliases applied: ${Object.entries(ALIAS).map(([a, b]) => `${a}->${b}`).join(", ")}`);
console.log(`Data flags (${flags.length}):`); flags.forEach((f) => console.log("  ⚠", f));

if (!APPLY) {
  console.log("\nDry run only. Re-run with --apply to write these changes.");
  process.exit(0);
}

// ---- apply ----
// New products: needs_price for new variants (IMS has no price); existing kept.
for (const p of newProducts) {
  await sql`INSERT INTO products (style_code, name) VALUES (${p.style_code}, ${p.name})
            ON CONFLICT (style_code) DO NOTHING`;
}
for (const v of newVariants) {
  await sql`INSERT INTO variants (variant_sku, style_code, size, price, needs_price, qty_on_hand)
            VALUES (${v.variant_sku}, ${v.style_code}, ${v.size}, 0, TRUE, ${v.qty})
            ON CONFLICT (variant_sku) DO UPDATE SET qty_on_hand = EXCLUDED.qty_on_hand`;
  await sql`INSERT INTO stock_movements (variant_sku, delta, reason) VALUES (${v.variant_sku}, ${v.qty}, 'ims_sync')`;
}
for (const u of updVariants) {
  await sql`UPDATE variants SET qty_on_hand = ${u.to} WHERE variant_sku = ${u.variant_sku}`;
  await sql`INSERT INTO stock_movements (variant_sku, delta, reason) VALUES (${u.variant_sku}, ${u.to - u.from}, 'ims_sync')`;
}

const after = (await sql`SELECT coalesce(sum(qty_on_hand),0)::int AS t FROM variants`)[0].t;
console.log(`\n✓ Applied. POS total qty is now: ${after}`);
