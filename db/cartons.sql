-- Vhagar POS — carton locator. A best-effort "which box holds this size" index.
-- ponytail: this is a LOCATOR, not a stock ledger. It NEVER touches
-- variants.qty_on_hand and process_sale is untouched. It drifts after sales;
-- re-scan a box (set mode) or clear + re-pack to refresh. Idempotent file.

CREATE TABLE IF NOT EXISTS cartons (
  carton_id  TEXT PRIMARY KEY,          -- 'CTN-0001' == the printed carton QR (upper-cased)
  label      TEXT,
  location   TEXT,                       -- free text: "Rack A / under table 3"
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carton_items (
  carton_id   TEXT NOT NULL REFERENCES cartons(carton_id) ON DELETE CASCADE,
  variant_sku TEXT NOT NULL REFERENCES variants(variant_sku),
  qty         INTEGER NOT NULL CHECK (qty >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (carton_id, variant_sku)
);
CREATE INDEX IF NOT EXISTS idx_carton_items_sku ON carton_items(variant_sku);

CREATE OR REPLACE VIEW v_carton_contents AS
SELECT ci.carton_id, c.label, c.location, ci.variant_sku, ci.qty,
       v.style_code, p.name, v.size
FROM carton_items ci
JOIN cartons  c ON c.carton_id   = ci.carton_id
JOIN variants v ON v.variant_sku = ci.variant_sku
JOIN products p ON p.style_code  = v.style_code;

-- Pack / remove / set a carton's contents. Auto-creates the carton header.
--   items : [{"sku":"VH-EP04-XL","qty":3}, ...]
--   mode  : 'add' (delta; negative removes) | 'set' (absolute)
-- CHECK(qty>=0) aborts an over-remove (SQLSTATE 23514 -> route maps 409).
-- A line that reaches 0 is deleted so lookups stay clean.
CREATE OR REPLACE FUNCTION carton_add(
  p_carton   text,
  p_items    jsonb,
  p_mode     text DEFAULT 'add',
  p_label    text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_note     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_carton  text := upper(btrim(p_carton));
  it        record;
  v_sku     text;
  v_new     int;
  v_changed int := 0;
BEGIN
  IF v_carton IS NULL OR v_carton = '' THEN RAISE EXCEPTION 'Carton id is required.'; END IF;
  IF p_mode NOT IN ('add','set') THEN RAISE EXCEPTION 'Invalid mode "%".', p_mode; END IF;

  INSERT INTO cartons (carton_id, label, location, note)
  VALUES (v_carton, NULLIF(btrim(p_label),''), NULLIF(btrim(p_location),''), NULLIF(btrim(p_note),''))
  ON CONFLICT (carton_id) DO UPDATE
     SET label    = COALESCE(NULLIF(btrim(EXCLUDED.label),''),    cartons.label),
         location = COALESCE(NULLIF(btrim(EXCLUDED.location),''), cartons.location),
         note     = COALESCE(NULLIF(btrim(EXCLUDED.note),''),     cartons.note),
         updated_at = now();

  FOR it IN SELECT * FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS x(sku text, qty int) LOOP
    v_sku := upper(btrim(it.sku));
    CONTINUE WHEN v_sku IS NULL OR v_sku = '' OR it.qty IS NULL OR (p_mode = 'add' AND it.qty = 0);

    PERFORM 1 FROM variants WHERE variant_sku = v_sku;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown item %', v_sku; END IF;

    IF p_mode = 'set' THEN
      IF it.qty < 0 THEN RAISE EXCEPTION 'Cannot set % below zero.', v_sku; END IF;
      INSERT INTO carton_items (carton_id, variant_sku, qty) VALUES (v_carton, v_sku, it.qty)
      ON CONFLICT (carton_id, variant_sku) DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()
      RETURNING qty INTO v_new;
    ELSE
      -- add: UPDATE the delta (CHECK aborts an underflow -> 23514); insert only a
      -- new line, and only when adding (can't remove from a line that isn't there).
      -- ON CONFLICT can't be used with a negative delta — the tentative insert row
      -- would trip CHECK(qty>=0) before the conflict resolves to an UPDATE.
      UPDATE carton_items SET qty = qty + it.qty, updated_at = now()
        WHERE carton_id = v_carton AND variant_sku = v_sku
      RETURNING qty INTO v_new;
      IF NOT FOUND THEN
        IF it.qty < 0 THEN RAISE EXCEPTION 'Cannot remove % — not in carton %.', v_sku, v_carton; END IF;
        INSERT INTO carton_items (carton_id, variant_sku, qty) VALUES (v_carton, v_sku, it.qty)
        RETURNING qty INTO v_new;
      END IF;
    END IF;

    IF v_new = 0 THEN DELETE FROM carton_items WHERE carton_id = v_carton AND variant_sku = v_sku; END IF;
    v_changed := v_changed + 1;
  END LOOP;

  RETURN jsonb_build_object('carton_id', v_carton, 'changed', v_changed);
END $$;
