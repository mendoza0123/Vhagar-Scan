import { NextResponse } from "next/server";

// Thin alias over /api/ims so there is ONE route that calls the IMS (one GAS
// round-trip, one cache). Returns the legacy { [style_code]: imageUrl } shape.
// /stock now reads /api/ims directly; this stays for any other/legacy consumer.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const r = await fetch(new URL("/api/ims", req.url), { cache: "no-store" });
    const data = await r.json().catch(() => ({ styles: {} }));
    const map: Record<string, string> = {};
    for (const [code, s] of Object.entries(data.styles || {}) as [string, any][]) {
      if (s?.image_url) map[code] = s.image_url;
    }
    return NextResponse.json(map);
  } catch {
    return NextResponse.json({});
  }
}
