import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/cartons/find?q=lio — which carton(s) hold a product.
// Searches the shared carton index by product name / SKU / style code.
export async function GET(req: NextRequest) {
  noStore();
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (q.length < 2) return NextResponse.json({ results: [] });
  const like = `%${q}%`;

  const results = await sql`
    SELECT carton_id, location, variant_sku, name, size, qty
    FROM v_carton_contents
    WHERE status = 'Packed'
      AND (name ILIKE ${like} OR variant_sku ILIKE ${like} OR style_code ILIKE ${like})
    ORDER BY name, size, qty DESC
    LIMIT 100`;
  return NextResponse.json({ results });
}
