import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// The carton store is SHARED with the IMS (ims_cartons / ims_carton_items).
// IMS packs via its form (pack_carton); the booth scan-packs via ims_carton_add.

// GET /api/cartons — every carton with a contents summary grouped by product
// (feeds the "print label with contents" flow).
export async function GET() {
  noStore();
  const cartons = (await sql`
    SELECT carton_no, note AS label, location, total_qty
    FROM ims_cartons WHERE status <> 'Cancelled' ORDER BY carton_no`) as any[];
  const rows = (await sql`
    SELECT carton_id, name, size, qty FROM v_carton_contents ORDER BY name, size`) as any[];

  const byCarton = new Map<string, any[]>();
  for (const r of rows) {
    const arr = byCarton.get(r.carton_id) || [];
    arr.push(r);
    byCarton.set(r.carton_id, arr);
  }
  const out = cartons.map((c) => {
    const items = byCarton.get(c.carton_no) || [];
    // group lines by product name: EARTH PLAIN 04 ×5 (M×2 · L×3)
    const groups = new Map<string, { name: string; total: number; sizes: string[] }>();
    for (const it of items) {
      const g = groups.get(it.name) || { name: it.name, total: 0, sizes: [] as string[] };
      g.total += it.qty;
      g.sizes.push(`${it.size}×${it.qty}`);
      groups.set(it.name, g);
    }
    return {
      carton_id: c.carton_no,
      label: c.label,
      location: c.location,
      pieces: items.reduce((n, it) => n + it.qty, 0),
      products: Array.from(groups.values()).map((g) => ({
        name: g.name,
        total: g.total,
        sizes: g.sizes.join(" · "),
      })),
    };
  });
  return NextResponse.json({ cartons: out });
}

// POST /api/cartons — scan-pack into a carton (auto-creates from a blank label).
//   { carton, items:[{sku,qty}], mode?:'add'|'set', location? }
//   { carton, clear:true }  → empty the carton's contents
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const carton = body?.carton?.toString().trim().toUpperCase();
  if (!carton) return NextResponse.json({ error: "carton_required" }, { status: 400 });

  if (body?.clear === true) {
    await sql`DELETE FROM ims_carton_items
              WHERE carton_id = (SELECT id FROM ims_cartons WHERE carton_no = ${carton})`;
    await sql`UPDATE ims_cartons SET total_qty = 0 WHERE carton_no = ${carton}`;
    return NextResponse.json({ ok: true, cleared: true });
  }

  const mode = body?.mode === "set" ? "set" : "add";
  const rawItems: any[] = Array.isArray(body?.items) ? body.items : [];
  const items: { sku: string; qty: number }[] = [];
  for (const it of rawItems) {
    const sku = it?.sku?.toString().trim().toUpperCase();
    const qty = Math.trunc(Number(it?.qty));
    if (!sku) return NextResponse.json({ error: "item_missing_sku" }, { status: 400 });
    if (!Number.isFinite(qty)) return NextResponse.json({ error: "bad_qty", sku }, { status: 400 });
    items.push({ sku, qty });
  }
  if (items.length === 0) return NextResponse.json({ error: "empty" }, { status: 400 });

  try {
    const [{ result }] = await sql`
      SELECT ims_carton_add(${carton}, ${JSON.stringify(items)}::jsonb, ${mode},
                            'booth-pos', ${body?.location ?? null}) AS result`;
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    const msg: string = err?.message || "";
    const clean = msg.replace(/^.*?:\s*/, "").trim();
    if (/cannot remove more|below zero|unknown item|required|invalid mode/i.test(msg))
      return NextResponse.json({ error: "rejected", message: clean }, { status: 400 });
    console.error("ims_carton_add failed:", msg);
    return NextResponse.json({ error: "failed", message: "Could not update the carton." }, { status: 500 });
  }
}
