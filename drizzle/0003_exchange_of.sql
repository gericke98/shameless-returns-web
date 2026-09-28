-- The order this one REPLACES, when it is one of our exchange orders.
--
-- Null means "an ordinary purchase", which is every existing row, so no
-- backfill is needed for correctness; scripts/repair-replacement-order-rows.ts
-- sets it on the few replacement orders already looked up. Points at the
-- IMMEDIATE original; code walks the chain to the root, where the money is.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "exchange_of" text;
