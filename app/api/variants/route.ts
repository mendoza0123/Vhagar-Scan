import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL", "5XL"];

// GET /api/variants?q=earth  → manual search fallback for when a tag won't scan.
// Matches SKU, style name, or style code (case-insensitive).
//
// The Move-pieces hand picker needs whole designs, not 50 sizes — one name like
// "FRENCH TERRY" covers 24 designs and 143 sizes — so it asks in two steps:
//   ?q=lio linen&by=style  → one row per design
//   ?style=VH-LL02_        → every size of that design, S → 3XL
export async function GET(req: NextRequest) {
  noStore();
  const style = (req.nextUrl.searchParams.get("style") || "").trim();
  if (style) {
    const rows = await sql`
      SELECT variant_sku, style_code, name, color, size,
             price::float8 AS price, needs_price, qty_on_hand, category
      FROM v_stock
      WHERE style_code = ${style}
      ORDER BY COALESCE(array_position(${SIZE_ORDER}::text[], upper(size)), 99), size`;
    return NextResponse.json(rows);
  }

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 1) return NextResponse.json([]);

  const like = `%${q}%`;
  if (req.nextUrl.searchParams.get("by") === "style") {
    const rows = await sql`
      SELECT style_code, name, color, SUM(qty_on_hand)::int AS qty_on_hand
      FROM v_stock
      WHERE variant_sku ILIKE ${like}
         OR name        ILIKE ${like}
         OR style_code  ILIKE ${like}
      GROUP BY style_code, name, color
      ORDER BY name, style_code
      LIMIT 80`;
    return NextResponse.json(rows);
  }

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
