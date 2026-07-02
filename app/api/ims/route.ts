import { NextResponse } from "next/server";

// Live stock + product photos from the Vhagar IMS (Google Apps Script web app).
// MUST be server-side: GAS sets no CORS headers and /exec 302-redirects to
// script.googleusercontent.com (Node fetch follows redirects automatically).
// Configure GAS_STOCK_URL (+ GAS_API_TOKEN) in env; returns a graceful empty
// payload (and logs) when unconfigured or on any failure so /stock never breaks.
//
// GET /api/ims -> { ok, generated_at, styles: { [style_code]: { name, in_hand, sizes, image_url } } }
// Dynamic so it's never pre-rendered empty at build (cold GAS fetch); the GAS
// call itself is cached 45s at the data layer, so it's still "live enough" + cheap.
export const dynamic = "force-dynamic";
const FETCH_REVALIDATE = 45;

type ImsStyle = {
  name: string;
  in_hand: number;
  sizes: Record<string, number>;
  image_url: string | null;
};

const EMPTY = { ok: false, generated_at: null as string | null, styles: {} as Record<string, ImsStyle> };

// Canonical style code — must match Neon style_code. IMS codes carry a trailing
// "_" / stray case (VH-KN91_, vh-ep10); Neon uses VH-EP10. Trailing A/B/C are
// real distinct styles, so only strip underscores.
function normCode(raw: unknown): string {
  return String(raw ?? "").trim().replace(/_+$/, "").toUpperCase();
}
const num = (v: unknown) => Number(v) || 0;

export async function GET() {
  const base = process.env.GAS_STOCK_URL;
  const token = process.env.GAS_API_TOKEN || "";
  if (!base) return NextResponse.json(EMPTY);

  try {
    const u = new URL(base);
    u.searchParams.set("action", "stock");
    if (token) u.searchParams.set("token", token);

    // hard timeout so a stalled GAS call can't hang the Stock screen
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(u.toString(), { next: { revalidate: FETCH_REVALIDATE }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("json")) {
      // "Anyone with Google account" deploy setting 302s to an HTML login page.
      console.error("IMS /api/ims: non-JSON response", res.status, ct, res.url);
      return NextResponse.json(EMPTY);
    }
    const data = await res.json().catch(() => null);
    if (!data || data.ok === false || !Array.isArray(data.products)) {
      console.error("IMS /api/ims: error payload", data?.error);
      return NextResponse.json(EMPTY);
    }

    const styles: Record<string, ImsStyle> = {};
    for (const p of data.products) {
      const code = normCode(p.style_no ?? p.style_code);
      if (!code) continue;
      const s = p.sizes || {};
      styles[code] = {
        name: String(p.product_name ?? p.name ?? "").replace(/\s+/g, " ").trim(),
        in_hand: num(p.in_hand),
        sizes: {
          S: num(s.S), M: num(s.M), L: num(s.L),
          XL: num(s.XL), "2XL": num(s["2XL"]), "3XL": num(s["3XL"]),
        },
        // GAS returns raw image_id; the POS owns the thumbnail size (=s400).
        image_url: p.image_id ? `https://lh3.googleusercontent.com/d/${p.image_id}=s400` : null,
      };
    }
    return NextResponse.json({ ok: true, generated_at: data.generated_at ?? null, styles });
  } catch (e) {
    console.error("IMS /api/ims: fetch failed", (e as Error)?.message);
    return NextResponse.json(EMPTY);
  }
}
