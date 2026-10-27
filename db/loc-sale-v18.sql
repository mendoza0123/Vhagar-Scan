-- v18 — close the two holes in the booth location chain.
--
-- The chain itself already works: IMS "move to Display" (stage_move) puts the
-- piece in the Display box, and checkout's cartons_consume_src deducts from the
-- box staff picked in the sell screen's "From" row. A rolled-back live test
-- confirmed that end to end. Two things were missing:
--
--  1. VOID gave the stock back but never gave the piece back to its box. 28 of
--     148 bills are voided, so the Display/Rack/carton index was drifting short
--     on every one of them with no way to notice.
--  2. Selling a unique t-shirt unit never marked that unit sold: 2,332 minted
--     units, 59 tees already billed, 0 units ever moved off 'in_stock'. The
--     unique sticker resolved to the right garment and then got thrown away.
--
-- Both are locator concerns, not money: qty_on_hand stays the single source of
-- truth for stock and is untouched here.

ALTER TABLE sales     ADD COLUMN IF NOT EXISTS loc_taken jsonb;
ALTER TABLE ims_units ADD COLUMN IF NOT EXISTS sale_id   bigint;

-- which bill a unique piece went out on — the whole point of a per-piece code
CREATE INDEX IF NOT EXISTS ims_units_sale_idx ON ims_units (sale_id)
  WHERE sale_id IS NOT NULL;

-- Exact reverse of cartons_consume_src: each piece goes back to the box it was
-- taken from, read off the {sku,carton,qty} list that function returned.
CREATE OR REPLACE FUNCTION cartons_restore(p_taken jsonb) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  it    record;
  v_box bigint;
  v_cur int;
  v_n   int := 0;
BEGIN
  FOR it IN SELECT * FROM jsonb_to_recordset(COALESCE(p_taken, '[]'::jsonb))
                           AS x(sku text, carton text, qty int) LOOP
    CONTINUE WHEN it.sku IS NULL OR it.carton IS NULL OR COALESCE(it.qty, 0) <= 0;
    SELECT id INTO v_box FROM ims_cartons WHERE carton_no = it.carton FOR UPDATE;
    CONTINUE WHEN v_box IS NULL;   -- box was unpacked away since the sale
    SELECT qty INTO v_cur FROM ims_carton_items
     WHERE carton_id = v_box AND variant_sku = it.sku FOR UPDATE;
    IF v_cur IS NULL THEN
      INSERT INTO ims_carton_items (carton_id, variant_sku, qty) VALUES (v_box, it.sku, it.qty);
    ELSE
      UPDATE ims_carton_items SET qty = v_cur + it.qty
       WHERE carton_id = v_box AND variant_sku = it.sku;
    END IF;
    v_n := v_n + it.qty;
  END LOOP;
  UPDATE ims_cartons c
     SET total_qty = COALESCE((SELECT SUM(qty) FROM ims_carton_items ci
                                WHERE ci.carton_id = c.id), 0);
  RETURN v_n;
END $$;

-- Mark the unique t-shirt stickers that were actually scanned onto this bill.
-- Only 'in_stock' units move, so re-running it is harmless and a sticker that
-- is already sold is simply left alone (qty_on_hand is the real oversell guard).
CREATE OR REPLACE FUNCTION mark_units_sold(p_codes text[], p_sale_id bigint) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  WITH up AS (
    UPDATE ims_units u SET status = 'sold', sale_id = p_sale_id
     WHERE u.unit_code IN (SELECT upper(btrim(x)) FROM unnest(COALESCE(p_codes, '{}'::text[])) x)
       AND u.status = 'in_stock'
    RETURNING 1)
  SELECT count(*)::int INTO v_n FROM up;
  RETURN v_n;
END $$;

-- void_sale, plus the two restores. Unchanged otherwise; the early return on an
-- already-void bill is what stops a double restore.
CREATE OR REPLACE FUNCTION void_sale(p_sale_id bigint, p_by text DEFAULT NULL::text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE ln RECORD; v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM sales WHERE id = p_sale_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'Sale % not found', p_sale_id; END IF;
  IF v_status = 'void' THEN RETURN FALSE; END IF;
  FOR ln IN SELECT variant_sku, qty FROM sale_items WHERE sale_id = p_sale_id LOOP
    UPDATE variants SET qty_on_hand = qty_on_hand + ln.qty WHERE variant_sku = ln.variant_sku;
    INSERT INTO stock_movements (variant_sku, delta, reason, sale_id)
    VALUES (ln.variant_sku, ln.qty, 'void_restore', p_sale_id);
  END LOOP;

  -- put the pieces back where they were taken from, and un-sell the unique tees
  PERFORM cartons_restore((SELECT loc_taken FROM sales WHERE id = p_sale_id));
  UPDATE ims_units SET status = 'in_stock', sale_id = NULL WHERE sale_id = p_sale_id;

  UPDATE sales SET status = 'void', voided_by = NULLIF(btrim(p_by), ''), voided_at = now()
   WHERE id = p_sale_id;
  RETURN TRUE;
END $$;
