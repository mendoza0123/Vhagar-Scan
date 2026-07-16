import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/rack — bulk "unpack onto the rack".
// Body: { items:[{sku,qty}], by? }
// Pieces move carton -> Rack. This is a LOCATION change only: rack_move never
// touches qty_on_hand (only a sale does). Atomic — one plpgsql call.
export async function POST(req: NextRequest) {
  noStore();
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
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

  try {
    const rows = await sql`SELECT rack_move(${JSON.stringify(items)}::jsonb, ${by}) AS r`;
    // { moved, from_cartons, capped } — capped>0 means the index would have
    // claimed more pieces than we own (usually a double-scan); surfaced, not hidden.
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
