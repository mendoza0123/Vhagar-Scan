import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/units?skus=VH-TEE1-M,VH-TEE1-L
// Per-piece unit codes (in-stock) for the given t-shirt variants, so the label
// sheet can print one unique QR sticker per physical tee. Shirts have no units
// and simply return nothing for their skus.
export async function GET(req: NextRequest) {
  noStore();
  const skus = (req.nextUrl.searchParams.get("skus") || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (skus.length === 0) return NextResponse.json({ units: {} });

  const rows = await sql`
    SELECT variant_sku, unit_code FROM ims_units
    WHERE variant_sku = ANY(${skus}::text[]) AND status = 'in_stock'
    ORDER BY unit_code`;

  const units: Record<string, string[]> = {};
  for (const r of rows as any[]) (units[r.variant_sku] ||= []).push(r.unit_code);
  return NextResponse.json({ units });
}
