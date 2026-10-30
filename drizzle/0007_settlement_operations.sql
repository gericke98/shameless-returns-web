-- Settlement executes the agreement (S2), through an operations ledger.
--
-- docs/superpowers/specs/2026-10-30-settlement-S2-ledger-plan.md
--
-- Until now settlement recomputed what to pay, moved money BEFORE anything
-- durable said "in flight", and marked `productsorder.refunded` last — so a
-- crash between the two paid twice. From here on:
--
--  * a submission has ONE holder at a time (`settlement` or `cancellation`),
--    taken by a conditional UPDATE, so a cancel cannot race a payout;
--  * admission writes every external effect the agreement requires as a row in
--    `settlement_operations`, with its exact frozen request, in ONE statement;
--  * each row is claimed, dispatched and recorded through conditional UPDATEs
--    fenced on (owner, attempt), and only a row returned by the dispatch UPDATE
--    authorises the Shopify call;
--  * `refunded` is set only when EVERY effect a line needs is done.
--
-- Additive: new columns with defaults, new tables, a widened CHECK. Applied by
-- hand; re-running it is harmless.

-- ── return_submissions: ownership, provenance, admission sequence ──────────
ALTER TABLE "return_submissions"
  ADD COLUMN IF NOT EXISTS "holder" text,
  -- When the current holder took the submission: recovery alerts on a
  -- cancellation that has held it for over an hour without finishing.
  ADD COLUMN IF NOT EXISTS "holder_since" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "provenance" text NOT NULL DEFAULT 'agreed',
  ADD COLUMN IF NOT EXISTS "admission_seq" integer NOT NULL DEFAULT 0;

ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_holder_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_holder_check"
  CHECK ("holder" IS NULL OR "holder" IN ('settlement', 'cancellation'));

ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_provenance_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_provenance_check"
  CHECK ("provenance" IN ('agreed', 'legacy'));

-- `state` gains `cancelled`. 0006 declared the CHECK inline, so Postgres named
-- it return_submissions_state_check.
ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_state_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_state_check"
  CHECK ("state" IN ('awaiting_payment', 'accepted', 'superseded', 'abandoned', 'cancelled'));

-- ── submission_lines: settlement stamp, frozen reverse-fulfillment line ────
ALTER TABLE "submission_lines"
  ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reverse_fulfillment_line_item_id" text;

-- ── settlement_operations: one row per external effect ─────────────────────
CREATE TABLE IF NOT EXISTS "settlement_operations" (
  -- The effect key: idempotency key `<id>:<attempt>`, orderCreate
  -- sourceIdentifier, gift-card note and refund-note marker.
  "id" uuid PRIMARY KEY,
  "submission_id" uuid NOT NULL REFERENCES "return_submissions" ("id"),
  "kind" text NOT NULL CHECK ("kind" IN
    ('process_refund', 'root_refund', 'gift_card', 'exchange_order', 'release_hold', 'process_goods')),
  -- money:<s>:<po> | goods:<s>:<po> | exchange:<s> | hold:<s> | residual:<s>
  "scope_key" text NOT NULL UNIQUE,
  -- productsorder ids this effect settles. Immutable.
  "members" integer[] NOT NULL DEFAULT '{}',
  -- Dependency: this op may be claimed only once `after` is done.
  "after" uuid REFERENCES "settlement_operations" ("id"),
  -- The exact frozen mutation variables. Amounts come from submission_lines.
  "request" jsonb NOT NULL,
  "amount_cents" integer NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'EUR',
  "state" text NOT NULL DEFAULT 'pending' CHECK ("state" IN
    ('pending', 'claimed', 'dispatched', 'done', 'rejected', 'unresolved')),
  "attempt" integer NOT NULL DEFAULT 0,
  "owner" uuid,
  "lease_until" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  "effect_ref" text,
  "evidence" jsonb,
  "error" text,
  "resolved_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "settlement_operations_submission_idx"
  ON "settlement_operations" ("submission_id");
-- Recovery scans the live states only.
CREATE INDEX IF NOT EXISTS "settlement_operations_live_idx"
  ON "settlement_operations" ("state", "updated_at")
  WHERE "state" IN ('pending', 'claimed', 'dispatched');

-- ── replacement_lines: how each line of an exchange order we created was funded
CREATE TABLE IF NOT EXISTS "replacement_lines" (
  "exchange_operation_id" uuid NOT NULL REFERENCES "settlement_operations" ("id"),
  "source_submission_id" uuid NOT NULL REFERENCES "return_submissions" ("id"),
  -- The returned garment this replacement line replaces.
  "source_productsorder_id" integer NOT NULL,
  -- The exchange order (numeric Shopify id) and its line item gid.
  "order_id" text NOT NULL,
  "line_item_id" text NOT NULL UNIQUE,
  "variant_id" text NOT NULL,
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "stripe_funded_cents" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("exchange_operation_id", "source_productsorder_id")
);
CREATE INDEX IF NOT EXISTS "replacement_lines_order_idx"
  ON "replacement_lines" ("order_id");
