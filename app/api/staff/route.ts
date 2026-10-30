import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { BASE_STAFF, hasLeft } from "@/lib/staff";

export const dynamic = "force-dynamic";

// GET /api/staff — names for the "Sold by" dropdown, as managed in IMS -> Admin
// -> POS staff. A name typed into "Others…" bills fine but doesn't join the list;
// that's the admin's call now.
export async function GET() {
  noStore();
  try {
    const rows = await sql`SELECT name FROM pos_staff ORDER BY lower(name)`;
    return NextResponse.json({ names: rows.map((r: any) => r.name) });
  } catch {
    // ponytail: pos_staff comes from e:/vhagar-ims/db/ims-pos-staff-v14.sql. Until
    // that's applied, the old list — standing names + every name already billed,
    // minus people who left. Delete this branch once the table exists.
    const rows = await sql`
      SELECT DISTINCT btrim(sold_by) AS name FROM sales
      WHERE sold_by IS NOT NULL AND btrim(sold_by) <> ''`;
    const names = [...new Set([...BASE_STAFF, ...rows.map((r: any) => r.name as string)])]
      .filter((n) => !hasLeft(n))
      .sort((a, b) => a.localeCompare(b));
    return NextResponse.json({ names });
  }
}
