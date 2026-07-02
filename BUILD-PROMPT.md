# Vhagar POS — Build Prompt

> Open this folder in VS Code, start Claude Code, and paste the block below as your first
> message. Everything it references already exists in the repo. Read `CLAUDE.md` first.

---

You are building **Vhagar POS**, a scan-to-bill POS with live inventory for the Vhagar Clothing
booth at **Bharat Tex 2026 (go-live 2 July 2026)**. The project is scaffolded and the database
layer is done. Read `CLAUDE.md` and `db/schema.sql` before writing any code — they define the
domain model and the hard rules. **Do not change the schema or the locked stack** (Next.js 14 App
Router + TypeScript, Neon Postgres via `lib/db.ts`, Tailwind, deploy on Vercel).

## Step 0 — get it running
1. `npm install`.
2. Confirm `.env.local` exists with a Neon `DATABASE_URL` (I'll provide it). If not, tell me.
3. `npm run db:schema` then `npm run db:seed`. Verify with a quick query that there are
   103 products, 318 variants, and `SUM(qty_on_hand) = 677`. Report the numbers back to me.
4. `npm run dev` and confirm the home menu renders.

## What to build (in this order — each must work before moving on)

### 1. Scan & Sell  (`/sell`) — the most important screen
- Live **QR camera scanner** (`html5-qrcode`), big viewfinder, works on a phone held in one hand.
- A scanned QR contains a `variant_sku` (e.g. `VH-EP10-L`). Look it up via a route handler
  (`GET /api/variants/[sku]`) returning name, color, size, listed price, `needs_price`, `qty_on_hand`.
- Add it to a **cart**. Scanning the same SKU again increments that line's qty.
- Each line shows the listed price as an **editable** field (default; staff adjust for bargaining).
- If `needs_price` is true OR stock is 0, flag the line clearly and require action before checkout.
- A manual **search-by-SKU/name** fallback for when a tag won't scan.
- **Checkout** → `POST /api/sales` → calls the `process_sale(...)` SQL function (atomic: bill +
  line items + stock decrement + ledger in one tx). On success show the bill; on a stock conflict
  (oversell) show a clean error and keep the cart intact so staff can fix it.

### 2. Bill view  (`/sale/[id]` or a modal)
- Clean printable/shareable **cash bill**: shop header "Vhagar Clothing", bill no, date, line items
  (name, size, qty, unit price, line total), subtotal, discount, **total**, "Cash". No GST.
- A "Print / Share" action (browser print is fine; bonus: a shareable summary text).

### 3. Live Stock  (`/stock`)
- List from the `v_stock` view, grouped by style, size chips with `qty_on_hand`.
- Search box; **low-stock (≤1) highlighted**; out-of-stock greyed.
- Auto-refresh every few seconds (polling) so multiple devices stay roughly in sync.

### 4. Sales Log  (`/sales`)
- Today's bills, newest first, with a running **grand total** for the day.
- Tap a row → its bill. An **"Export CSV"** button (sales + items) — this is our backup habit.

### 5. Admin & QR Labels  (`/admin`)
- Gate behind the `ADMIN_PIN` (simple shared PIN from env; this is booth-grade, not real auth).
- **Set prices**: list the `needs_price = true` variants and let me save a confirmed price.
- **QR label sheet generator**: a print-optimized page that renders one QR sticker **per physical
  piece** (so a variant with qty 3 prints 3 identical stickers; 677 total). Each sticker shows the
  QR (encoding `variant_sku`) plus human-readable text: **style name · size · colour · price · the
  SKU itself** (so a sale still works if the camera won't scan). Use the `qrcode` package.
  - Make the **label size configurable** at the top of the page (mm width × height + columns/rows),
    because it prints on a **Kores Endura label printer** — support both a continuous **roll** layout
    (one label per row, repeated) and an **A4 sticker-sheet** grid. Default to a garment-tag size
    (~38×25mm) but let me change it.
  - Direct-thermal printing is monochrome, so render colour as the **colour name in text**, not a
    swatch. Keep the QR high-contrast with a generous quiet zone so it scans reliably off fabric tags.
  - Add filters (by style / category / specific SKU) so we can reprint a subset, and a print CSS
    block so the browser print dialog maps cleanly to the label media.

## API design (route handlers under `app/api/`)
- `GET  /api/variants/[sku]` — lookup for the scanner.
- `GET  /api/variants?q=` — search fallback.
- `POST /api/sales` — body `{ items:[{sku,qty,price}], discount?, customer?, soldBy? }` → call
  `process_sale`, return the new sale id + bill. Handle the oversell exception explicitly.
- `GET  /api/sales?date=today` and `GET /api/sales/[id]`.
- `GET  /api/stock` — for the stock screen + checkout re-check.
- `POST /api/admin/price` — update a variant's price (PIN-checked).
Keep all DB access server-side (route handlers / server components). Never expose `DATABASE_URL` to the client.

## Non-negotiables (from CLAUDE.md)
- **Never oversell** — always go through `process_sale`; surface rollbacks as a friendly message.
- **Editable price per line**, persisted as `unit_price`.
- **Cash only, no GST.** Subtotal − discount = total.
- Assume a **flaky 4G** connection: small payloads, clear pending/error states, never lose a cart on a failed request.
- Mobile-first, large tap targets, fast. Shippable and rock-solid over clever.

## How to work
- Build screen 1 end-to-end and let me test it on my phone before starting screen 2.
- After each screen, give me a one-line "how to test" and any new env/config I need.
- When all five work locally, walk me through deploying to Vercel (GitHub import + `DATABASE_URL` env var) and a booth dress-rehearsal checklist.

Start with Step 0 and report the seed counts.
