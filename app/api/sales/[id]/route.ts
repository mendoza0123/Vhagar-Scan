import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { billNo } from "@/lib/format";

export const dynamic = "force-dynamic";

// GET /api/sales/123 — one bill with its line items (for the bill view).
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  noStore(); // live data — never serve a cached bill
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const saleRows = await sql`
    SELECT id, bill_no, subtotal::float8 AS subtotal, discount::float8 AS discount,
           total::float8 AS total, payment_method, customer_name, customer_phone,
           delivery_method, note, sold_by, status, created_at
    FROM sales WHERE id = ${id}`;

  if (saleRows.length === 0) {
    return NextResponse.json({ error: "not_found", id }, { status: 404 });
  }
  const sale = saleRows[0] as any;

  const items = await sql`
    SELECT variant_sku, name, size, unit_price::float8 AS unit_price,
           qty, line_total::float8 AS line_total
    FROM sale_items WHERE sale_id = ${id} ORDER BY id`;

  return NextResponse.json({
    ...sale,
    bill_no: sale.bill_no ?? billNo(sale.id),
    items,
  });
}
