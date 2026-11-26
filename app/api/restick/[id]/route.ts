import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { getBatch, markPrinted, restickError } from "@/lib/restick";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/restick/<id> → one batch + its codes (the print sheet reads this)
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  if (!UUID.test(params.id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  try {
    const b = await getBatch(params.id);
    return b ? NextResponse.json(b) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (err) {
    const e = restickError(err);
    return NextResponse.json(e, { status: e.status });
  }
}

// POST /api/restick/<id> → mark its labels printed (harmless, so no PIN)
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  if (!UUID.test(params.id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  try {
    await markPrinted(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = restickError(err);
    return NextResponse.json(e, { status: e.status });
  }
}
