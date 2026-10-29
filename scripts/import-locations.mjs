// Load the booth stock register's Display / Rack rows into IMS.
//
//   node --env-file=.env.local scripts/import-locations.mjs data/HS_POLO_Stock_Register_As_Per_Photos.xlsx
//   ...                                                    --apply
//   ...                                                    --only AR-301,AR-302
//   ...                                                    --sheet "T-Shirt Stock Register"
//
// Takes .xlsx or .csv. Dry run unless --apply: it prints every placement and
// writes nothing.
//
// Each style is a block — one row carrying the style code and the size columns,
// then unlabelled rows whose STOCK cell reads Display / Rack / Carton / Inhouse
// Stock / Marketing / TTL. Only Display and Rack are loaded:
//   * Carton is already in IMS as real numbered cartons (CTN-2026-00xx) whose
//     printed labels must stay valid, so packed cartons are never touched.
//   * Inhouse Stock and Marketing are not booth locations; POS can't sell from
//     them.
//   * TOTAL INHAND is ignored. QTY is the real count and already agrees with
//     variants.qty_on_hand, which this script never writes to.
//
// The two registers are laid out differently — the shirt sheet's code lives in
// DESIGN NO, the t-shirt sheet's in STYLE NO (its DESIGN NO is just a serial),
// and it spells the carton row "CARTOON" — so the code column is CHOSEN by
// asking the database which candidate actually resolves, rather than trusting a
// header name.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { readXlsx } from "./xlsx.mjs";

const file = process.argv[2];
const apply = process.argv.includes("--apply");
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const only = argAfter("--only")
  ? new Set(argAfter("--only").split(",").map((s) => s.trim().toUpperCase()))
  : null;
if (!file) {
  console.error("usage: node scripts/import-locations.mjs <sheet.xlsx|.csv> [--apply] [--only AR-301,AR-302] [--sheet NAME]");
  process.exit(1);
}

// XXL in a sheet is 2XL in the database; the rest match.
const SIZE_ALIAS = { XXL: "2XL", XXXL: "3XL", XXXXL: "4XL", XXXXXL: "5XL" };
const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
// what the STOCK cell can say. Only the first two are loaded; the rest are
// named so an unrecognised label stands out instead of being silently dropped.
const LOAD = { DISPLAY: "DISPLAY", RACK: "RACK" };
const IGNORE = ["CARTON", "CARTOON", "INHOUSESTOCK", "INHOUSE", "MARKETING", "TTL", "TTLCUTTING", "TOTAL"];

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const key = (s) => norm(s).toUpperCase().replace(/[^A-Z0-9]/g, "");

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

let rows, usingSheet = null;
if (/\.xlsx$/i.test(file)) {
  const want = argAfter("--sheet") || /stock.?register/i;
  let got;
  try { got = readXlsx(file, want); }
  catch { got = readXlsx(file); }           // fall back to the first sheet
  rows = got.rows; usingSheet = got.sheet;
  console.log(`${file}\nsheets: ${got.sheets.join(" | ")}\nreading: ${usingSheet}`);
} else {
  rows = parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""));
  console.log(file);
}

// Any header a register might hold the style code under. The 180 GSM sheet
// calls it SKU CODE where the others say STYLE NO / DESIGN NO.
const CODE_COL = /^(STYLENO|DESIGNNO|STYLECODE|SKUCODE|CODE)$/;

// --- header row: found by the columns we need, not by position
let head = -1;
for (let i = 0; i < Math.min(rows.length, 30); i++) {
  const ks = (rows[i] || []).map(key);
  if (ks.includes("STOCK") && ks.some((k) => CODE_COL.test(k))) { head = i; break; }
}
if (head < 0) { console.error("No header row found (needs a STOCK column and a style/design code column)."); process.exit(1); }
const ks = rows[head].map(key);
const cStock = ks.indexOf("STOCK");

// every column that could hold the style code — the database decides which
const candidates = [];
ks.forEach((k, i) => { if (CODE_COL.test(k)) candidates.push(i); });

const sizeCols = [];
ks.forEach((k, i) => {
  if (!k || i <= cStock) return;
  const s = SIZE_ALIAS[k] || k;
  if (SIZES.includes(s)) sizeCols.push([i, s]);
});
if (!sizeCols.length) { console.error("No size columns found to the right of STOCK."); process.exit(1); }
console.log(`header row ${head + 1} · code column candidates: ${candidates.map((i) => rows[head][i]).join(", ")} · sizes: ${sizeCols.map(([, s]) => s).join(" ")}`);

// --- pass 1: remember each candidate's value per row, and the location rows
const seenLabels = new Map();
const scan = [];
for (let i = head + 1; i < rows.length; i++) {
  const r = rows[i] || [];
  const vals = candidates.map((ci) => norm(r[ci]).toUpperCase());
  const label = key(r[cStock]);
  if (label) seenLabels.set(label, (seenLabels.get(label) || 0) + 1);
  scan.push({ vals, label, r });
}

// --- which candidate column really holds style codes? ask the database
const sql = neon(process.env.DATABASE_URL);
const allCodes = [...new Set(scan.flatMap((s) => s.vals).filter(Boolean))];
const real = new Set((await sql`SELECT style_code FROM products
  WHERE style_code = ANY(${allCodes}::text[])`).map((r) => r.style_code));
let pick = 0, bestHits = -1;
candidates.forEach((_, ci) => {
  const hits = new Set(scan.map((s) => s.vals[ci]).filter((v) => v && real.has(v))).size;
  console.log(`  "${rows[head][candidates[ci]]}" matches ${hits} real styles`);
  if (hits > bestHits) { bestHits = hits; pick = ci; }
});
if (bestHits <= 0) { console.error("\nNone of the candidate columns match a style in IMS — wrong sheet?"); process.exit(1); }
console.log(`using "${rows[head][candidates[pick]]}" as the style code\nrows by label: ${[...seenLabels].map(([k, v]) => `${k}=${v}`).join(" ")}`);

const unknownLabels = [...seenLabels.keys()].filter((k) => !LOAD[k] && !IGNORE.includes(k));
if (unknownLabels.length) console.log(`UNRECOGNISED STOCK labels (ignored): ${unknownLabels.join(", ")}`);

// --- pass 2: walk the blocks
const wanted = [];
let style = null, skipped = 0, noCode = 0;
for (const s of scan) {
  const code = s.vals[pick];
  if (code) { style = code; continue; }      // a style row opens a new block
  if (!s.label) continue;
  const loc = LOAD[s.label];
  if (!loc) continue;
  if (!style) { noCode++; continue; }
  if (only && !only.has(style)) { skipped++; continue; }
  for (const [ci, size] of sizeCols) {
    const n = parseInt(norm(s.r[ci]).replace(/[^0-9-]/g, ""), 10);
    if (Number.isFinite(n) && n > 0) wanted.push({ style, loc, size, qty: n });
  }
}
if (noCode) console.log(`${noCode} location rows had no style above them — skipped`);
if (!wanted.length) { console.error("\nNothing to load — no Display or Rack rows with a quantity."); process.exit(1); }

// --- resolve to real SKUs
let styles = [...new Set(wanted.map((w) => w.style))];
// 33 IMS style codes carry a trailing underscore and a register sometimes drops
// it. Matching code + "_" exactly is a spelling, not a guess at which style was
// meant — but it still gets reported, because the register is the thing that's
// wrong. Anything less exact than that stays NOT IN IMS and is never corrected.
const known = await sql`SELECT variant_sku, style_code, size FROM variants
  WHERE style_code = ANY(${[...styles, ...styles.map((s) => s + "_")]}::text[])`;
const inIms = new Set(known.map((v) => v.style_code));
const respelt = styles.filter((s) => !inIms.has(s) && inIms.has(s + "_"));
if (respelt.length) {
  console.log(`\nTRAILING UNDERSCORE restored (${respelt.length}): ${respelt.map((s) => `${s} -> ${s}_`).join(", ")}`);
  for (const w of wanted) if (respelt.includes(w.style)) w.style += "_";
  styles = [...new Set(wanted.map((w) => w.style))];
}
const skuOf = new Map(known.map((v) => [v.style_code + "|" + v.size, v.variant_sku]));

const items = [], missing = [];
for (const w of wanted) {
  const sku = skuOf.get(w.style + "|" + w.size);
  if (sku) items.push({ sku, loc: w.loc, qty: w.qty, style: w.style, size: w.size });
  else missing.push(`${w.style} ${w.size} (${w.loc} ${w.qty})`);
}
const noStyle = styles.filter((s) => !known.some((v) => v.style_code === s));
if (noStyle.length) console.log(`\nNOT IN IMS (${noStyle.length} styles): ${noStyle.join(", ")}`);
if (missing.length) console.log(`\nSIZE NOT REGISTERED (${missing.length}): ${missing.slice(0, 25).join(", ")}${missing.length > 25 ? " …" : ""}`);
if (skipped) console.log(`(--only skipped ${skipped} location rows)`);
if (!items.length) { console.error("\nNothing resolves to a real SKU."); process.exit(1); }

// --- show the change
const before = await sql`SELECT c.status, ci.variant_sku, ci.qty
  FROM ims_carton_items ci JOIN ims_cartons c ON c.id = ci.carton_id
  WHERE c.status IN ('Rack','Display') AND ci.variant_sku = ANY(${items.map((i) => i.sku)}::text[])`;
const now = new Map(before.map((b) => [b.status.toUpperCase() + "|" + b.variant_sku, b.qty]));

console.log(`\n${apply ? "APPLYING" : "DRY RUN"} — ${items.length} placements across ${new Set(items.map((i) => i.style)).size} styles`);
let changes = 0;
for (const i of items.sort((a, b) => a.style.localeCompare(b.style) || a.loc.localeCompare(b.loc))) {
  const was = now.get(i.loc + "|" + i.sku) ?? 0;
  if (was !== i.qty) changes++;
  console.log(`  ${i.loc.padEnd(7)} ${i.sku.padEnd(18)} ${was} -> ${i.qty}${was === i.qty ? "  (no change)" : ""}`);
}
console.log(`${changes} of ${items.length} would change.`);

if (!apply) { console.log("\nNothing written. Re-run with --apply to load it."); process.exit(0); }

const [{ r }] = await sql`SELECT loc_set(${JSON.stringify(items.map(({ sku, loc, qty }) => ({ sku, loc, qty })))}::jsonb, 'stock register') AS r`;
console.log("\nloaded:", JSON.stringify({ changed: r.changed, unknown: r.unknown }));
if (r.capped?.length) {
  console.log(`\nCAPPED (${r.capped.length}) — the sheet asks for more pieces than IMS has in stock:`);
  for (const c of r.capped) console.log(`  ${c.sku} ${c.loc}: asked ${c.asked}, set ${c.set}  (stock ${c.stock}, already in other boxes ${c.elsewhere})`);
  console.log("These need a stock correction or a recount — tell me which number is right.");
}
