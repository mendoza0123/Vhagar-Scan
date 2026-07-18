import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { billNo } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

type IncomingItem = { sku: string; qty: number; price: number };

// POST /api/sales — atomic checkout through process_sale().
// Body: { items:[{sku,qty,price}], discount?, customer?, soldBy?, note? }
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const rawItems: any[] = Array.isArray(body?.items) ? body.items : [];
  const discount = Math.max(0, Number(body?.discount) || 0);
  const soldBy: string | null = body?.soldBy?.toString().trim() || null;
  const note: string | null = body?.note?.toString().trim() || null;
  const customerName: string | null =
    body?.customer?.name?.toString().trim() || null;
  // Server-side guard, not just UI: a sale needs a name and a REAL mobile —
  // it's the customer's ID on the bill and where the bill gets WhatsApped.
  const customerPhone = normalizePhone(body?.customer?.phone?.toString());
  if (!customerName || customerName.length < 2)
    return NextResponse.json(
      { error: "name_required", message: "Enter the customer's name." }, { status: 400 });
  if (!customerPhone)
    return NextResponse.json(
      { error: "invalid_phone", message: "Enter a valid 10-digit mobile number." }, { status: 400 });
  const address: string | null = body?.customer?.address?.toString().trim() || null;
  const customerEmail: string | null = body?.customer?.email?.toString().trim() || null;
  const channel: string | null = body?.channel?.toString().trim() || null;
  const freebie: string | null = body?.freebie?.toString().trim() || null;
  const offer: string | null = body?.offer?.toString().trim() || null;
  // Payment can be split ("cash + upi") — keep only known tokens, joined stably.
  const pmTokens = (body?.paymentMethod || "cash").toString().toLowerCase().split(/[^a-z]+/)
    .filter((t: string, i: number, a: string[]) => ["cash", "card", "upi", "other"].includes(t) && a.indexOf(t) === i);
  const paymentMethod = pmTokens.length ? pmTokens.join(" + ") : "cash";

  // ---- validate the cart ----
  const items: IncomingItem[] = [];
  for (const it of rawItems) {
    const sku = it?.sku?.toString().trim().toUpperCase();
    const qty = Math.trunc(Number(it?.qty));
    const price = Number(it?.price);
    if (!sku) return NextResponse.json({ error: "item_missing_sku" }, { status: 400 });
    if (!Number.isFinite(qty) || qty < 1)
      return NextResponse.json({ error: "bad_qty", sku }, { status: 400 });
    if (!Number.isFinite(price) || price < 0)
      return NextResponse.json({ error: "bad_price", sku }, { status: 400 });
    items.push({ sku, qty, price });
  }
  if (items.length === 0)
    return NextResponse.json({ error: "empty_cart" }, { status: 400 });

  // ---- defensive needs_price guard (the UI enforces this too) ----
  const skus = items.map((i) => i.sku);
  const meta = await sql`
    SELECT variant_sku, needs_price, qty_on_hand
    FROM variants WHERE variant_sku = ANY(${skus}::text[])`;
  const metaBySku = new Map(meta.map((m: any) => [m.variant_sku, m]));

  for (const it of items) {
    const m = metaBySku.get(it.sku);
    if (!m) return NextResponse.json({ error: "unknown_sku", sku: it.sku }, { status: 400 });
    if (m.needs_price && it.price <= 0)
      return NextResponse.json({ error: "needs_price", sku: it.sku }, { status: 400 });
  }

  // A rehearsal bill (TEST FABRIC only) is not business: it gets its own
  // VH-2026-TestNN series and is kept out of the Sales log + CSV, so staff can
  // practise mid-exhibition without polluting takings.
  const isTest = items.every((i) => i.sku.startsWith("VH-TEST"));

  // ---- atomic checkout ----
  try {
    const payload = JSON.stringify(items);
    const rows = await sql`
      SELECT process_sale(
        ${payload}::jsonb,
        NULL,
        ${discount},
        ${customerName},
        ${customerPhone},
        ${paymentMethod},
        ${soldBy},
        ${note}
      ) AS id`;
    const id = Number(rows[0].id);
    // nextval, not a row count — two counters billing at once must never be
    // handed the same number. Keeps the real series gapless despite test bills.
    const [{ n }] = await sql`
      SELECT nextval(${isTest ? "sales_test_seq" : "sales_bill_seq"}::regclass)::int AS n`;
    const bill_no = isTest
      ? `VH-2026-Test${String(n).padStart(2, "0")}`
      : `VH-2026-${String(n).padStart(4, "0")}`;

    // Deduct the sold pieces from whichever carton(s) hold them, so the box
    // index tracks reality. Best-effort: a piece from the display rack simply
    // isn't in any carton, and a failure here never blocks the sale.
    try {
      await sql`SELECT cartons_consume(${payload}::jsonb)`;
    } catch {
      /* carton index is a locator; the sale itself already succeeded */
    }

    // Stamp a human-friendly bill number + address (delivery_method) — best
    // effort; both are derivable/optional so a failure here never blocks the sale.
    try {
      await sql`UPDATE sales SET bill_no = ${bill_no}, delivery_method = ${address}, channel = ${channel}, freebie = ${freebie}, offer = ${offer}, customer_email = ${customerEmail}, is_test = ${isTest} WHERE id = ${id}`;
    } catch {
      /* ignore — bill_no is derivable from id at read time */
    }

    return NextResponse.json({ id, bill_no }, { status: 201 });
  } catch (err: any) {
    // 23514 = check_violation → qty_on_hand would go negative (oversell).
    const code = err?.code;
    const msg: string = err?.message || "";
    const isOversell = code === "23514" || /qty_on_hand|check constraint/i.test(msg);

    if (isOversell) {
      // Return current stock for the cart so the client can show exactly
      // which lines are short, and keep the cart intact for a retry.
      const stock = await sql`
        SELECT variant_sku, qty_on_hand
        FROM variants WHERE variant_sku = ANY(${skus}::text[])`;
      return NextResponse.json(
        {
          error: "oversell",
          message: "Not enough stock for one or more items — adjust the quantities and try again.",
          stock,
        },
        { status: 409 }
      );
    }

    console.error("checkout failed:", err);
    return NextResponse.json(
      { error: "checkout_failed", message: "Could not complete the sale. Please try again." },
      { status: 500 }
    );
  }
}

// GET /api/sales?date=today — today's bills, newest first (India local day).
export async function GET(req: NextRequest) {
  noStore();
  const date = req.nextUrl.searchParams.get("date");

  // Voided bills STAY in the log (marked void) — a bill that vanishes is a bill
  // nobody can account for. They're excluded from the totals below.
  // Test bills never appear at all.
  const todayOnly = date === "today";
  const rows = todayOnly
    ? await sql`
        SELECT s.id, s.bill_no, s.subtotal::float8 AS subtotal,
               s.discount::float8 AS discount, s.total::float8 AS total,
               s.payment_method, s.customer_name, s.sold_by, s.status, s.created_at,
               (SELECT count(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS item_count
        FROM sales s
        WHERE (s.created_at AT TIME ZONE 'Asia/Kolkata')::date
              = (now() AT TIME ZONE 'Asia/Kolkata')::date
          AND NOT s.is_test
        ORDER BY s.id DESC`
    : await sql`
        SELECT s.id, s.bill_no, s.subtotal::float8 AS subtotal,
               s.discount::float8 AS discount, s.total::float8 AS total,
               s.payment_method, s.customer_name, s.sold_by, s.status, s.created_at,
               (SELECT count(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS item_count
        FROM sales s
        WHERE NOT s.is_test
        ORDER BY s.id DESC
        LIMIT 200`;

  const live = rows.filter((r: any) => r.status === "completed");
  const grandTotal = live.reduce((sum: number, r: any) => sum + Number(r.total), 0);
  const voided = rows.filter((r: any) => r.status === "void");
  return NextResponse.json({
    sales: rows,
    grandTotal,
    count: live.length,
    voidCount: voided.length,
    voidValue: voided.reduce((sum: number, r: any) => sum + Number(r.total), 0),
  });
}
