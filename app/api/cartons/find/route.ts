import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/cartons/find?sku=VH-EP04-XL
// Resolve the style, then return EVERY size of that style with the carton(s) that hold it.
// Powers the whole Find UX in one round-trip (scan a sample, pick the wanted size).
export async function GET(req: NextRequest) {
  noStore();
  const sku = (req.nextUrl.searchParams.get("sku") || "").trim().toUpperCase();
  if (!sku) return NextResponse.json({ error: "sku_required" }, { status: 400 });

  const hit = await sql`SELECT style_code, name FROM v_stock WHERE variant_sku = ${sku} LIMIT 1`;
  if (hit.length === 0) return NextResponse.json({ error: "not_found", sku }, { status: 404 });
  const { style_code, name } = hit[0] as any;

  const sizes = await sql`
    SELECT variant_sku, size, qty_on_hand FROM v_stock WHERE style_code = ${style_code}`;
  const cartons = await sql`
    SELECT vc.variant_sku, vc.carton_id, vc.label, vc.location, vc.qty
    FROM v_carton_contents vc
    JOIN variants v ON v.variant_sku = vc.variant_sku AND v.style_code = ${style_code}
    ORDER BY vc.qty DESC`;

  const byVariant = new Map<string, any[]>();
  for (const c of cartons as any[]) {
    const arr = byVariant.get(c.variant_sku) || [];
    arr.push({ carton_id: c.carton_id, label: c.label, location: c.location, qty: c.qty });
    byVariant.set(c.variant_sku, arr);
  }
  const out = (sizes as any[]).map((s) => ({ ...s, cartons: byVariant.get(s.variant_sku) || [] }));
  return NextResponse.json({ target_sku: sku, style_code, name, sizes: out });
}
