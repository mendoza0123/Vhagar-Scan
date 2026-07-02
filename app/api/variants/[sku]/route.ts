import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

// Never cache: stock changes live at the booth.
export const dynamic = "force-dynamic";

// GET /api/variants/VH-EP10-L  → the single variant a scanned QR points at.
export async function GET(
  _req: NextRequest,
  { params }: { params: { sku: string } }
) {
  noStore();
  const sku = decodeURIComponent(params.sku || "").trim().toUpperCase();
  if (!sku) {
    return NextResponse.json({ error: "missing_sku" }, { status: 400 });
  }

  const rows = await sql`
    SELECT variant_sku, style_code, name, color, size,
           price::float8 AS price, needs_price, qty_on_hand, category
    FROM v_stock
    WHERE variant_sku = ${sku}
    LIMIT 1`;

  if (rows.length === 0) {
    return NextResponse.json({ error: "not_found", sku }, { status: 404 });
  }
  return NextResponse.json(rows[0]);
}
