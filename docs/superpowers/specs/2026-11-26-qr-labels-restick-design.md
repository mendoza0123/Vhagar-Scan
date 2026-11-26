# QR Labels — re-stick product by product (IMS + POS)

Date: 26 Nov 2026 · Status: draft for approval

## Why

After THE WALK the stock in IMS no longer matches what is on the shelves.
Management decided to re-stick every piece. Coordinators do it one product at
a time, not as one big stock-take:

1. pick up a product (e.g. LIO LINEN 20 in M, L, XL, 2XL),
2. see that product's sizes in a POS-like screen,
3. tick the sizes in hand, type how many pieces they counted,
4. save — IMS stock becomes the count — and print one new sticker per piece.

From now on **every piece has its own unique code**, shirts as well as tees
(until now only tees did; shirts shared one QR per size).

The user asked for the whole flow to be available **in both apps**: the IMS
(ims.vhagar.co) and the POS (scan.vhagar.co).

## Goals

- A **QR Labels** screen in the IMS and a matching one in the POS (under
  Admin, behind the booth PIN). Both do the full flow: pick product → tick
  sizes → type counts → optional rack → optional remark → Save → Print.
- **Save** does, atomically, for each ticked size:
  - sets `variants.qty_on_hand` to the counted number, writing a
    `stock_movements` row (reason `restick`, by the coordinator);
  - retires (status `void`) every old `in_stock` code of that size;
  - makes exactly *counted* fresh unique codes (`mint_units`);
  - records the batch: who, when, which app, rack, remark, and per size the
    IMS number seen vs the counted number.
- **Print** prints exactly that batch's codes on the existing label setup
  (Endura roll / A4 sheet, QR-on-top / QR-on-left / retail tag). A batch can
  be reprinted.
- **Optional location:** "In store — Rack 1 / 2 / 3 / 4 / 5", one per batch.
- **Optional remark:** free text, one per batch.
- **Progress:** how many products have been re-stuck, and a list of recent
  batches (product, pieces, by, rack, remark, printed or not).
- **Every piece unique from now on:** any stock-in through the IMS (register
  opening stock, Update Stock) makes codes for every product, not only tees.

## Non-goals

- Scanning every piece / a full inventory screen.
- Tracking pieces as they move between racks after re-stick. The rack is
  where the batch was put when it was stuck, nothing more.
- Printing the rack on the sticker (it would go stale when the piece moves).
- Any change to prices, offers, bill maths or carton labels.

## Anti-goals (would make this a failure even if it works)

- A miscount silently wiping stock — differences must be shown and confirmed.
- Two coordinators re-sticking the same size at once and making double codes.
- A flaky-4G retry saving the batch twice.
- The booth being unable to sell a piece because its sticker is old.

## Constraints

- One shared Neon Postgres. Both apps are Next.js 14 App Router + Tailwind,
  separate repos (`e:\vhagar-ims`, `e:\vhagar-pos`), no shared package.
- IMS has Google login (`currentUser()`); every IMS route checks it.
- POS has **no login**. Its admin write routes check the shared booth PIN
  server-side (`ADMIN_PIN`, see `app/api/admin/price/route.ts`). The POS
  re-stick save route must do the same — it sets stock.
- POS goes live on `git push origin main`. The IMS deploy and the database
  migration are run by the user.
- Booth runs on a 4G hotspot: one small request per save, clear pending and
  error states, never lose what the coordinator typed.
- `qty_on_hand >= 0` CHECK stays the oversell guard.
- QR printing lives only in the POS (`app/admin/labels/page.tsx`: `qrcode`
  at 203 dpi, `jsbarcode` for retail tags, `buildPrintCss`, `LabelContent`).
  The IMS has no print code today.

## Approaches considered

- **A — Count in IMS, print from POS.** Stock writes behind IMS login, one
  label renderer. Two screens for the coordinator.
- **B — Everything in IMS.** Copy the label renderer into IMS. One screen,
  but two label layouts and two printer calibrations to keep in step.
- **C — Everything in POS.** Ships by git push; reuses printer. Stock reset
  from an app with no login.
- **Chosen: both apps** (user's decision). One database function does the
  save for both apps; each app has its own count screen; printing has one
  renderer (see below).

## Design

### Database (one migration, `e:\vhagar-ims\db\ims-restick-v21.sql`)

```sql
CREATE TABLE ims_restick (
  id         uuid PRIMARY KEY,                 -- made on the phone: a retry can't double-save
  style_code text NOT NULL REFERENCES products(style_code),
  rack       smallint CHECK (rack BETWEEN 1 AND 5),   -- "In store — Rack N", optional
  remark     text,
  source     text NOT NULL CHECK (source IN ('ims','pos')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  printed_at timestamptz                       -- last time its labels were printed
);
CREATE TABLE ims_restick_lines (
  restick_id  uuid NOT NULL REFERENCES ims_restick(id) ON DELETE CASCADE,
  variant_sku text NOT NULL REFERENCES variants(variant_sku),
  ims_qty     int  NOT NULL,                   -- IMS stock when saved
  counted     int  NOT NULL CHECK (counted >= 0),
  retired     int  NOT NULL,                   -- old in-stock codes voided
  PRIMARY KEY (restick_id, variant_sku)
);
ALTER TABLE ims_units ADD COLUMN IF NOT EXISTS restick_id uuid REFERENCES ims_restick(id);
```

`ims_units.status` already allows `void`. `stock_movements.reason` is free
text, so `restick` needs no change.

`restick(p_id uuid, p_style text, p_lines jsonb, p_rack int, p_remark text,
p_by text, p_source text) RETURNS jsonb`, with
`p_lines = [{sku, counted, seen}]` (`seen` = the IMS number the screen showed):

1. If `ims_restick` already has `p_id`, return that batch's codes unchanged
   (safe retry).
2. Lock the batch's `variants` rows `FOR UPDATE`, in sku order.
3. If any line's current `qty_on_hand` ≠ `seen`, raise `stock_moved` naming
   the size, what was seen and what it is now (a sale or another coordinator
   changed it). Nothing is written. The screen reloads those sizes and asks
   the coordinator to check the count again.
4. Insert the batch row. For each line: set stock + ledger row (reason
   `restick`, note = remark); void the size's `in_stock` units; `mint_units`
   for `counted`; stamp the new units with `restick_id`; insert the line.
5. Return `{id, lines:[{sku, ims_qty, counted, retired}], codes:[{sku, code}]}`.

Codes keep the current pattern `<variant_sku>-NNNN`; `mint_units` numbers on
from the highest code ever made for that size, so a new code never repeats an
old one.

### Every piece unique from now on

- IMS: remove the `isTshirt` gate before `mint_units` in
  `app/api/stock/update/route.ts`, `app/api/products/register/route.ts`,
  `app/api/products/[style]/route.ts`.
- POS labels page: fetch units for every variant in view, not only tees.
  A size with in-stock codes prints its codes; a size with none (not yet
  re-stuck) keeps printing copies of the shared size QR as today.
- POS sell screen: scanning a unique code already in the cart is refused with
  "Already scanned" instead of adding another piece.

### Old stickers keep selling, with a warning

Scanning resolves through `variant_of()`, which already maps any unit code
(including a voided one) and any shared size QR to its variant — selling is
never blocked. `GET /api/variants/[sku]` (POS) also returns
`old_sticker: true` when the code is a voided unit, or is a shared size QR for
a size that now has in-stock unique codes. The sell screen then shows a
yellow note: "Old sticker — this size has been re-stuck." The sale goes
through unchanged.

Sizes where in-stock codes ≠ stock (a piece sold on an old sticker, a manual
stock edit) are flagged on the QR Labels screen as "needs re-stick".

### Screens

Same layout in both apps (POS: bigger touch targets, phone-first).

```
QR Labels                               84 of 323 products re-stuck
[ Search product name or code…                       ]
LIO LINEN 20 · VH-LL20_                     last re-stuck: never
   size   IMS   counted
 ☐ S       1    [   ]
 ☑ M       3    [ 4 ]   +1
 ☑ L       5    [ 5 ]
 ☑ XL      2    [ 1 ]   −1
 ☐ 2XL     2    [   ]   ⚠ needs re-stick
Rack (optional)   [ — ] [1] [2] [3] [4] [5]
Remark (optional) [                              ]
[ Save 10 pieces & make labels ]
```

- Search → design → sizes reuses the POS Move-pieces picker queries
  (`/api/variants?by=style&q=`, `?style=`); IMS gets the same two queries.
- The counted box starts **empty**; typing a number ticks the size. Only
  ticked sizes are saved; unticked sizes are not touched.
- If any ticked size differs from IMS, Save first shows the differences
  ("M 3 → 4 (+1), XL 2 → 1 (−1). Set stock to your count?").
- The batch id (uuid) is made when the screen opens a product and kept until
  a save succeeds, so a retry after a timeout returns the same batch.
- After save: "Saved — 10 new codes" with **Print labels** and **Next product**.
- Below: recent batches from both apps (time, product, pieces, by, rack,
  remark, printed ✓) with a **Print** button each.

### Printing (one renderer)

- POS `/admin/labels?batch=<id>` loads the batch's codes and prints them with
  the existing renderer and the device's saved media/layout settings. All
  codes ticked; untick one to reprint only a damaged sticker. Pressing Print
  sets `printed_at`.
- The POS QR Labels screen links there directly.
- The IMS **Print labels** button opens
  `https://scan.vhagar.co/admin/labels?batch=<id>` in a new tab — the same
  sheet, the same printer settings, no second copy of the label layout to
  keep in step. (If a separate IMS print sheet is wanted later, it is the
  renderer copied over; nothing else changes.)

### Routes

| App | Route | Does |
|---|---|---|
| IMS | `GET /api/restick?style=` | sizes: IMS qty, in-stock code count, last batch |
| IMS | `GET /api/restick` | recent batches + progress count |
| IMS | `POST /api/restick` | calls `restick(...)`, source `ims`, by = user email |
| POS | same three, under `/api/restick` | POST needs `pin` = `ADMIN_PIN`; by = coordinator name picked on screen |
| POS | `GET /api/restick/[id]` | the batch's codes + label rows for printing |
| POS | `POST /api/restick/[id]/printed` | sets `printed_at` |

Before the migration is applied, the routes answer "QR re-stick isn't switched
on yet" instead of failing, so the POS can go live first.

### Checks

`scripts/check-restick.mjs` (IMS), one transaction, always rolled back:
stock set + ledger row; old in-stock codes voided and sold codes untouched;
fresh codes = counted and numbered on from the highest; same id twice returns
the same codes with no second mint; a `seen` mismatch writes nothing;
counted 0 voids all and mints none.

### Rollout

1. Run the migration (user).
2. Deploy IMS (user).
3. Push POS (me) — re-stick screen, `?batch=` print mode, all-product units on
   the labels page, old-sticker note, double-scan guard.

## Calls made after the builder check

- **A count is the whole size**, not just the pieces in hand: IMS stock is one
  company-wide number. Each size row shows where the box index says its
  pieces are (Display, Booth rack, CTN-…), so cartons get counted too, and
  any difference needs a confirm.
- **The box index is trimmed, never left over-claiming.** If the count is
  below what the boxes list, `restick()` takes the excess off — booth Display
  and Rack first, then the fullest carton — and records it as `boxed_cut`.
  Store Rack 1–5 stays a label on the batch, separate from the booth boxes.
- **Stock that moves without a scan** (online orders, cancels, returns) does
  not retire or revive a code — nobody knows which sticker left. The size
  then shows "⚠ N codes for M pcs — re-stick again". Production inward
  (`receive_requisition`) mints codes like every other stock-in.

## Left to the builder

- Exact definition of "re-stuck" for the progress count (suggested: every
  size with stock > 0 is covered by a batch).
- How the POS screen asks for the coordinator's name (reuse the Sold-by list
  from IMS → Admin → POS staff is the obvious choice).
- Visual details within each app's existing style.
