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
  const scanned = decodeURIComponent(params.sku || "").trim().toUpperCase();
  if (!scanned) {
    return NextResponse.json({ error: "missing_sku" }, { status: 400 });
  }
  // A scanned code may be a per-piece t-shirt unit (VH-TEE1-M-0001) or a plain
  // variant QR — variant_of() resolves the former to its variant, passes the
  // latter through, so pricing/stock stay identical for both.
  const [{ sku }] = await sql`SELECT variant_of(${scanned}) AS sku`;

  const rows = await sql`
    SELECT variant_sku, style_code, name, color, size,
           price::float8 AS price, needs_price, qty_on_hand, category
    FROM v_stock
    WHERE variant_sku = ${sku}
    LIMIT 1`;

  if (rows.length === 0) {
    return NextResponse.json({ error: "not_found", sku }, { status: 404 });
  }
  // variant_of only rewrites the code when it WAS a per-piece unit, so a
  // changed code is the tell. Hand it back: without it the unique sticker is
  // thrown away here and checkout can't mark that exact tee sold.
  // An old sticker still sells (never block the booth) but the screen says so:
  // a voided code, or a size's shared QR once that size has been re-stuck.
  // Best-effort — before the re-stick migration the tables aren't there.
  let old_sticker = false;
  try {
    const [o] = await sql`
      SELECT (SELECT status FROM ims_units WHERE unit_code = ${scanned}) AS unit_status,
             EXISTS (SELECT 1 FROM ims_restick_lines l JOIN ims_restick r ON r.id = l.restick_id
                      WHERE l.variant_sku = ${sku} AND r.voided_at IS NULL) AS restuck`;
    old_sticker = o.unit_status === "void" || (sku === scanned && o.restuck === true);
  } catch { /* not switched on yet */ }
  return NextResponse.json({ ...rows[0], unit_code: sku === scanned ? null : scanned, old_sticker });
}
