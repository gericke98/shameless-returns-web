-- The customer's agreement for one submission, saved BEFORE checkout.
--
-- Until now the agreement lived only in the portal render and the Stripe
-- session: the webhook confirmed whatever the rows said at payment time, and
-- settlement recomputed what to pay. A submission is that agreement as data,
-- in integer cents, from lib/agreement.ts — the same function the portal
-- total and the Stripe charge are read from. Settlement executes it from S2
-- on (docs/superpowers/specs/2026-10-30-settlement-S1-agreement-plan.md).
--
-- Lifecycle: awaiting_payment → accepted, or → superseded (the customer
-- started a newer checkout) / abandoned (its Stripe session expired). At most
-- one awaiting_payment submission per order.
--
-- Additive: two new tables, nothing existing changes.
CREATE TABLE IF NOT EXISTS "return_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'awaiting_payment'
    CHECK ("state" IN ('awaiting_payment', 'accepted', 'superseded', 'abandoned')),
  "tender" text NOT NULL CHECK ("tender" IN ('refund', 'credit')),
  "return_method" text NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "return_leg_cents" integer NOT NULL,
  "outbound_leg_cents" integer NOT NULL,
  "charged_fee_cents" integer NOT NULL,
  "returned_value_cents" integer NOT NULL,
  "replacement_value_cents" integer NOT NULL,
  "net_cents" integer NOT NULL,
  "stripe_charge_cents" integer NOT NULL,
  "waived_cents" integer NOT NULL,
  "owed_cents" integer NOT NULL,
  "residual_cents" integer NOT NULL,
  "stripe_session_id" text UNIQUE,
  "stripe_payment_intent" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_at" timestamp with time zone,
  CONSTRAINT "return_submissions_net_check"
    CHECK ("returned_value_cents" - "replacement_value_cents" - "charged_fee_cents" = "net_cents"),
  CONSTRAINT "return_submissions_shortfall_check"
    CHECK ("stripe_charge_cents" + "waived_cents" = GREATEST(0, -"net_cents"))
);
CREATE UNIQUE INDEX IF NOT EXISTS "return_submissions_one_awaiting_per_order"
  ON "return_submissions" ("order_id") WHERE "state" = 'awaiting_payment';
CREATE INDEX IF NOT EXISTS "return_submissions_order_idx"
  ON "return_submissions" ("order_id");

-- One row per productsorder line the submission covers. Values are copied
-- from the agreement, never re-read from the live row: the row may be edited
-- after checkout, and what was paid for is what gets confirmed.
CREATE TABLE IF NOT EXISTS "submission_lines" (
  "submission_id" uuid NOT NULL REFERENCES "return_submissions" ("id") ON DELETE CASCADE,
  "productsorder_id" integer NOT NULL,
  "shopify_line_item_id" text NOT NULL,
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "action" text NOT NULL CHECK ("action" IN ('DEVOLUCIÓN', 'CAMBIO')),
  "new_variant_id" text,
  "reason" text,
  "notes" text,
  "returned_cents" integer NOT NULL,
  "replacement_cents" integer NOT NULL,
  "pay_cents" integer NOT NULL,
  "stripe_funded_cents" integer NOT NULL,
  "fulfillment_line_item_id" text,
  "return_line_item_id" text,
  PRIMARY KEY ("submission_id", "productsorder_id"),
  CONSTRAINT "submission_lines_cambio_check"
    CHECK (("action" = 'CAMBIO') = ("new_variant_id" IS NOT NULL))
);
