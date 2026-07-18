-- POS v5 — offers (2026-07-17).
-- Which offer(s) a bill used, e.g. "Offer 3 (2nd 25% off: -₹325) + Offer 4
-- (Mystery: -₹300)". Data/analytics only — the bill just shows the discount.
-- The discount amounts themselves land in sales.discount as before.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS offer TEXT;
