// Load the booth stock register's Display / Rack rows into IMS.
//
//   node --env-file=.env.local scripts/import-locations.mjs data/stock-register.csv
//   node --env-file=.env.local scripts/import-locations.mjs data/stock-register.csv --apply
//   ...                                                    --only AR-301,AR-302
//
// Dry run unless --apply is passed: it prints exactly what would change and
// writes nothing.
//
// The sheet lays each style out as a block — one row carrying DESIGN NO and the
// size columns, then unlabelled rows whose STOCK cell reads Display / Rack /
// Carton / Inhouse Stock / Marketing / TTL. Only Display and Rack are loaded:
//   * Carton is already in IMS as real numbered cartons (CTN-2026-00xx) and
//     those labels must stay valid, so packed cartons are never touched.
//   * Inhouse Stock and Marketing are not booth locations and POS can't sell
//     from them.
//   * TOTAL INHAND is ignored. QTY is the real count and already agrees with
//     variants.qty_on_hand, which this script never writes to.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const file = process.argv[2];
const apply = process.argv.includes("--apply");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > -1 && process.argv[onlyArg + 1]
  ? new Set(process.argv[onlyArg + 1].split(",").map((s) => s.trim().toUpperCase()))
  : null;
if (!file) {
  console.error("usage: node scripts/import-locations.mjs <sheet.csv> [--apply] [--only AR-301,AR-302]");
  process.exit(1);
}

// XXL in the sheet is 2XL in the database; the rest match.
const SIZE_ALIAS = { XXL: "2XL", XXXL: "3XL", XXXXL: "4XL", XXXXXL: "5XL" };
const LOADED = { DISPLAY: "DISPLAY", RACK: "RACK" };

// --- the smallest CSV reader that survives quoted commas and embedded newlines
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const key = (s) => norm(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

const rows = parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""));

// Find the header row by the columns we actually need, rather than assuming
// row 1 — exports often carry a title row above it.
let head = -1;
for (let i = 0; i < Math.min(rows.length, 30); i++) {
  const ks = rows[i].map(key);
  if (ks.includes("DESIGNNO") && ks.includes("STOCK")) { head = i; break; }
}
if (head < 0) {
  console.error("Could not find the header row (needs a DESIGN NO column and a STOCK column).");
  process.exit(1);
}
const ks = rows[head].map(key);
const col = (...names) => { for (const n of names) { const i = ks.indexOf(key(n)); if (i > -1) return i; } return -1; };

const cDesign = col("DESIGN NO", "DESIGNNO", "design_no", "code", "style_code");
const cProduct = col("product", "PRODUCT", "name");
const cStock = col("STOCK");
const sizeCols = [];
ks.forEach((k, i) => {
  if (!k || i <= cStock) return;
  const s = SIZE_ALIAS[k] || k;
  if (["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"].includes(s)) sizeCols.push([i, s]);
});
if (!sizeCols.length) { console.error("No size columns found to the right of STOCK."); process.exit(1); }
console.log(`header row ${head + 1}; sizes: ${sizeCols.map(([, s]) => s).join(" ")}`);

// --- walk the blocks
const wanted = [];               // {style, name, loc, size, qty}
const seenLoc = new Map();
let style = null, name = null, skippedStyles = 0;
for (let i = head + 1; i < rows.length; i++) {
  const r = rows[i];
  const design = norm(r[cDesign]).toUpperCase();
  if (design) { style = design; name = norm(r[cProduct]) || name; continue; }
  if (!style) continue;
  const label = key(r[cStock]);
  if (!label) continue;
  seenLoc.set(label, (seenLoc.get(label) || 0) + 1);
  const loc = LOADED[label];
  if (!loc) continue;                       // Carton / Inhouse / Marketing / TTL
  if (only && !only.has(style)) { skippedStyles++; continue; }
  for (const [ci, size] of sizeCols) {
    const n = parseInt(norm(r[ci]).replace(/[^0-9-]/g, ""), 10);
    if (Number.isFinite(n) && n > 0) wanted.push({ style, name, loc, size, qty: n });
  }
}
console.log("rows seen by label: " + [...seenLoc].map(([k, v]) => `${k}=${v}`).join(" "));
if (!wanted.length) { console.error("\nNothing to load — no Display or Rack rows with a quantity."); process.exit(1); }

// --- resolve to real SKUs
const sql = neon(process.env.DATABASE_URL);
const styles = [...new Set(wanted.map((w) => w.style))];
const known = await sql`SELECT variant_sku, style_code, size FROM variants
  WHERE style_code = ANY(${styles}::text[])`;
const skuOf = new Map(known.map((v) => [v.style_code + "|" + v.size, v.variant_sku]));

const items = [], missing = [];
for (const w of wanted) {
  const sku = skuOf.get(w.style + "|" + w.size);
  if (sku) items.push({ sku, loc: w.loc, qty: w.qty, style: w.style, size: w.size });
  else missing.push(`${w.style} ${w.size} (${w.loc} ${w.qty})`);
}
// A style listed in the sheet but absent from IMS, or a size it was never
// registered with — surfaced, never silently dropped.
const noStyle = styles.filter((s) => !known.some((v) => v.style_code === s));
if (noStyle.length) console.log(`\nNOT IN IMS (${noStyle.length} styles): ${noStyle.join(", ")}`);
if (missing.length) console.log(`\nSIZE NOT REGISTERED (${missing.length}): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`);
if (skippedStyles) console.log(`(--only filter skipped ${skippedStyles} location rows)`);

// --- show the change, per box
const before = await sql`SELECT c.status, ci.variant_sku, ci.qty
  FROM ims_carton_items ci JOIN ims_cartons c ON c.id = ci.carton_id
  WHERE c.status IN ('Rack','Display') AND ci.variant_sku = ANY(${items.map((i) => i.sku)}::text[])`;
const now = new Map(before.map((b) => [b.status.toUpperCase() + "|" + b.variant_sku, b.qty]));

console.log(`\n${apply ? "APPLYING" : "DRY RUN"} — ${items.length} placements across ${new Set(items.map((i) => i.style)).size} styles\n`);
for (const i of items.sort((a, b) => a.style.localeCompare(b.style) || a.loc.localeCompare(b.loc))) {
  const was = now.get(i.loc + "|" + i.sku) ?? 0;
  console.log(`  ${i.loc.padEnd(7)} ${i.sku.padEnd(16)} ${was} -> ${i.qty}${was === i.qty ? "  (no change)" : ""}`);
}

if (!apply) { console.log("\nNothing written. Re-run with --apply to load it."); process.exit(0); }

const [{ r }] = await sql`SELECT loc_set(${JSON.stringify(items.map(({ sku, loc, qty }) => ({ sku, loc, qty })))}::jsonb, 'stock register') AS r`;
console.log("\nloaded:", JSON.stringify(r));
if (r.capped?.length) {
  console.log("\nCAPPED — these asked for more than the stock left after the other boxes:");
  for (const c of r.capped) console.log(`  ${c.sku} ${c.loc}: asked ${c.asked}, set ${c.set} (stock ${c.stock}, elsewhere ${c.elsewhere})`);
}
