// Self-check for loc_set — the stock-register loader's one write path.
//
//   node --env-file=.env.local scripts/check-loc-set.mjs            (rehearsal)
//   node --env-file=.env.local scripts/check-loc-set.mjs --applied
//
// Runs against the LIVE booth database inside a transaction that always rolls
// back. Without --applied it applies db/loc-set-v19.sql inside that same
// transaction, so the migration can be rehearsed before it is really installed.
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
const set = async (items) => (await q("SELECT loc_set($1::jsonb,'selfcheck') r",
  [JSON.stringify(items)]))[0].r;
// SKUs whose boxes between them claim more pieces than really exist
const overclaimers = async () => (await q(
  `WITH idx AS (SELECT ci.variant_sku sku, SUM(ci.qty)::int n
                  FROM ims_carton_items ci JOIN ims_cartons c ON c.id = ci.carton_id
                 WHERE c.status IN ('Packed','Rack','Display') GROUP BY 1)
   SELECT i.sku, i.n indexed, v.qty_on_hand FROM idx i
     JOIN variants v ON v.variant_sku = i.sku
    WHERE i.n > v.qty_on_hand ORDER BY 1`)).map((r) => `${r.sku} (${r.indexed} boxed vs ${r.qty_on_hand} in stock)`);

await c.query("BEGIN");
try {
  if (!process.argv.includes("--applied")) {
    await c.query(readFileSync("db/loc-set-v19.sql", "utf8"));
    console.log("(migration applied inside the rolled-back transaction)");
  }

  // Pre-existing over-claims are somebody packing more than IMS thinks exists —
  // a counting problem in the warehouse, not something this loader can fix. The
  // test's job is that loc_set never ADDS to the list.
  const before = await overclaimers();
  if (before.length) {
    console.log(`\nPRE-EXISTING over-claims (${before.length}) — these need a recount, not a code fix:`);
    for (const b of before) console.log("   " + b);
  }

  // a style that sits in a packed carton, with stock to spare
  const [{ sku }] = await q(
    `SELECT ci.variant_sku sku FROM ims_carton_items ci
       JOIN ims_cartons c ON c.id = ci.carton_id
       JOIN variants  v ON v.variant_sku = ci.variant_sku
      WHERE c.status = 'Packed' AND v.qty_on_hand >= ci.qty + 4
      ORDER BY v.qty_on_hand DESC LIMIT 1`);
  const s0 = await stock(sku), k0 = await boxQty(sku, "Packed");
  console.log(`\n${sku} — stock ${s0}, ${k0} already in packed cartons\n`);

  await set([{ sku, loc: "RACK", qty: 3 }, { sku, loc: "DISPLAY", qty: 1 }]);
  ok(await boxQty(sku, "Rack") === 3, "Rack set to 3", String(await boxQty(sku, "Rack")));
  ok(await boxQty(sku, "Display") === 1, "Display set to 1");
  ok(await boxQty(sku, "Packed") === k0, "the packed carton was NOT raided", k0 + " -> " + await boxQty(sku, "Packed"));
  ok(await stock(sku) === s0, "sellable stock untouched", s0 + " -> " + await stock(sku));

  console.log("\nre-running the same sheet must converge, not double");
  await set([{ sku, loc: "RACK", qty: 3 }, { sku, loc: "DISPLAY", qty: 1 }]);
  ok(await boxQty(sku, "Rack") === 3, "Rack still 3 after a second import", String(await boxQty(sku, "Rack")));

  console.log("\na corrected sheet moves the number both ways");
  await set([{ sku, loc: "RACK", qty: 1 }]);
  ok(await boxQty(sku, "Rack") === 1, "Rack revised down to 1", String(await boxQty(sku, "Rack")));
  await set([{ sku, loc: "DISPLAY", qty: 0 }]);
  ok(await boxQty(sku, "Display") === 0, "Display cleared to 0");
  const left = await q(
    `SELECT count(*)::int n FROM ims_carton_items ci JOIN ims_cartons c ON c.id=ci.carton_id
      WHERE ci.variant_sku=$1 AND c.status='Display'`, [sku]);
  ok(left[0].n === 0, "a zero removes the row rather than leaving an empty one");

  console.log("\nthe boxes can never claim more pieces than exist");
  const r = await set([{ sku, loc: "RACK", qty: 9999 }]);
  const packed = await boxQty(sku, "Packed"), rack = await boxQty(sku, "Rack");
  ok(packed + rack <= s0, "capped at real stock", `packed ${packed} + rack ${rack} vs stock ${s0}`);
  ok(rack === s0 - packed, "and it took exactly the headroom", String(rack));
  ok(r.capped?.length === 1 && r.capped[0].asked === 9999, "the cap is reported, not silent", JSON.stringify(r.capped));

  console.log("\nbad input is refused or reported, never guessed");
  const u = await set([{ sku: "NOT-A-REAL-SKU-123", loc: "RACK", qty: 1 }]);
  ok(u.unknown?.length === 1, "an unknown SKU comes back named", JSON.stringify(u.unknown));
  let threw = false;
  try { await q("SAVEPOINT s1"); await set([{ sku, loc: "CARTON", qty: 1 }]); }
  catch { threw = true; } finally { await q("ROLLBACK TO SAVEPOINT s1"); }
  ok(threw, "loc_set refuses to write into a packed carton");

  console.log("\nthe move is logged");
  const mv = await q(
    "SELECT action, from_carton FROM ims_rack_moves WHERE variant_sku=$1 ORDER BY id DESC LIMIT 1", [sku]);
  ok(mv[0]?.action?.startsWith("set_"), "logged as a stock-register set", JSON.stringify(mv[0]));

  const after = await overclaimers();
  const added = after.filter((a) => !before.includes(a));
  ok(added.length === 0, "the loader introduced no new over-claim", added.join(", "));
  ok(!after.some((a) => a.startsWith(sku + " ")), "and the SKU it just filled is within stock");
} finally {
  await c.query("ROLLBACK");
  c.release();
  await pool.end();
}
console.log("\n" + pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
