# Vhagar POS

Scan-to-bill POS with live inventory for **Vhagar Clothing**, built for the **Bharat Tex 2026** booth.
Staff scan a garment's QR → cart → cash bill → stock decrements live.

**Stack:** Next.js 14 (PWA) · Neon Postgres · Tailwind · Vercel.
**Scale:** 103 styles · 318 variants · 677 pieces.

## Quick start
```bash
npm install
cp .env.example .env.local          # paste your Neon pooled DATABASE_URL
npm run db:schema                    # create tables + process_sale()
npm run db:seed                      # load the 103/318/677 catalog
npm run dev                          # http://localhost:3000
```

## Database
- `db/schema.sql` — tables, the `process_sale()` atomic checkout function, and the `v_stock` view.
- `db/seed.sql` — generated catalog data. Regenerate from the CSVs with `db/gen-seed.ps1`.
- Apply either file ad-hoc with `node scripts/run-sql.mjs <file.sql>`.

## What's built vs. to build
**Scaffold (done):** project config, DB schema + seed, Neon client, home menu, route stubs, PWA manifest.
**To build (see `BUILD-PROMPT.md` + `CLAUDE.md`):** the Scan & Sell, Stock, Sales, and Admin/QR-label screens, plus their API routes.

## Deploy
Push to GitHub → import to Vercel → add `DATABASE_URL` env var → deploy. HTTPS (required for the camera) is automatic.
