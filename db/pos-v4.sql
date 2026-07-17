-- POS v4 — exhibition prep (2026-07-16)

-- 1. Price the newly-registered styles. products.base_price already held the
--    right figure; only the VARIANTS were still flagged needs_price, which is
--    what blocks billing. Scoped to an explicit style list so nothing else moves.
--    CANVAS 999 · CHECKS 1499 · COAL 999 · GUESS 1499 · ITALIAN 999
--    LUXURY LINEN 1299 · PLAY 999
UPDATE variants v SET price = x.price, needs_price = FALSE
FROM (VALUES
  ('VH-CS336A',   999),   -- CANVAS 336 A
  ('VH-CHK04',   1499),   -- CHECKS 04
  ('VH-CLB222A',  999),   -- COAL B222A
  ('VH-CLC172',   999),   -- COAL C 172
  ('VH-GS1001B', 1499),   -- GUESS 1001 B
  ('VH-ITC325A',  999),   -- ITALIAN C325A
  ('VH-ITD15A',   999),   -- ITALIAN D15A
  ('VH-LX22',    1299),   -- LUXURY LINEN 022
  ('VH-LX04',    1299),   -- LUXURY LINEN 04
  ('VH-LX09',    1299),   -- LUXURY LINEN 09
  ('VH-LX12',    1299),   -- LUXURY LINEN 12
  ('VH-PLYC169',  999),   -- PLAY C169
  ('VH-PLYD25A',  999)    -- PLAY D 25A
) AS x(style_code, price)
WHERE v.style_code = x.style_code;

-- 1b. The three legacy PLAY styles were seeded as "always ask the price"
--     (bargaining pieces). They are on the booth rack with 17 pcs of stock and
--     would block at the till, so per the owner they now pre-fill at 999. Price
--     stays editable per sale, so bargaining still works — it just no longer stops
--     the counter. (VH-KN100 keeps prompting; it has no rack stock.)
UPDATE variants v SET price = 999, needs_price = FALSE
WHERE v.style_code IN ('VH-PLV5197A', 'VH-X5C28A', 'VH-Y5A183B');
UPDATE products SET base_price = 999
WHERE style_code IN ('VH-PLV5197A', 'VH-X5C28A', 'VH-Y5A183B');

-- keep the product header in step with its variants
UPDATE products p SET base_price = x.price
FROM (VALUES
  ('VH-CS336A', 999), ('VH-CHK04', 1499), ('VH-CLB222A', 999), ('VH-CLC172', 999),
  ('VH-GS1001B', 1499), ('VH-ITC325A', 999), ('VH-ITD15A', 999),
  ('VH-LX22', 1299), ('VH-LX04', 1299), ('VH-LX09', 1299), ('VH-LX12', 1299),
  ('VH-PLYC169', 999), ('VH-PLYD25A', 999)
) AS x(style_code, price)
WHERE p.style_code = x.style_code;

-- 2. Test bills are not business. A sale of TEST FABRIC gets flagged here, is
--    numbered in its own VH-2026-TestNN series, and is hidden from the Sales
--    log + CSV — so staff can rehearse mid-exhibition without polluting takings.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_sales_is_test ON sales(is_test);

-- 3. Bill numbers come from their own sequences, not from sales.id.
--    Two counters can bill at the same moment, so counting rows to pick the next
--    number would hand both the SAME bill no; nextval cannot. Separate sequences
--    also keep the real series gapless (VH-2026-0001, 0002 …) no matter how many
--    test bills are rung up in between (VH-2026-Test01, Test02 …).
CREATE SEQUENCE IF NOT EXISTS sales_bill_seq START 1;
CREATE SEQUENCE IF NOT EXISTS sales_test_seq START 1;
