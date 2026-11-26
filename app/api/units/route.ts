import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/units?skus=VH-TEE1-M,VH-TEE1-L  → in-stock unit codes for those sizes
// GET /api/units?all=1                     → every in-stock unit code
// Per-piece codes, so the label sheet prints one unique QR per physical piece.
// A size with no codes yet (not re-stuck) returns nothing and keeps the shared QR.
export async function GET(req: NextRequest) {
  noStore();
  const all = req.nextUrl.searchParams.get("all") === "1";
  const skus = (req.nextUrl.searchParams.get("skus") || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!all && skus.length === 0) return NextResponse.json({ units: {} });

  const rows = all
    ? await sql`SELECT variant_sku, unit_code FROM ims_units WHERE status = 'in_stock' ORDER BY unit_code`
    : await sql`
        SELECT variant_sku, unit_code FROM ims_units
        WHERE variant_sku = ANY(${skus}::text[]) AND status = 'in_stock'
        ORDER BY unit_code`;

  const units: Record<string, string[]> = {};
  for (const r of rows as any[]) (units[r.variant_sku] ||= []).push(r.unit_code);
  return NextResponse.json({ units });
}
