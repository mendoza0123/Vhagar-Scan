import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/cartons — pack/index a carton (or clear it).
//   { carton, items:[{sku,qty}], mode?:'add'|'set', label?, location?, note? }
//   { carton, clear:true }  → empty the carton's contents
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const carton = body?.carton?.toString().trim().toUpperCase();
  if (!carton) return NextResponse.json({ error: "carton_required" }, { status: 400 });

  if (body?.clear === true) {
    await sql`DELETE FROM carton_items WHERE carton_id = ${carton}`;
    return NextResponse.json({ ok: true, cleared: true });
  }

  const mode = body?.mode === "set" ? "set" : "add";
  const rawItems: any[] = Array.isArray(body?.items) ? body.items : [];
  const items: { sku: string; qty: number }[] = [];
  for (const it of rawItems) {
    const sku = it?.sku?.toString().trim().toUpperCase();
    const qty = Math.trunc(Number(it?.qty));
    if (!sku) return NextResponse.json({ error: "item_missing_sku" }, { status: 400 });
    if (!Number.isFinite(qty)) return NextResponse.json({ error: "bad_qty", sku }, { status: 400 });
    items.push({ sku, qty });
  }
  if (items.length === 0) return NextResponse.json({ error: "empty" }, { status: 400 });

  try {
    const [{ carton_add: result }] = await sql`
      SELECT carton_add(${carton}, ${JSON.stringify(items)}::jsonb, ${mode},
                        ${body?.label ?? null}, ${body?.location ?? null}, ${body?.note ?? null}) AS carton_add`;
    return NextResponse.json({ ok: true, result });
  } catch (err: any) {
    const msg: string = err?.message || "";
    if (err?.code === "23514" || /carton_items_qty_check/i.test(msg))
      return NextResponse.json({ error: "underflow", message: "That would drop the box below zero." }, { status: 409 });
    // friendly business errors from the function (unknown item / remove-missing)
    const clean = msg.replace(/^.*?:\s*/, "").trim();
    if (/unknown item|not in carton|below zero|required|invalid mode/i.test(msg))
      return NextResponse.json({ error: "rejected", message: clean }, { status: 400 });
    console.error("carton_add failed:", msg);
    return NextResponse.json({ error: "failed", message: "Could not update the carton." }, { status: 500 });
  }
}
