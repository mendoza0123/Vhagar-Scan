# Vhagar IMS → Neon rebuild plan (Phase 2)

Status: **PLAN / SCOPE — no build yet.** Goal: replace the Google-Apps-Script IMS with a
Next.js + Neon system that shares **one database** with the booth POS, so booth sales and online
orders draw down the **same** stock with no sync layer. Decided direction (user): *plan the Neon rebuild*.

> ⛔ **Not before the 2 July booth go-live.** The booth POS is finished and standalone on Neon
> (677 seeded). This rebuild starts **after** the event. Keep the POS frozen for go-live.

## 1. What's actually in the IMS (from `Vhagar IMS F1.1.xlsx`)
The sheets are padded with blank rows; the *real* data is small:
| Data | Real volume | Notes |
|---|---|---|
| Stock (`Sheet1`) | **115 styles** | cols: image, style_no, name, S–3XL, TTL CUTTING, **IN HAND**, fabric, channel(s) |
| Orders | **69 orders** | channels Flipkart/Shopify; statuses Delivered/Cancelled/Returned; **dates are Excel serials** (Jan–Jun 2026) |
| Movements | **178 rows** | types: SALE, CANCEL, RESTOCK, MANUAL_ADJUST, NEW_PRODUCT, PRODUCTION_RECEIVED, STATUS_CHANGE |
| Requisitions | ~0 | effectively unused in the sheet |
| TS_* (sourcing) | **sample only** (3 vendors, 0 POs, 7 demo stock) | a vendor/PO/requisition module; barely used |

**Key findings that shape the build:**
1. **Style-code mismatch:** IMS `style_no` carries a **trailing underscore** (`VH-EP10_`) and names have
   embedded newlines/extra spaces (`EARTH \nPLAIN 10`). POS uses `VH-EP10` / `EARTH PLAIN 10`.
   Migration must **normalize** (strip `_`, collapse whitespace) — this also makes the IMS↔POS catalogues line up.
2. **No product photos exist yet** — the image column is empty/`None` for all 115 styles. So "show photos"
   has *no source data today*; image hosting is a fresh feature, not a migration.
3. **Catalogue overlap:** IMS has 115 styles, POS booth has 103 — the IMS is the superset. Unify into one
   `products`/`variants` catalogue.
4. **Sourcing module is sample-only** → port it last (or skip until needed).

## 2. Target architecture
- **One Neon Postgres DB. One Next.js app** with two "faces": the **booth POS** (existing screens) and the
  **IMS admin** (new screens). Same Vercel deploy, same `lib/db`.
- **Single source of truth for stock:** `variants.qty_on_hand`. Every stock-changing event (booth bill,
  online order, restock, production receipt, adjustment) writes a `stock_movements` row and decrements/
  increments the same variant in one transaction. No GAS, no sync, no 30-second lock.
- Keep the POS's hard guarantees (`CHECK (qty_on_hand >= 0)`, atomic `process_sale`).

## 3. Schema additions (additive — existing POS tables untouched)
Reuse: `products`, `variants`, `stock_movements`, `v_stock`. Add:
- **`orders`** `(id, order_no, channel, buyer_name, buyer_contact, status, order_date, notes, created_by, created_at)`
  — channel ∈ {Booth, Flipkart, Shopify, Amazon, Meesho, Direct}. **The booth POS becomes `channel='Booth'`**,
  unifying `sales` and online orders under one model (or keep `sales` and add `orders` side-by-side in a
  first cut — see §8 decision).
- **`order_items`** `(id, order_id, variant_sku, name, size, qty, unit_price, line_total, status)`.
- **`vendors`**, **`purchase_orders`**, **`po_lines`** — the TS sourcing module (Phase 2b).
- **`requisitions`**, **`requisition_lines`** — production tracking (issue fabric → receive goods, with the
  loss-breakdown + partial-receipt logic that already exists in the GAS code; port the rules 1:1).
- **`products.image_url`** (or a small `product_images` table) — for photos.
- Extend `stock_movements.reason` to cover the IMS reasons above. Add SQL functions mirroring
  `process_sale` for online orders / cancellations / returns / production receipts (atomic).

## 4. Data migration (one-time ETL: xlsx → Neon)
A Node script (parse the xlsx as zipped XML — no external lib needed; pattern already prototyped):
- **Products/variants:** for each `Sheet1` style → normalize code (`rstrip('_')`, trim), clean name
  (collapse `\n`/spaces); upsert `products`; create 6 `variants` (S–3XL) with `qty_on_hand` from the size
  cells; set `price`/`needs_price` from POS rules where known. Merge with the existing 103 POS styles.
- **Orders + items:** convert Excel serial → date; group rows by `order_id`; normalize style codes; insert
  `orders`+`order_items`. (Optional — historical orders may not be worth importing; decide in §8.)
- **Movements:** import as historical ledger (optional).
- **Idempotent upserts** keyed on natural keys so the script is re-runnable.
- **Stock truth decision:** company-wide IN HAND (IMS) vs booth 677 — see §8.

## 5. Screens to build (port from the GAS UI)
The GAS `index.html` is the spec. Rebuild as Next.js routes:
- **Dashboard** — totals, today's orders, low-stock, channel breakdown.
- **Inventory** — product grid w/ photos, size-wise stock, search/sort (the POS `/stock` is most of this).
- **New Order / Orders** — multi-line order entry per channel; list, filters, status transitions,
  cancel/return (restores stock) — logic already specified in GAS `submitOrder`/`cancelOrder`/`returnOrder`.
- **Movements** — ledger view.
- **Update Stock / Register Product** — restock (+/-), overwrite, add new style.
- **Requisitions / Production** — issue fabric, partial + final receive with loss breakdown, insights,
  the VH-YYYY-NN id sequence, production-form PDF.
- **Sourcing (TS): Vendors / Purchase Orders / Requisitions** — Phase 2b (low data).
- **PDF exports** (orders, production form) — reuse the existing jsPDF code from `index.html` ~as-is.
- **Auth** — IMS needs real per-user login (Google sign-in or email+password), unlike the booth PIN.

## 6. Image hosting
No images exist yet, so this is greenfield. Options: **Vercel Blob** (cleanest with the stack),
Cloudinary, or S3. Add an upload control on the product screen; store `image_url` on the product.
(If any Drive photos do exist behind the `=IMAGE()` formulas, a small GAS dump can export them once.)

## 7. How POS + IMS coexist
- Same `variants.qty_on_hand`. A **booth bill** and an **online order** both go through an atomic SQL
  function that decrements stock + writes a movement. Overshoot is impossible (`CHECK >= 0`).
- Channel reporting falls out of `orders.channel` (Booth/Flipkart/Shopify/...).
- The booth keeps working offline-first; online order entry is staff-side on better connectivity.

## 8. Open decisions (need answers before building)
1. **Stock model:** is the booth 677 a *reserved allocation* or the *same pool* sold online? This sets
   whether migration uses company-wide IN HAND or keeps the booth subset.
2. **Unify `sales`→`orders` (channel=Booth)** vs keep `sales` + add `orders` separately. (Unify = cleaner;
   small POS refactor.)
3. **Import history?** Bring in the 69 orders / 178 movements, or start the ledger fresh on cutover.
4. **Auth** method for IMS staff (Google Workspace sign-in vs email/password + roles).
5. **Port the TS sourcing module now or later** (it's sample-only today).

## 9. Rough effort (post-event, existing stack)
| Workstream | Est. |
|---|---|
| Schema + atomic SQL fns + migration script | 2–3 d |
| Inventory + Update-stock + New-product | 3–4 d |
| Orders (entry, list, status, cancel/return) | 3–4 d |
| Movements + Dashboard | 2 d |
| Requisitions/Production (+ PDF) | 3–4 d |
| Images + Auth/roles | 2–3 d |
| Sourcing (Vendors/PO) — optional | 2–3 d |
| **Total** | **~3–4 weeks** |

## 10. Immediate next steps (when Phase 2 starts)
1. Answer §8 decisions.
2. I write the migration script + schema migration (additive), run against a **Neon branch** first.
3. Build screens in priority order (Inventory → Orders → Movements → Production), each behind IMS auth.
4. Cut over; retire the GAS app.
