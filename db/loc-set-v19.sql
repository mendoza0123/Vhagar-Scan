-- v19 — loc_set: put an exact number of pieces on the Rack or Display box
-- WITHOUT taking them out of a carton.
--
-- The existing movers both assume the piece comes from somewhere: stage_move
-- pulls it out of a Packed carton, loc_move needs a named source. The booth
-- stock register doesn't work that way — it lists Display, Rack and Carton as
-- three SEPARATE piles ("2 in the carton AND 1 on the rack"), so importing it
-- must add to a staging box while leaving the packed cartons exactly as they
-- are. Hence a setter rather than a mover.
--
-- It SETS rather than adds, so re-importing a corrected sheet converges instead
-- of doubling. Stock is never touched: qty_on_hand stays the one number POS
-- sells against, and the only hard rule is that the boxes can never between
-- them claim more pieces than really exist.

CREATE OR REPLACE FUNCTION loc_set(p_items jsonb, p_by text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  it        record;
  v_sku     text;
  v_loc     text;
  v_want    int;
  v_box     bigint;
  v_cur     int;
  v_else    int;
  v_stock   int;
  v_new     int;
  v_changed int   := 0;
  v_capped  jsonb := '[]'::jsonb;
  v_unknown jsonb := '[]'::jsonb;
BEGIN
  FOR it IN SELECT * FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb))
                           AS x(sku text, loc text, qty int) LOOP
    v_sku  := upper(btrim(COALESCE(it.sku, '')));
    v_loc  := upper(btrim(COALESCE(it.loc, '')));
    v_want := GREATEST(0, COALESCE(it.qty, 0));
    CONTINUE WHEN v_sku = '';
    IF v_loc NOT IN ('RACK', 'DISPLAY') THEN
      RAISE EXCEPTION 'loc_set only fills RACK or DISPLAY, got %', v_loc;
    END IF;

    SELECT qty_on_hand INTO v_stock FROM variants WHERE variant_sku = v_sku;
    IF v_stock IS NULL THEN
      v_unknown := v_unknown || to_jsonb(v_sku);
      CONTINUE;
    END IF;

    v_box := stage_carton_id(v_loc, CASE v_loc WHEN 'DISPLAY' THEN 'Display' ELSE 'Rack' END);
    SELECT COALESCE(qty, 0) INTO v_cur FROM ims_carton_items
     WHERE carton_id = v_box AND variant_sku = v_sku FOR UPDATE;
    v_cur := COALESCE(v_cur, 0);

    -- everything this SKU already has in every OTHER box
    SELECT COALESCE(SUM(ci.qty), 0)::int INTO v_else
      FROM ims_carton_items ci JOIN ims_cartons c ON c.id = ci.carton_id
     WHERE ci.variant_sku = v_sku
       AND c.status IN ('Packed', 'Rack', 'Display')
       AND ci.carton_id <> v_box;

    -- the boxes together may never claim more pieces than actually exist
    v_new := LEAST(v_want, GREATEST(0, v_stock - v_else));
    IF v_new < v_want THEN
      v_capped := v_capped || jsonb_build_object(
        'sku', v_sku, 'loc', v_loc, 'asked', v_want, 'set', v_new,
        'stock', v_stock, 'elsewhere', v_else);
    END IF;
    CONTINUE WHEN v_new = v_cur;

    IF v_new = 0 THEN
      DELETE FROM ims_carton_items WHERE carton_id = v_box AND variant_sku = v_sku;
    ELSIF v_cur = 0 THEN
      INSERT INTO ims_carton_items (carton_id, variant_sku, qty) VALUES (v_box, v_sku, v_new);
    ELSE
      UPDATE ims_carton_items SET qty = v_new
       WHERE carton_id = v_box AND variant_sku = v_sku;
    END IF;

    INSERT INTO ims_rack_moves (variant_sku, qty, from_carton, moved_by, action)
    VALUES (v_sku, v_new - v_cur, 'STOCK REGISTER', p_by, 'set_' || lower(v_loc));
    v_changed := v_changed + 1;
  END LOOP;

  UPDATE ims_cartons c
     SET total_qty = COALESCE((SELECT SUM(qty) FROM ims_carton_items ci
                                WHERE ci.carton_id = c.id), 0)
   WHERE c.status IN ('Packed', 'Rack', 'Display');

  RETURN jsonb_build_object('changed', v_changed, 'capped', v_capped, 'unknown', v_unknown);
END $$;
