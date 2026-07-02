-- ============================================================
-- Vhagar POS — Neon Postgres schema
-- Run this FIRST, then db/seed.sql
-- Natural keys (style_code, variant_sku) so a scanned QR maps
-- straight to a primary-key lookup.
-- ============================================================

-- ---------- catalog ----------
CREATE TABLE IF NOT EXISTS products (
  style_code   TEXT PRIMARY KEY,           -- e.g. VH-EP10
  name         TEXT NOT NULL,              -- EARTH PLAIN 10
  color        TEXT,
  category     TEXT,                        -- Plain / Checks / Stripe ...
  fabric       TEXT,
  description  TEXT,                        -- long marketing description
  base_price   NUMERIC(10,2),              -- reference price (editable at variant level)
  channels     TEXT,                        -- SHOPIFY / FLIPKART ...
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- variants (the atomic sellable unit = style × size) ----------
CREATE TABLE IF NOT EXISTS variants (
  variant_sku  TEXT PRIMARY KEY,           -- e.g. VH-EP10-L  (this is what the QR encodes)
  style_code   TEXT NOT NULL REFERENCES products(style_code) ON DELETE CASCADE,
  size         TEXT NOT NULL,              -- S/M/L/XL/2XL/3XL
  price        NUMERIC(10,2) NOT NULL,     -- listed price; pre-fills the bill as an editable default
  needs_price  BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE = confirm before selling
  qty_on_hand  INTEGER NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),  -- guard: can never oversell
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_variants_style ON variants(style_code);

-- ---------- sales (one bill) ----------
CREATE TABLE IF NOT EXISTS sales (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_no         TEXT UNIQUE,             -- human-friendly, e.g. VH-2026-0001 (set by app)
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'cash',
  customer_name   TEXT,                     -- optional (deferred, schema-ready)
  customer_phone  TEXT,                     -- optional
  delivery_method TEXT,                     -- optional (carry / ship)
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'completed',  -- completed / void
  sold_by         TEXT,                     -- which staff/device
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

-- ---------- sale line items ----------
CREATE TABLE IF NOT EXISTS sale_items (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id      BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  variant_sku  TEXT NOT NULL REFERENCES variants(variant_sku),
  name         TEXT NOT NULL,              -- snapshot at sale time
  size         TEXT NOT NULL,
  unit_price   NUMERIC(10,2) NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  line_total   NUMERIC(10,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- ---------- stock ledger (audit trail for every movement) ----------
CREATE TABLE IF NOT EXISTS stock_movements (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_sku  TEXT NOT NULL REFERENCES variants(variant_sku),
  delta        INTEGER NOT NULL,           -- +opening/+restock/+return, -sale
  reason       TEXT NOT NULL,              -- opening / sale / return / adjustment / restock
  sale_id      BIGINT REFERENCES sales(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movements_variant ON stock_movements(variant_sku);

-- ============================================================
-- Atomic checkout. Pass the cart as JSON; everything below
-- happens in ONE transaction. The qty_on_hand >= 0 CHECK makes
-- overselling impossible — the whole sale rolls back instead.
--
-- items := '[{"sku":"VH-EP10-L","qty":1,"price":1299}, ...]'
-- Returns the new sale id.
-- ============================================================
CREATE OR REPLACE FUNCTION process_sale(
  items           JSONB,
  p_bill_no       TEXT    DEFAULT NULL,
  p_discount      NUMERIC DEFAULT 0,
  p_customer_name TEXT    DEFAULT NULL,
  p_customer_phone TEXT   DEFAULT NULL,
  p_payment_method TEXT   DEFAULT 'cash',
  p_sold_by       TEXT    DEFAULT NULL,
  p_note          TEXT    DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
  v_sale_id   BIGINT;
  v_subtotal  NUMERIC(10,2) := 0;
  it          JSONB;
  v_sku       TEXT;
  v_qty       INTEGER;
  v_price     NUMERIC(10,2);
  v_name      TEXT;
  v_size      TEXT;
BEGIN
  INSERT INTO sales (bill_no, payment_method, customer_name, customer_phone, sold_by, note, discount)
  VALUES (p_bill_no, p_payment_method, p_customer_name, p_customer_phone, p_sold_by, p_note, COALESCE(p_discount,0))
  RETURNING id INTO v_sale_id;

  FOR it IN SELECT * FROM jsonb_array_elements(items) LOOP
    v_sku   := it->>'sku';
    v_qty   := COALESCE((it->>'qty')::INT, 1);
    v_price := (it->>'price')::NUMERIC;

    SELECT name_for_bill, size INTO v_name, v_size FROM (
      SELECT v.size, p.name AS name_for_bill FROM variants v
      JOIN products p ON p.style_code = v.style_code
      WHERE v.variant_sku = v_sku
    ) q;

    IF v_name IS NULL THEN
      RAISE EXCEPTION 'Unknown variant_sku: %', v_sku;
    END IF;

    -- decrement stock; CHECK(qty_on_hand >= 0) aborts the tx if it would go negative
    UPDATE variants SET qty_on_hand = qty_on_hand - v_qty WHERE variant_sku = v_sku;

    INSERT INTO sale_items (sale_id, variant_sku, name, size, unit_price, qty, line_total)
    VALUES (v_sale_id, v_sku, v_name, v_size, v_price, v_qty, v_price * v_qty);

    INSERT INTO stock_movements (variant_sku, delta, reason, sale_id)
    VALUES (v_sku, -v_qty, 'sale', v_sale_id);

    v_subtotal := v_subtotal + (v_price * v_qty);
  END LOOP;

  UPDATE sales
     SET subtotal = v_subtotal,
         total    = v_subtotal - COALESCE(p_discount,0)
   WHERE id = v_sale_id;

  RETURN v_sale_id;
END;
$$;

-- Convenience view: live stock with names
CREATE OR REPLACE VIEW v_stock AS
SELECT v.variant_sku, v.style_code, p.name, p.color, v.size,
       v.price, v.needs_price, v.qty_on_hand, p.category
FROM variants v
JOIN products p ON p.style_code = v.style_code
ORDER BY p.name, v.size;
