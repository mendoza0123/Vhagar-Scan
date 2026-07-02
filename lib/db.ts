import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Lazily create the Neon client on first query rather than at import time.
// This keeps `next build` working even if DATABASE_URL isn't present during
// the build step (e.g. before env vars are wired on a fresh deploy); the URL
// is only required when a query actually executes at runtime.
let _client: NeonQueryFunction<false, false> | null = null;
function client(): NeonQueryFunction<false, false> {
  if (_client) return _client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env.local");
  }
  _client = neon(url);
  return _client;
}

// `sql` is a tagged-template query function. Parameters are automatically
// escaped, so `sql`SELECT * FROM variants WHERE variant_sku = ${sku}`` is safe.
// The wrapper just forwards the tagged-template call to the lazy client.
export const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
  (client() as any)(strings, ...values)) as NeonQueryFunction<false, false>;

export type Variant = {
  variant_sku: string;
  style_code: string;
  name: string;
  color: string | null;
  size: string;
  price: string;
  needs_price: boolean;
  qty_on_hand: number;
  category: string | null;
};
