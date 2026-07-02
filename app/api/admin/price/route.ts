import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/admin/price  body { pin, sku, price }
// Sets a confirmed price for a variant and clears needs_price so it can be billed.
export async function POST(req: NextRequest) {
  noStore();
  const expected = process.env.ADMIN_PIN;
  if (!expected) return NextResponse.json({ error: "admin_pin_unset" }, { status: 500 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (body?.pin?.toString() !== expected) {
    return NextResponse.json({ error: "bad_pin" }, { status: 401 });
  }

  const sku = body?.sku?.toString().trim().toUpperCase();
  const price = Number(body?.price);
  if (!sku) return NextResponse.json({ error: "missing_sku" }, { status: 400 });
  if (!Number.isFinite(price) || price <= 0) {
    return NextResponse.json({ error: "bad_price" }, { status: 400 });
  }

  const rows = await sql`
    UPDATE variants
       SET price = ${price}, needs_price = FALSE
     WHERE variant_sku = ${sku}
    RETURNING variant_sku, price::float8 AS price, needs_price`;

  if (rows.length === 0) {
    return NextResponse.json({ error: "unknown_sku", sku }, { status: 404 });
  }
  return NextResponse.json(rows[0]);
}
