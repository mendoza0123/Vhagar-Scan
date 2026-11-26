import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { findDesigns, styleSizes, recentBatches, progress, parseSave, saveRestick, restickError } from "@/lib/restick";

export const dynamic = "force-dynamic";

// GET /api/restick?q=lio      → designs
// GET /api/restick?style=X    → that design's sizes + its batches
// GET /api/restick            → recent batches (both apps) + progress
export async function GET(req: NextRequest) {
  noStore();
  const p = req.nextUrl.searchParams;
  try {
    const style = (p.get("style") || "").trim();
    if (style) {
      const s = await styleSizes(style);
      if (!s) return NextResponse.json({ error: "not_found", message: "No such product." }, { status: 404 });
      return NextResponse.json({ ...s, batches: await recentBatches(style) });
    }
    const q = (p.get("q") || "").trim();
    if (q) return NextResponse.json({ designs: q.length < 2 ? [] : await findDesigns(q) });
    const [batches, prog] = await Promise.all([recentBatches(), progress()]);
    return NextResponse.json({ batches, progress: prog });
  } catch (err) {
    const e = restickError(err);
    return NextResponse.json(e, { status: e.status });
  }
}

// POST /api/restick  { pin, by, id, style, lines:[{sku,counted,seen}], rack?, remark? }
// Sets stock — so the booth PIN is checked here, not just on the screen.
export async function POST(req: NextRequest) {
  noStore();
  const expected = process.env.ADMIN_PIN;
  if (!expected) return NextResponse.json({ error: "admin_pin_unset", message: "The booth PIN isn't set up." }, { status: 500 });
  const b = await req.json().catch(() => ({}));
  if (b?.pin?.toString() !== expected)
    return NextResponse.json({ error: "bad_pin", message: "Wrong PIN — open Admin and enter it again." }, { status: 401 });
  const by = String(b?.by ?? "").trim().slice(0, 60);
  if (!by) return NextResponse.json({ error: "no_name", message: "Pick who is counting." }, { status: 400 });
  const input = parseSave(b);
  if (typeof input === "string") return NextResponse.json({ error: "bad_input", message: input }, { status: 400 });
  try {
    return NextResponse.json(await saveRestick(input, `${by} (POS)`, "pos"));
  } catch (err) {
    const e = restickError(err);
    return NextResponse.json(e, { status: e.status });
  }
}
