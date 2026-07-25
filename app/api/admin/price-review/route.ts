import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/admin/price-review — styles that look mis-priced: any variant with a
// real-but-tiny price (0 < price < 100). No shirt costs under ₹100, so these are
// data-entry slips (the ₹2/₹3/₹4 kind). Grouped by style so a whole style can be
// fixed in one push. Test fabric excluded.
export async function GET() {
  noStore();
  const rows = (await sql`
    SELECT v.style_code, p.name,
           min(v.price)::float8 AS min_price, max(v.price)::float8 AS max_price,
           count(*)::int AS variants, SUM(v.qty_on_hand)::int AS pieces,
           json_agg(json_build_object('sku', v.variant_sku, 'size', v.size,
                                      'price', v.price::float8, 'qty', v.qty_on_hand)
                    ORDER BY v.size) AS sizes
    FROM variants v JOIN products p ON p.style_code = v.style_code
    WHERE v.price > 0 AND v.price < 100 AND COALESCE(p.category, '') <> 'Test'
    GROUP BY v.style_code, p.name
    ORDER BY p.name`) as any[];
  return NextResponse.json({ styles: rows });
}
