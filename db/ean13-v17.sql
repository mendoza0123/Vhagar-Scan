-- ============================================================
-- v17 — EAN-13 per variant, for the retail hang-tag.
--
-- An EAN-13 is NOT something we can invent: the first digits are a GS1 company
-- prefix licensed to one company, and a made-up number collides with somebody
-- else's product on every scanner in the country. So this stores the number and
-- can ALLOCATE one once Vhagar holds a GS1 India prefix — it never fabricates a
-- prefix of its own.
--
-- Until a prefix exists, variants.ean13 stays NULL and the tag falls back to a
-- Code128 of the variant SKU, which scans on our own POS and on any warehouse
-- scanner — just not as a retail GTIN.
-- ============================================================

ALTER TABLE variants ADD COLUMN IF NOT EXISTS ean13 TEXT;

-- 13 digits or nothing; a wrong-length "EAN" is worse than no EAN
ALTER TABLE variants DROP CONSTRAINT IF EXISTS variants_ean13_check;
ALTER TABLE variants ADD CONSTRAINT variants_ean13_check
  CHECK (ean13 IS NULL OR ean13 ~ '^[0-9]{13}$');

-- unique only where present, so the 915 variants without one don't collide
CREATE UNIQUE INDEX IF NOT EXISTS variants_ean13_key ON variants (ean13) WHERE ean13 IS NOT NULL;

-- Standard GS1 modulo-10: weight the 12 digits 1,3,1,3… then round up to the
-- next multiple of ten. Same maths every scanner checks on the way in.
CREATE OR REPLACE FUNCTION ean13_check_digit(p12 text) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  s int := 0;
  i int;
BEGIN
  IF p12 !~ '^[0-9]{12}$' THEN RAISE EXCEPTION 'Need exactly 12 digits, got "%".', p12; END IF;
  FOR i IN 1..12 LOOP
    s := s + substr(p12, i, 1)::int * CASE WHEN i % 2 = 1 THEN 1 ELSE 3 END;
  END LOOP;
  RETURN (10 - (s % 10)) % 10;
END $fn$;

-- Validate a whole 13-digit number — used when EANs are typed or imported, so a
-- transposed digit is caught at the keyboard instead of at the retailer's till.
CREATE OR REPLACE FUNCTION ean13_valid(p13 text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p13 ~ '^[0-9]{13}$'
     AND substr(p13, 13, 1)::int = ean13_check_digit(substr(p13, 1, 12))
$fn$;

-- Allocate the next number under OUR company prefix. The prefix is passed in
-- (it lives in the app's env, not in the schema) so this file carries no made-up
-- GS1 identity. Item references are handed out in order and never reused: an
-- EAN that has been on a garment in a shop can't be given to another product.
CREATE OR REPLACE FUNCTION assign_ean13(p_sku text, p_prefix text, p_by text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_sku    text := upper(btrim(p_sku));
  v_prefix text := btrim(COALESCE(p_prefix, ''));
  v_width  int;
  v_next   bigint;
  v_body   text;
  v_ean    text;
  v_have   text;
BEGIN
  SELECT ean13 INTO v_have FROM variants WHERE variant_sku = v_sku;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown SKU %', v_sku; END IF;
  IF v_have IS NOT NULL THEN                      -- idempotent: never re-number
    RETURN jsonb_build_object('variant_sku', v_sku, 'ean13', v_have, 'created', false);
  END IF;

  IF v_prefix !~ '^[0-9]{6,11}$' THEN
    RAISE EXCEPTION 'GS1 company prefix must be 6–11 digits — set GS1_COMPANY_PREFIX once Vhagar is a GS1 India member.';
  END IF;

  v_width := 12 - length(v_prefix);               -- digits left for the item reference
  IF v_width < 1 THEN RAISE EXCEPTION 'That prefix leaves no room for an item number.'; END IF;

  -- next item reference under this prefix, continuing from whatever is already issued
  SELECT COALESCE(max(substr(ean13, length(v_prefix) + 1, v_width)::bigint), 0) + 1
    INTO v_next
    FROM variants
   WHERE ean13 LIKE v_prefix || '%';

  IF v_next >= pow(10, v_width) THEN
    RAISE EXCEPTION 'This GS1 prefix is full (% numbers used).', v_next - 1;
  END IF;

  v_body := v_prefix || lpad(v_next::text, v_width, '0');
  v_ean  := v_body || ean13_check_digit(v_body)::text;

  UPDATE variants SET ean13 = v_ean WHERE variant_sku = v_sku;
  RETURN jsonb_build_object('variant_sku', v_sku, 'ean13', v_ean, 'created', true, 'by', p_by);
END $fn$;
