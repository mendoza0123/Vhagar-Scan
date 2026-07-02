# Vhagar POS ↔ Vhagar IMS (Google Apps Script) — Integration Study

Status: **STUDY / ANALYSIS ONLY** (no integration built yet). Written for the decision on whether
the booth POS should read live stock from, and write sales back to, the existing GAS inventory app.

## 1. What the GAS app is (from `Vhagar Ims/script.js` + `index (1).html`)
- A **bound Apps Script web app** over a Google Sheet. Deployed at the `/exec` URL.
- **Backend = a spreadsheet.** `Sheet1` holds stock: `B=style_no`, `C=product_name`,
  `E..J = S/M/L/XL/2XL/3XL`, `L = in_hand` (sum of sizes), `A = =IMAGE()` formula (product photo).
  Other tabs: `Orders`, `Movements`, `Requisitions`, `Config`.
- **Server functions** (called only from its own page via `google.script.run`): `getProducts`,
  `getDashboard`, `submitOrder`, `cancelOrder`, `returnOrder`, `updateStock`, `addNewProduct`,
  `getProductImagesBatch`, plus the full requisition/production suite.
- **Concurrency:** every writer takes `LockService.getScriptLock()` (waits up to 30 s). Sheet reads/
  writes are the bottleneck (~0.5–3 s per call, slower under load).
- **Images:** stored in a Drive folder, shared `ANYONE_WITH_LINK`, addressable as
  `https://lh3.googleusercontent.com/d/<image_id>`. `getProducts()` already returns `image_id` per style.

## 2. The blocker: there is no machine API today
`doGet()` returns the **HTML UI only**. There is **no `doPost`, and no JSON/`action` routing**.
`google.script.run` is in-page glue — it is **not callable from the Next.js app**. So today the POS
cannot read or write the GAS data programmatically. Enabling integration **requires adding a small
JSON API to the GAS app** (a `doGet`/`doPost` that branches on an `action` param and returns
`ContentService` JSON), then re-deploying it as **"Anyone"** with a shared secret.

## 3. Data model mapping (good news: clean)
| POS (Neon) | GAS (Sheet) | Notes |
|---|---|---|
| `variant_sku` = `VH-EP10-XL` | `style_no` `VH-EP10` + `size` `XL` | POS SKU = `style_no + '-' + size` |
| `qty_on_hand` (per variant) | size cell `E..J` (per size) | direct |
| `products.name` | `product_name` (col C) | direct |
| `products.color`/`category` | not in GAS sheet | POS-only |
| — | `image_id` (from col A `=IMAGE()`) | **needed for photos (task #3)** |
| `process_sale()` decrement | `updateStock`/`submitOrder` decrement | both are atomic within their own store |

**⚠ Must verify:** that the `style_no` values in GAS `Sheet1` are byte-for-byte the POS
`style_code`s (e.g. both `VH-EP10`). If the IMS uses different codes, we need a mapping table.

## 4. The real design question
The GAS sheet is the **company-wide live stock across Flipkart / Shopify / retail**. The POS Neon DB
currently holds the **booth allocation (677 pieces)**. "Minus stock directly from the app" means a
booth sale should reduce the **shared** pool so online channels don't oversell the same garment.
That makes the two systems one inventory — which is powerful but raises **source-of-truth** and
**latency/reliability** concerns at a live booth on flaky 4G.

## 5. Three architectures

### Option A — GAS is the master; POS is a thin terminal
POS reads stock from GAS on load and calls GAS to decrement on every checkout.
- ✅ One source of truth; online + booth never oversell each other.
- ❌ **Every checkout waits on Sheets + the 30 s script lock over 4G** → slow, fragile, can stall the
  queue at the booth. ❌ No offline tolerance. ❌ Loses the atomic `process_sale` guarantee we built.
- Verdict: **too risky for a live 6-day booth.**

### Option B — Neon is the booth master; async push to GAS (recommended)
Seed Neon from GAS at the start; booth checkout stays on the fast atomic `process_sale`; after each
sale the POS **pushes the decrement to GAS asynchronously** (retry/queue, never blocks the bill).
- ✅ Rock-solid, fast, offline-tolerant checkout (unchanged). ✅ GAS master stays roughly live with
  booth sales. ✅ Keeps the never-oversell guarantee locally.
- ⚠ Eventual consistency: if online channels also sell the *same* physical pieces during the event,
  the two can drift. Mitigated if booth stock is a **reserved allocation** not sold online during the event.
- Verdict: **best balance for go-live.**

### Option C — One-time / scheduled sync (simplest)
Import GAS → Neon before the event; run the booth entirely on Neon; **reconcile once at end of day**
(push net booth sales back to GAS). Optionally re-pull each morning.
- ✅ Simplest, zero booth-time dependency on GAS. ❌ Not live during the day.
- Verdict: **the safe fallback / Phase-1**; upgrade to B later.

## 6. Recommendation (given go-live ~2 July, flaky 4G, never-oversell)
1. **Phase 1 (now → go-live):** keep the POS exactly as built on Neon. Do a **one-time seed** of booth
   stock (already done: 677). Do **not** make checkout depend on GAS. (Option C.)
2. **Phase 2 (enabler):** add the **JSON API to the GAS app** (section 7). This unlocks both the
   stock-sync *and* the Live-Stock photos (task #3) with zero risk to checkout.
3. **Phase 3:** turn on **async push** of booth sales to GAS (Option B), with a daily reconcile.

## 7. The GAS change that unlocks everything (to add + redeploy on their account)
Add a read endpoint (and later a write endpoint) guarded by a shared token:
```js
// === JSON API (add to script.js, then redeploy: Manage deployments → new version) ===
const API_TOKEN = 'set-a-long-random-string';            // POS sends this

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (!action) {                                          // unchanged: serve the UI
    return HtmlService.createTemplateFromFile('Index').evaluate()
      .setTitle('Vhagar Inventory').addMetaTag('viewport','width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  if (e.parameter.token !== API_TOKEN) return _json({ error: 'unauthorized' });
  if (action === 'stock') {
    // style_no, size-wise qty, in_hand, and image_id (for POS photos)
    return _json({ products: getProducts() });
  }
  return _json({ error: 'unknown_action' });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```
Later, a `doPost` `action=applySale` that reuses the existing `updateStock`/movement logic to
decrement the shared sheet for booth sales (Phase 3).

POS side then calls `GET <gas-exec-url>?action=stock&token=…` from a **server route** (never expose
the token to the browser) to (a) seed/refresh stock and (b) get `image_id`s for photos.

## 8. Task #3 — Live-Stock product photos
Photos live only in the GAS Drive folder, keyed by `style_no` → `image_id`
(`https://lh3.googleusercontent.com/d/<id>`). Two ways to get them into POS `/stock`:
- **Via the §7 endpoint (proper):** a POS server route fetches `?action=stock`, builds a
  `style_code → image_id` map, and `/stock` renders thumbnails. Always current. *Needs the GAS change.*
- **One-time export (quick, no GAS deploy):** run a tiny GAS function once to dump
  `style_no,image_id` as CSV/JSON; commit it to the POS repo (e.g. `data/style-images.json`); `/stock`
  reads it. Photos rarely change, so this is fine for the event and needs no live dependency.

Either way the `/stock` card gets a thumbnail (with a graceful letter-placeholder when missing) where
the magenta box is in your mockup.

## 9. Risks & open questions
- **Style-code parity** between IMS and POS (section 3) — must confirm before any sync.
- **Shared vs reserved booth stock** — is the 677 sold online too during the event? Drives Option A/B/C.
- **GAS quotas/latency** under booth load; the 30 s script lock serializes writes.
- **Auth**: the JSON endpoint must use a token + "Anyone" deployment (GAS can't do real auth headers).
- **Two writers** (booth + online) to one sheet → reconcile policy needed for Phase 3.
