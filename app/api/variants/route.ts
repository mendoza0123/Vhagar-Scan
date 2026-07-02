import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/variants?q=earth  → manual search fallback for when a tag won't scan.
// Matches SKU, style name, or style code (case-insensitive).
export async function GET(req: NextRequest) {
  noStore();
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 1) return NextResponse.json([]);

  const like = `%${q}%`;
  const rows = await sql`
    SELECT variant_sku, style_code, name, color, size,
           price::float8 AS price, needs_price, qty_on_hand, category
    FROM v_stock
    WHERE variant_sku ILIKE ${like}
       OR name        ILIKE ${like}
       OR style_code  ILIKE ${like}
    ORDER BY name, size
    LIMIT 50`;

  return NextResponse.json(rows);
}
