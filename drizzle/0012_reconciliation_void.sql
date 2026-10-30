-- S3 corrections, 30 Oct. 0006–0011 are applied in production; this file
-- only adds.
--
-- 1. A reconciled record built on a FOREIGN return is voided, never deleted.
--    The pre-S1 confirm write keyed rows by variant and stamped one order's
--    Shopify return onto rows of OTHER orders sharing the variant. R1 grouped
--    by that return_id, so it recorded #34911's return (Return/37215633734)
--    as a reconciled submission of #34700 (row 181). An operator voids such a
--    record (scripts/void-reconciliation.ts) after Shopify's read shows that
--    the return's order is not the submission's order:
--      - the submission becomes `voided`: it no longer stands on its rows;
--      - its operations become `void`: no fence (claim, recovery, the
--        operator's done/rejected) matches them;
--      - one reconciliation_voids row says who, why, the return and the order
--        Shopify says owns it.
--    All three are written in ONE statement. Every row, operation, alert and
--    line of the voided record stays as history. A record with a DONE
--    operation is not voidable: its line was settled on it.
--
-- 2. replacement_funding_decisions (Santi 30 Oct, A — scripts/fund-replacement-
--    line.ts). It was briefly added to 0011 in the working tree. IF NOT EXISTS
--    makes this a no-op wherever that version of 0011 was applied.
--
-- Additive: two widened CHECKs and two new tables. Applied by hand; re-running
-- it is harmless.

ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_state_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_state_check"
  CHECK ("state" IN ('awaiting_payment', 'accepted', 'superseded', 'abandoned', 'cancelled', 'reconciled', 'voided'));

-- 0007 declared the state CHECK inline, so Postgres named it settlement_operations_state_check.
ALTER TABLE "settlement_operations" DROP CONSTRAINT IF EXISTS "settlement_operations_state_check";
ALTER TABLE "settlement_operations" ADD CONSTRAINT "settlement_operations_state_check"
  CHECK ("state" IN ('pending', 'claimed', 'dispatched', 'done', 'rejected', 'unresolved', 'void'));

CREATE TABLE IF NOT EXISTS "reconciliation_voids" (
  "submission_id" uuid PRIMARY KEY REFERENCES "return_submissions" ("id"),
  -- The Shopify return the record was built on, and the order Shopify says owns it (gid).
  "return_id" text NOT NULL,
  "return_order_id" text NOT NULL,
  "voided_by" text NOT NULL CHECK (length(trim("voided_by")) > 0),
  "evidence" text NOT NULL CHECK (length(trim("evidence")) > 0),
  "voided_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "replacement_funding_decisions" (
  "id" serial PRIMARY KEY,
  -- The replacement (exchange) order, bare Shopify id, and the line it replaced.
  "order_id" text NOT NULL,
  "source_productsorder_id" integer NOT NULL,
  "stripe_session_id" text NOT NULL,
  -- The session's amount_total as Stripe answered it when the decision was made.
  "session_amount_cents" integer NOT NULL CHECK ("session_amount_cents" > 0),
  "funded_cents" integer NOT NULL CHECK ("funded_cents" > 0),
  "decided_by" text NOT NULL CHECK (length(trim("decided_by")) > 0),
  "evidence" text NOT NULL CHECK (length(trim("evidence")) > 0),
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "replacement_funding_decisions_within_session"
    CHECK ("funded_cents" <= "session_amount_cents")
);
CREATE UNIQUE INDEX IF NOT EXISTS "replacement_funding_decisions_line_idx"
  ON "replacement_funding_decisions" ("order_id", "source_productsorder_id");
CREATE INDEX IF NOT EXISTS "replacement_funding_decisions_session_idx"
  ON "replacement_funding_decisions" ("stripe_session_id");
