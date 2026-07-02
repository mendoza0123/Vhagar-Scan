import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";

// POST /api/admin/verify  body { pin }  → 200 if it matches ADMIN_PIN, else 401.
// Booth-grade gate (shared PIN), not real auth.
export async function POST(req: NextRequest) {
  noStore();
  const expected = process.env.ADMIN_PIN;
  if (!expected) {
    return NextResponse.json({ error: "admin_pin_unset" }, { status: 500 });
  }
  let pin = "";
  try {
    pin = (await req.json())?.pin?.toString() ?? "";
  } catch {
    /* ignore */
  }
  if (pin !== expected) {
    return NextResponse.json({ error: "bad_pin" }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
