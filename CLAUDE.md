# Vhagar POS — project context

A scan-to-bill POS with live inventory for **Vhagar Clothing** (LD Group brand). Used at the
**Bharat Tex 2026 exhibition booth, go-live 2 July 2026**. Staff scan a garment's QR tag with a
phone/tablet → build a cart → generate a simple **cash bill** → stock decrements live.

## Stack (locked)
- **Next.js 14 (App Router) + TypeScript**, PWA, deployed on **Vercel**.
- **Neon Postgres** (serverless) via `@neondatabase/serverless`. Query helper: `lib/db.ts` exports `sql`.
- **Tailwind CSS**. Mobile-first, big thumb-friendly controls (booth use, often one-handed).
- QR **scanning**: `html5-qrcode`. QR **generation**: `qrcode`.
- No realtime service — Neon has none. Keep stock fresh by **polling** (e.g. refetch every few seconds on the Stock screen, and re-check stock at checkout).

## Domain model (see `db/schema.sql`)
- **product** = a style (e.g. `VH-EP10` "EARTH PLAIN 10"). PK `style_code`.
- **variant** = the atomic sellable unit = **style × size** (e.g. `VH-EP10-L`). PK `variant_sku`. **This is what the QR encodes.** Holds `price`, `needs_price`, `qty_on_hand`.
- **sale** + **sale_items** = one bill and its lines. **stock_movements** = audit ledger.
- Numbers: **103 styles · 318 variants · 677 physical pieces.** One QR sticker per physical piece (677 total), but only 318 *distinct* SKUs — pieces of the same style+size share an identical QR.

## Hard rules
- **Never oversell.** `variants.qty_on_hand` has `CHECK (qty_on_hand >= 0)`. Always check out through the `process_sale(items jsonb, ...)` SQL function so the decrement + bill + ledger are one atomic transaction. If stock would go negative the whole sale rolls back — surface that to the user cleanly.
- **Price is editable per sale.** Listed `price` pre-fills the line as a default (handles bargaining). Persist the actual `unit_price` charged.
- **Cash bill, no GST.** Subtotal − discount = total.
- `needs_price = TRUE` variants (4 styles: `VH-KN100`, `VH-PLV5197A`, `VH-X5C28A`, `VH-Y5A183B`) must prompt for a confirmed price before they can be billed.
- Deferred but schema-ready (don't block on them): customer name/phone, delivery method.

## Connectivity reality
Booth runs on a **dedicated 4G hotspot**, not venue wifi. Assume flaky signal: keep payloads small, show clear pending/error states, and don't lose a cart on a failed request (let staff retry).

## Layout
```
app/            App Router screens: / (menu), /sell, /stock, /sales, /admin
  api/          (build these) route handlers — variant lookup, checkout, etc.
lib/db.ts       Neon sql client
db/schema.sql   run first
db/seed.sql     run second (generated from data/ — 103/318/677)
db/gen-seed.ps1 regenerates seed.sql from the master CSVs
data/           master_styles.csv, master_variants.csv (source of truth)
scripts/run-sql.mjs   `npm run db:schema` / `npm run db:seed`
```

## Setup
1. `npm install`
2. Copy `.env.example` → `.env.local`, paste the Neon **pooled** `DATABASE_URL`.
3. `npm run db:schema && npm run db:seed`
4. `npm run dev` → http://localhost:3000

## Conventions
- Server Components + Route Handlers for data; Client Components only where the camera/interactivity needs them (`"use client"`).
- Currency from `NEXT_PUBLIC_CURRENCY` (₹). Money as `NUMERIC` in DB; format in UI.
- Keep it shippable over clever — this must be rock-solid for a live 6-day event.
