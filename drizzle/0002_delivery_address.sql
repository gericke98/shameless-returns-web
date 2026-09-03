-- Where the replacement goes, when that is not where the parcel came from.
--
-- All seven nullable, and null is load-bearing: it means "deliver to the
-- collection address", so every existing row keeps its current destination
-- and its current price with no backfill. Additive and reversible.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_name" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_address1" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_address2" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_zip" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_city" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_province" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_country" text;
