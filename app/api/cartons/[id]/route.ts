import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/cartons/CTN-0001 — carton header + its indexed contents.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  const id = decodeURIComponent(params.id).trim().toUpperCase();
  if (!id) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const rows = await sql`SELECT carton_id, label, location, note FROM cartons WHERE carton_id = ${id}`;
  if (rows.length === 0) return NextResponse.json({ error: "not_found", id }, { status: 404 });

  const items = await sql`
    SELECT vc.variant_sku, vc.name, vc.size, vc.qty, v.qty_on_hand
    FROM v_carton_contents vc
    JOIN variants v ON v.variant_sku = vc.variant_sku
    WHERE vc.carton_id = ${id}
    ORDER BY vc.name, vc.size`;
  return NextResponse.json({ carton: rows[0], items });
}
