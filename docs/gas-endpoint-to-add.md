# Vhagar IMS — exact code to add for POS live-sync (stock + photos)

Paste this into the IMS Apps Script project, then redeploy. It exposes a JSON API the POS reads
server-side. It does **not** change any existing behaviour (the HTML UI is served exactly as before
when there's no `?action`).

> Reviewed/corrected by an adversarial pass — key fixes baked in: returns **raw `image_id`** (the POS
> adds the thumbnail size, avoiding a double `=s400` bug); **server-side cached** (no repeated
> full-sheet reads); **token from Script Properties** (not in source); deploy as **"Anyone"** (not
> "Anyone with Google account", which silently breaks the POS with an HTML login page).

## Step 1 — set the token once (Apps Script editor → Run this once)
```javascript
function setPosApiToken() {
  PropertiesService.getScriptProperties()
    .setProperty('POS_API_TOKEN', 'PUT-A-LONG-RANDOM-STRING-HERE'); // e.g. 40+ random chars
}
```
Run `setPosApiToken` once (authorize if prompted), then delete the literal or leave it — the value
now lives in Script Properties. Use the **same** string as `GAS_API_TOKEN` in the POS env.

## Step 2 — replace the existing `doGet()` (the current ~6-line one) with this block
```javascript
// ============================================================
// POS JSON API  (read-only: live stock + product photos)
// ============================================================
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';

  // JSON API branch
  if (action) {
    var token = (e && e.parameter && e.parameter.token) || '';
    var expected = PropertiesService.getScriptProperties().getProperty('POS_API_TOKEN') || '';
    if (!expected || token !== expected) return _json({ ok: false, error: 'unauthorized' });
    if (action === 'stock') return _stockApi();
    return _json({ ok: false, error: 'unknown action: ' + action });
  }

  // HTML UI branch — unchanged from before
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Vhagar Inventory')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Live stock + photo ids. Cached 45s so booth polling doesn't re-read the whole
// sheet every call. Returns RAW image_id — the POS builds the lh3 thumbnail URL.
function _stockApi() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('pos_stock');
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

  var products = getProducts().map(function (p) {
    return {
      style_no: p.style_no,         // raw (may have trailing "_"); POS normalizes
      product_name: p.product_name, // raw (may contain newlines); POS uses its own catalog name
      sizes: p.sizes,               // { S, M, L, XL, '2XL', '3XL' }
      in_hand: p.in_hand,           // column L (sheet's source of truth)
      image_id: p.image_id || null  // RAW id; POS appends =s400
    };
  });

  var payload = JSON.stringify({
    ok: true,
    generated_at: new Date().toISOString(),
    count: products.length,
    products: products
  });
  cache.put('pos_stock', payload, 45); // seconds
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Step 3 — deploy (keeps the same /exec URL)
1. **Save** (Ctrl+S).
2. **Deploy → Manage deployments → (pencil) Edit** the existing web-app deployment.
3. **Version: New version**, description "POS stock JSON API".
4. **Execute as: Me**, **Who has access: Anyone** ← must be plain "Anyone", *not* "Anyone with Google account".
5. **Deploy** (authorize if prompted). The `/exec` URL stays the same.

## Step 4 — verify (server-side; the browser can't, no CORS)
```bash
curl -L "https://script.google.com/macros/s/AKfycbx.../exec?action=stock&token=YOUR_TOKEN"
```
Expect `{"ok":true,...,"products":[{"style_no":"...","image_id":"...","in_hand":N,...}]}`.
If you get HTML instead → the access setting is still "Anyone with Google account" (fix step 3.4).

## Step 5 — send me two things
- the **`/exec` URL**
- the **token**

I'll set `GAS_STOCK_URL` + `GAS_API_TOKEN` in the POS (`.env.local` + Vercel), redeploy, and photos
appear on `/stock` for every style that has an image in the IMS (others keep a letter tile).

---
### Phase 2 (later, post-event): write-back so booth sales decrement the IMS
A `doPost(e)` with `action=applySale` (separate **write** token) that reuses `updateStock()` with
negative quantities, idempotent on the POS bill id, fail-fast across styles, and called
fire-and-forget from the POS *after* the Neon sale commits (so the booth never blocks on Google).
Design is in `docs/gas-integration-study.md`. Do not enable for go-live.
