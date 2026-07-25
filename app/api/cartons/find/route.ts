import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// Locations worth reporting: real boxes AND the rack. Everything else
// (Shipped/Cancelled) is gone from the booth.
// Sizes sort naturally, not alphabetically (S < M < L < XL, not L < M < S).
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL", "FREE", "FS"];

// GET /api/cartons/find
//   ?sku=VH-EP04-M  → scan a hanging display piece: the WHOLE style's stock,
//                     per size, and where each size physically is.
//   ?q=lio linen    → the older text search (which box holds a product).
export async function GET(req: NextRequest) {
  noStore();
  const sku = req.nextUrl.searchParams.get("sku")?.trim().toUpperCase() || "";

  // ---- scan mode: one tag in, the whole style out ----
  if (sku) {
    const hit = await sql`
      SELECT v.style_code, p.name
      FROM variants v JOIN products p ON p.style_code = v.style_code
      WHERE v.variant_sku = ${sku}`;
    if (hit.length === 0) {
      return NextResponse.json({ error: "unknown_sku", sku }, { status: 404 });
    }
    const { style_code, name } = hit[0] as any;

    const sizes = await sql`
      SELECT v.variant_sku, v.size, v.qty_on_hand,
             COALESCE(
               json_agg(
                 json_build_object('carton', vc.carton_id, 'location', vc.location,
                                   'qty', vc.qty, 'isRack', vc.status = 'Rack',
                                   'isDisplay', vc.status = 'Display')
                 ORDER BY (vc.status IN ('Rack','Display')) DESC, vc.qty DESC, vc.carton_id
               ) FILTER (WHERE vc.carton_id IS NOT NULL),
               '[]'::json
             ) AS places
      FROM variants v
      LEFT JOIN v_carton_contents vc
             ON vc.variant_sku = v.variant_sku
            AND vc.status IN ('Packed', 'Rack', 'Display')
      WHERE v.style_code = ${style_code}
      GROUP BY v.variant_sku, v.size, v.qty_on_hand
      ORDER BY COALESCE(array_position(${SIZE_ORDER}::text[], upper(v.size)), 99), v.size`;

    return NextResponse.json({ scanned: sku, style_code, name, sizes });
  }

  // ---- browse mode: everything indexed (rack + boxes), for the no-typing
  //      card list on /find. ~a few hundred small rows; fine on the hotspot.
  if (req.nextUrl.searchParams.get("browse")) {
    const results = await sql`
      SELECT carton_id, location, variant_sku, name, size, qty,
             status = 'Rack' AS is_rack, status = 'Display' AS is_display
      FROM v_carton_contents
      WHERE status IN ('Packed', 'Rack', 'Display')
      ORDER BY name, size
      LIMIT 1500`;
    return NextResponse.json({ results });
  }

  // ---- text mode: unchanged, except the rack is a place too ----
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (q.length < 2) return NextResponse.json({ results: [] });
  const like = `%${q}%`;
  const results = await sql`
    SELECT carton_id, location, variant_sku, name, size, qty,
           status = 'Rack' AS is_rack, status = 'Display' AS is_display
    FROM v_carton_contents
    WHERE status IN ('Packed', 'Rack', 'Display')
      AND (name ILIKE ${like} OR variant_sku ILIKE ${like} OR style_code ILIKE ${like})
    ORDER BY name, size, (status IN ('Rack','Display')) DESC, qty DESC
    LIMIT 100`;
  return NextResponse.json({ results });
}
