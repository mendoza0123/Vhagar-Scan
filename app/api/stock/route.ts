import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/stock            → full live stock (for the Stock screen).
// GET /api/stock?skus=a,b,c → just those variants (checkout re-check, small payload).
export async function GET(req: NextRequest) {
  noStore();
  const skusParam = req.nextUrl.searchParams.get("skus");

  if (skusParam) {
    const skus = skusParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (skus.length === 0) return NextResponse.json([]);

    const rows = await sql`
      SELECT variant_sku, qty_on_hand, needs_price, price::float8 AS price
      FROM variants
      WHERE variant_sku = ANY(${skus}::text[])`;
    return NextResponse.json(rows);
  }

  const rows = await sql`SELECT * FROM v_stock`;
  return NextResponse.json(rows);
}
