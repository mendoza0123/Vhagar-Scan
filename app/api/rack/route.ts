import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/rack — location moves, all directions.
//   { items:[{sku,qty}], by?, action:"move" }    carton -> Rack     (rack_move)
//   { items:[{sku,qty}], by?, action:"return" }  Rack -> origin box (rack_return)
//   { sku, qty, target?, by?, action:"adjust" }  Rack -> a CHOSEN box, or off the
//                                                index entirely when target is null
// LOCATION changes only: none of these touch qty_on_hand (only a sale does).
export async function POST(req: NextRequest) {
  noStore();
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (body?.action === "adjust") {
    const sku = body?.sku?.toString().trim().toUpperCase();
    const qty = Math.trunc(Number(body?.qty));
    const target = body?.target?.toString().trim() || null;
    const adjBy = body?.by?.toString().trim() || null;
    if (!sku) return NextResponse.json({ error: "missing_sku" }, { status: 400 });
    if (!Number.isFinite(qty) || qty < 1) return NextResponse.json({ error: "bad_qty" }, { status: 400 });
    try {
      const rows = await sql`SELECT rack_adjust(${sku}, ${qty}, ${adjBy}, ${target}) AS r`;
      return NextResponse.json(rows[0].r); // { taken, target }
    } catch (err: any) {
      // rack_adjust raises human-readable messages ("X is not on the rack.")
      const message = String(err?.message || "Could not update.").replace(/^.*?:\s*/, "").trim();
      return NextResponse.json({ error: "adjust_failed", message }, { status: 400 });
    }
  }

  const raw: any[] = Array.isArray(body?.items) ? body.items : [];
  const items: { sku: string; qty: number }[] = [];
  for (const it of raw) {
    const sku = it?.sku?.toString().trim().toUpperCase();
    const qty = Math.trunc(Number(it?.qty));
    if (!sku) return NextResponse.json({ error: "item_missing_sku" }, { status: 400 });
    if (!Number.isFinite(qty) || qty < 1) return NextResponse.json({ error: "bad_qty", sku }, { status: 400 });
    items.push({ sku, qty });
  }
  if (items.length === 0) return NextResponse.json({ error: "empty" }, { status: 400 });

  const by: string | null = body?.by?.toString().trim() || null;
  const action = body?.action;

  try {
    const rows =
      action === "return"
        ? await sql`SELECT rack_return(${JSON.stringify(items)}::jsonb, ${by}) AS r`
        : action === "display"
        ? await sql`SELECT stage_move(${JSON.stringify(items)}::jsonb, 'DISPLAY', ${by}) AS r`
        : await sql`SELECT stage_move(${JSON.stringify(items)}::jsonb, 'RACK', ${by}) AS r`;
    // move/display: { moved, from_cartons, capped } — capped>0 = would exceed stock
    // return:        { returned, skipped, details:[{sku,carton,qty}] }
    return NextResponse.json(rows[0].r);
  } catch (err: any) {
    const msg: string = err?.message || "";
    if (/Unknown item/i.test(msg)) {
      return NextResponse.json({ error: "unknown_sku", message: msg }, { status: 400 });
    }
    console.error("rack_move failed:", err);
    return NextResponse.json(
      { error: "move_failed", message: "Could not move these to the rack. Try again." },
      { status: 500 }
    );
  }
}
