-- Per-parcel tracking-notification state. Both nullable: an order that has
-- never been polled has told the customer nothing, which is the correct
-- starting state for every existing row.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "last_tracking_key" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "last_tracking_locator" text;
