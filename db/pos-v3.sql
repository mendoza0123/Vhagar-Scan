-- POS v3: capture the customer's email (optional).
-- Lets a bill be emailed to the customer from pos@vhagar.co. Data-only column;
-- the bill shows it and the "Share Email" button pre-fills a Gmail compose.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_email TEXT;
