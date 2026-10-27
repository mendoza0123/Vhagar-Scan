// Self-check for the booth location chain: transfer to Display -> sell from
// Display -> void gives it back, plus a unique t-shirt sticker being retired on
// sale and revived on void.
//
//   node --env-file=.env.local scripts/check-loc-sale.mjs          (rehearsal)
//   node --env-file=.env.local scripts/check-loc-sale.mjs --applied
//
// Runs against the LIVE booth database inside a transaction that always rolls
// back, so it leaves nothing behind. Without --applied it also applies
// db/loc-sale-v18.sql inside that same transaction, so the whole migration can
// be rehearsed before it is really installed.
import { readFileSync } from "node:fs";
import { Pool, neonConfig } from "@neondatabase/serverless";

neonConfig.webSocketConstructor = globalThis.WebSocket;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
const q = async (s, p) => (await c.query(s, p)).rows;

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (extra ? "  -> " + extra : "")); }
};

const boxQty = async (sku, status) => Number((await q(
  `SELECT COALESCE(SUM(ci.qty),0) n FROM ims_carton_items ci
     JOIN ims_cartons c ON c.id = ci.carton_id
    WHERE ci.variant_sku = $1 AND c.status = $2`, [sku, status]))[0].n);
const stock = async (sku) => Number((await q(
  "SELECT qty_on_hand n FROM variants WHERE variant_sku = $1", [sku]))[0].n);
const sell = async (items) => Number((await q(
  `SELECT process_sale($1::jsonb, NULL, 0, 'Self check', '9999999999',
                       'cash', 'selfcheck', 'rolled back') id`,
  [JSON.stringify(items)]))[0].id);

await c.query("BEGIN");
try {
  if (!process.argv.includes("--applied")) {
    await c.query(readFileSync("db/loc-sale-v18.sql", "utf8"));
    console.log("(migration applied inside the rolled-back transaction)");
  }

  // ---- a shirt: one QR per style+size, tracked by which box it sits in ----
  const [{ sku }] = await q(
    `SELECT ci.variant_sku sku FROM ims_carton_items ci
       JOIN ims_cartons c ON c.id = ci.carton_id
       JOIN variants  v ON v.variant_sku = ci.variant_sku
      WHERE c.status = 'Packed' AND ci.qty >= 2 AND v.qty_on_hand >= 2
      ORDER BY ci.qty DESC LIMIT 1`);
  console.log("\nSHIRT " + sku + " — move to Display, sell it from Display, void it");

  const p0 = await boxQty(sku, "Packed"), d0 = await boxQty(sku, "Display"), s0 = await stock(sku);
  await q("SELECT stage_move($1::jsonb, 'DISPLAY', 'selfcheck')", [JSON.stringify([{ sku, qty: 1 }])]);
  const p1 = await boxQty(sku, "Packed"), d1 = await boxQty(sku, "Display"), s1 = await stock(sku);
  ok(d1 === d0 + 1, "Display now holds the piece", d0 + "->" + d1);
  ok(p1 === p0 - 1, "the carton gave it up", p0 + "->" + p1);
  ok(s1 === s0, "a transfer never changes total stock", s0 + "->" + s1);

  const items = [{ sku, qty: 1, price: 100, src: "display" }];
  const saleId = await sell(items);
  await q("UPDATE sales SET loc_taken = cartons_consume_src($1::jsonb) WHERE id = $2", [JSON.stringify(items), saleId]);
  const p2 = await boxQty(sku, "Packed"), d2 = await boxQty(sku, "Display"), s2 = await stock(sku);
  ok(s2 === s1 - 1, "total stock drops by 1", s1 + "->" + s2);
  ok(d2 === d1 - 1, "the DISPLAY piece is the one sold", d1 + "->" + d2);
  ok(p2 === p1, "the carton piece is untouched", p1 + "->" + p2);
  const taken = (await q("SELECT loc_taken t FROM sales WHERE id = $1", [saleId]))[0].t;
  ok(taken && taken[0] && taken[0].carton === "DISPLAY", "the bill records WHICH box gave it up", JSON.stringify(taken));

  await q("SELECT void_sale($1::bigint, 'selfcheck')", [saleId]);
  ok(await stock(sku) === s1, "void restores the stock");
  ok(await boxQty(sku, "Display") === d1, "void puts the piece back on Display", d2 + "->" + await boxQty(sku, "Display"));
  ok(await boxQty(sku, "Packed") === p1, "void does not invent a carton piece");

  // ---- a t-shirt: every piece has its own sticker ----
  const unit = await q(
    `SELECT u.unit_code, u.variant_sku FROM ims_units u
       JOIN variants v ON v.variant_sku = u.variant_sku
      WHERE u.status = 'in_stock' AND v.qty_on_hand >= 1 LIMIT 1`);
  if (unit.length === 0) {
    console.log("\n(no in-stock t-shirt units to check)");
  } else {
    const { unit_code: code, variant_sku: tee } = unit[0];
    console.log("\nT-SHIRT " + code + " — sell that exact sticker, then void");
    const t0 = await stock(tee);
    const tid = await sell([{ sku: tee, qty: 1, price: 100, src: "rack" }]);
    const n = Number((await q("SELECT mark_units_sold($1::text[], $2) n", [[code], tid]))[0].n);
    const u1 = (await q("SELECT status, sale_id FROM ims_units WHERE unit_code = $1", [code]))[0];
    ok(n === 1, "exactly one sticker retired", "marked " + n);
    ok(u1.status === "sold", "that piece now reads sold", u1.status);
    ok(Number(u1.sale_id) === tid, "and it names the bill it left on", String(u1.sale_id));
    ok(await stock(tee) === t0 - 1, "tee stock drops by 1");

    // the same sticker scanned onto a second bill must not retire twice
    const tid2 = await sell([{ sku: tee, qty: 1, price: 100, src: "rack" }]);
    const again = Number((await q("SELECT mark_units_sold($1::text[], $2) n", [[code], tid2]))[0].n);
    ok(again === 0, "an already-sold sticker is a no-op, not an error", "marked " + again);
    ok(Number((await q("SELECT sale_id FROM ims_units WHERE unit_code = $1", [code]))[0].sale_id) === tid,
      "and it still points at the first bill");

    await q("SELECT void_sale($1::bigint, 'selfcheck')", [tid]);
    const u2 = (await q("SELECT status, sale_id FROM ims_units WHERE unit_code = $1", [code]))[0];
    ok(u2.status === "in_stock" && u2.sale_id === null, "void puts the sticker back in stock",
      u2.status + "/" + u2.sale_id);
  }

  // ---- the invariant that matters: the index must never claim more than exists
  const [inv] = await q(
    `WITH idx AS (SELECT ci.variant_sku sku, SUM(ci.qty)::int n
                    FROM ims_carton_items ci JOIN ims_cartons c ON c.id = ci.carton_id
                   WHERE c.status IN ('Packed','Rack','Display') GROUP BY 1)
     SELECT count(*)::int AS overclaim FROM idx i JOIN variants v ON v.variant_sku = i.sku
      WHERE i.n > v.qty_on_hand`);
  ok(inv.overclaim === 0, "no box claims more pieces than really exist", "over-claiming SKUs: " + inv.overclaim);
} finally {
  await c.query("ROLLBACK");
  c.release();
  await pool.end();
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
