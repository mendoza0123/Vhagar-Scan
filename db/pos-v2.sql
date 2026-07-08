-- POS v2: void/restock + a test SKU for QR testing.

-- Void a completed sale: restore each line's qty, ledger it, mark 'void'.
-- Idempotent — voiding an already-void sale is a no-op returning FALSE.
CREATE OR REPLACE FUNCTION void_sale(p_sale_id BIGINT)
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
  UPDATE sales SET status = 'void' WHERE id = p_sale_id;
  RETURN TRUE;
END $$;

-- Point-of-sale channel (Exhibition / Shopify / Flipkart / free text) — captured
-- for analytics, NOT shown on the bill.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS channel TEXT;

-- Test SKU (₹1) so staff can print a QR and run a full scan→bill→void cycle.
INSERT INTO products (style_code, name, color, category, fabric, base_price, channels)
VALUES ('VH-TEST', 'TEST FABRIC', 'Slate', 'Test', 'Cotton', 1, 'TEST')
ON CONFLICT (style_code) DO NOTHING;
INSERT INTO variants (variant_sku, style_code, size, price, needs_price, qty_on_hand)
VALUES ('VH-TEST-M','VH-TEST','M',1,false,50),
       ('VH-TEST-L','VH-TEST','L',1,false,50)
ON CONFLICT (variant_sku) DO UPDATE SET qty_on_hand = 50;
