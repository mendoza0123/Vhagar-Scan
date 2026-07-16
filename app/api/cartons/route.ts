import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// The carton store lives in the IMS (ims_cartons / ims_carton_items — pack,
// edit and delete happen there). This feed powers the Admin "Carton QR labels"
// bulk-print: every carton with a contents summary grouped by product.
export async function GET() {
  noStore();
  // status='Packed' means REAL BOXES ONLY. The display rack is status='Rack' and
  // must never reach this feed — it has no QR and no sticker, by design.
  const cartons = (await sql`
    SELECT carton_no, note AS label, location, total_qty
    FROM ims_cartons WHERE status = 'Packed' ORDER BY carton_no`) as any[];
  const rows = (await sql`
    SELECT carton_id, name, size, qty FROM v_carton_contents
    WHERE status = 'Packed' ORDER BY name, size`) as any[];

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
