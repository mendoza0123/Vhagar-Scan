import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/labels/tags — the extra particulars the RETAIL hang-tag needs that
// the booth sticker never did: the EAN, and the month/year the style was
// registered (which is what we declare as month of manufacture).
//
// Deliberately NOT folded into v_stock: the booth reads that view by name on the
// scan→bill path, and this is a back-office screen. One small join of its own is
// cheaper than touching the thing the till depends on.
export async function GET() {
  noStore();
  const rows = await sql`
    SELECT v.variant_sku,
           v.ean13,
           -- Registered at midnight IST, which is 18:30 the PREVIOUS day in UTC —
           -- read it in UTC and a style registered on the 1st declares last month.
           to_char(p.created_at AT TIME ZONE 'Asia/Kolkata', 'MM/YYYY') AS mfg
    FROM variants v
    JOIN products p ON p.style_code = v.style_code`;
  return NextResponse.json(rows);
}
