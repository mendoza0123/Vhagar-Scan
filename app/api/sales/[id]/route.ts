import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { billNo } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";

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

// PATCH /api/sales/123 — { action:'void' } restocks + voids; otherwise edits
// the non-stock bill fields (name/phone/address/payment/note). Item/qty changes
// are done by voiding and re-selling — safer than mutating stock in place.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  const body = await req.json().catch(() => ({}));

  if (body?.action === "void") {
    try {
      const by = body?.by?.toString().trim() || null;
      const [{ void_sale: ok }] = await sql`SELECT void_sale(${id}, ${by}) AS void_sale`;
      return NextResponse.json({ ok, status: "void" });
    } catch (e: any) {
      return NextResponse.json({ error: "void_failed", message: e?.message || "Could not void" }, { status: 400 });
    }
  }

  const name = body?.customer_name?.toString().trim() || null;
  // mobile is mandatory on every bill — reject an edit that would break it
  const phone = normalizePhone(body?.customer_phone?.toString());
  if (!phone)
    return NextResponse.json(
      { error: "invalid_phone", message: "Enter a valid 10-digit mobile number." }, { status: 400 });
  const email = body?.customer_email?.toString().trim() || null;
  const address = body?.address?.toString().trim() || null;
  const note = body?.note?.toString().trim() || null;
  // freebies can be granted after the sale (customer came back for the cap)
  const freebie = body?.freebie?.toString().trim() || null;
  // sold_by is correctable post-sale (wrong person picked at the till)
  const soldBy = body?.sold_by?.toString().trim() || null;
  // payment can be split ("cash + upi") — keep known tokens only
  const pmTokens = (body?.payment_method || "").toString().toLowerCase().split(/[^a-z]+/)
    .filter((t: string, i: number, a: string[]) => ["cash", "card", "upi", "other"].includes(t) && a.indexOf(t) === i);
  const pm = pmTokens.length ? pmTokens.join(" + ") : null;

  await sql`UPDATE sales SET
      customer_name = ${name}, customer_phone = ${phone}, customer_email = ${email},
      delivery_method = ${address}, note = ${note}, freebie = ${freebie},
      sold_by = COALESCE(${soldBy}, sold_by),
      payment_method = COALESCE(${pm}, payment_method)
    WHERE id = ${id} AND status = 'completed'`;
  return NextResponse.json({ ok: true });
}
