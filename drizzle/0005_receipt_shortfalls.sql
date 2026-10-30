-- One row per (Amphora return, SKU) where the warehouse counted fewer units
-- than the customer still has open. Owner = the Amphora return: the warehouse
-- counts one parcel even when our lines carry several Shopify return gids,
-- which are kept as data in `shopify_return_ids`.
--
-- Lifecycle: opened when seen short; `resolved_at` set only on a positive
-- observation (count ok, all lines settled, or every Shopify return involved
-- CLOSED/CANCELED); a shortage that comes back reopens the SAME row with
-- `reopen_count` + 1, stage 0 and a fresh anchor, and `reopen_count` is part
-- of the ops_alerts dedupe key so the reopened case alerts again.
--
-- `alert_stage`: 0 none accepted, 1 first alert accepted, 2 escalation
-- accepted. `first_alert_accepted_at` is the 7-day escalation anchor, written
-- once per opening, from the outbox row's own `accepted_at`.
-- Additive: a new table, nothing existing changes. Needs 0004 (ops_alerts).
CREATE TABLE IF NOT EXISTS "receipt_shortfalls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "amphora_return_id" text NOT NULL,
  "order_id" text NOT NULL,
  "sku" text NOT NULL,
  "shopify_return_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "declared_qty" integer NOT NULL,
  "received_qty" integer NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "alert_stage" smallint NOT NULL DEFAULT 0,
  "first_alert_accepted_at" timestamp with time zone,
  "reopen_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "receipt_shortfalls_return_sku_key" UNIQUE ("amphora_return_id", "sku")
);
CREATE INDEX IF NOT EXISTS "receipt_shortfalls_open_idx"
  ON "receipt_shortfalls" ("order_id") WHERE "resolved_at" IS NULL;
