-- POS v6 — who voided a bill, and when (2026-07-18).
-- A void restocks real inventory; it needs a name against it just like a sale.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_by TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

-- void_sale gains the actor. Drop the old 1-arg version first — CREATE OR
-- REPLACE with a different arg list would create an overload, not replace it.
DROP FUNCTION IF EXISTS void_sale(BIGINT);
CREATE OR REPLACE FUNCTION void_sale(p_sale_id BIGINT, p_by TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
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
  UPDATE sales SET status = 'void', voided_by = NULLIF(btrim(p_by), ''), voided_at = now()
   WHERE id = p_sale_id;
  RETURN TRUE;
END $$;
