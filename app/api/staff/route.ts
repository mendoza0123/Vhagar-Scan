import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/staff — names for the "Sold by" dropdown.
//
// No staff table: the list IS the set of names already used on sales. So a name
// typed into "Others…" joins the dropdown the moment it's billed, on every
// device, with nothing to maintain. The client unions this with its base names.
export async function GET() {
  noStore();
  const rows = await sql`
    SELECT DISTINCT btrim(sold_by) AS name
    FROM sales
    WHERE sold_by IS NOT NULL AND btrim(sold_by) <> ''
    ORDER BY 1`;
  return NextResponse.json({ names: rows.map((r: any) => r.name) });
}
