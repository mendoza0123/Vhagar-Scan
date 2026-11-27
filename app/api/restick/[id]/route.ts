import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { getBatch, markPrinted, parseEdit, editBatch, voidBatch, deleteBatch, isUuid, restickError } from "@/lib/restick";

export const dynamic = "force-dynamic";

// Changing a re-stick changes stock, so edit / void / delete carry the booth PIN
// and the name of who did it; the server checks the PIN.
function gate(b: any, id: string): { res: NextResponse } | { by: string } {
  if (!isUuid(id)) return { res: NextResponse.json({ error: "bad_id" }, { status: 400 }) };
  const expected = process.env.ADMIN_PIN;
  if (!expected) return { res: NextResponse.json({ error: "admin_pin_unset", message: "The booth PIN isn't set up." }, { status: 500 }) };
  if (b?.pin?.toString() !== expected)
    return { res: NextResponse.json({ error: "bad_pin", message: "Wrong PIN — open Admin and enter it again." }, { status: 401 }) };
  const by = String(b?.by ?? "").trim().slice(0, 60);
  if (!by) return { res: NextResponse.json({ error: "no_name", message: "Pick who is doing this." }, { status: 400 }) };
  return { by: `${by} (POS)` };
}
const fail = (err: unknown) => { const e = restickError(err); return NextResponse.json(e, { status: e.status }); };

// GET /api/restick/<id> → one batch + its sizes and codes (print sheet, edit form)
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  if (!isUuid(params.id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  try {
    const b = await getBatch(params.id);
    return b ? NextResponse.json(b) : NextResponse.json({ error: "not_found", message: "That re-stick no longer exists." }, { status: 404 });
  } catch (err) { return fail(err); }
}

// POST /api/restick/<id>                        → mark its labels printed (harmless, no PIN)
// POST /api/restick/<id> {action:"void",pin,by} → undo it, keep the record
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  const b = await req.json().catch(() => ({}));
  if (b?.action === "void") {
    const g = gate(b, params.id);
    if ("res" in g) return g.res;
    try { return NextResponse.json(await voidBatch(params.id, g.by)); } catch (err) { return fail(err); }
  }
  if (!isUuid(params.id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  try { await markPrinted(params.id); return NextResponse.json({ ok: true }); } catch (err) { return fail(err); }
}

// PATCH /api/restick/<id> {pin,by,rack,remark,lines:[{sku,counted}]} → edit in place
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  const b = await req.json().catch(() => ({}));
  const g = gate(b, params.id);
  if ("res" in g) return g.res;
  const input = parseEdit(b);
  if (typeof input === "string") return NextResponse.json({ error: "bad_input", message: input }, { status: 400 });
  try { return NextResponse.json(await editBatch(params.id, input, g.by)); } catch (err) { return fail(err); }
}

// DELETE /api/restick/<id> {pin,by} → undo (if active) and remove the record
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore();
  const b = await req.json().catch(() => ({}));
  const g = gate(b, params.id);
  if ("res" in g) return g.res;
  try { await deleteBatch(params.id, g.by); return NextResponse.json({ ok: true }); } catch (err) { return fail(err); }
}
