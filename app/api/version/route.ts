import { NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";

export const dynamic = "force-dynamic";

// GET /api/version — which build is currently being served.
// Staff keep the POS open on a phone all day, so after a deploy they carry on
// running the JS they loaded hours ago and a fix looks like it never shipped.
// The client compares this against what it saw on load and offers a reload.
export async function GET() {
  noStore();
  // Vercel sets these per deployment; the fallback keeps local dev quiet.
  const id =
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "dev";
  return NextResponse.json({ id }, { headers: { "Cache-Control": "no-store" } });
}
