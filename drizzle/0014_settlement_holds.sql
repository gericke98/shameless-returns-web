-- FX: an exchange's replacement is backed by Amphora's stock
-- (docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md §#7, §#8,
-- amendments A2, A3). 0001–0013 are applied in production; this file only adds.
--
-- 1. `settlement_holds`: a submission settlement must not move, as data.
--    Written on the submission's `admission_seq` fence (lib/settlement/
--    ledger.ts), each with its ops_alerts outbox row in the SAME statement:
--      stock-short       — Amphora cannot cover the replacement (admission,
--                          or before a fresh orderCreate, A1);
--      exchange-rejected — Shopify definitely refused the orderCreate;
--      legacy-plan       — an operation frozen in a shape FX no longer runs
--                          (A3: IGNORING_POLICY, release_hold, or a sibling
--                          not gated on the exchange).
--    "Blocking" = open (resolved_at IS NULL) or resolved 'manual'. One open
--    hold per submission. An operator takes a hold BEFORE settling it by hand
--    (`taken_*`, A2) and records the outcome after (`resolution` 'manual'), or
--    releases it (`resolution` 'release', never on a taken hold).
-- 2. `hold_draft_releases`: one row per Shopify stock-hold draft the migration
--    authority looked at (scripts/release-hold-drafts.ts), append-only.
-- 3. `return_submissions.holder` gains 'manual' (A2): an operator owns the
--    submission; settlement, cancellation and recovery all refuse it.
-- 4. `accepted_at` is total for accepted submissions (D2 orders by it). P0
--    verifies zero violations before this is applied.
--
-- Additive: two new tables, a widened CHECK, a new CHECK. Applied by hand;
-- re-running it is harmless.

CREATE TABLE IF NOT EXISTS "settlement_holds" (
  "id" uuid PRIMARY KEY,
  "submission_id" uuid NOT NULL REFERENCES "return_submissions" ("id"),
  "cause" text NOT NULL CHECK ("cause" IN ('stock-short', 'exchange-rejected', 'legacy-plan')),
  -- The rejected orderCreate, for an exchange-rejected hold only.
  "exchange_operation_id" uuid REFERENCES "settlement_operations" ("id"),
  -- The shortfall per SKU, the userErrors, or the legacy operation ids.
  "detail" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- A2: who took the submission to settle it by hand, before touching Shopify/Stripe.
  "taken_by" text,
  "taken_at" timestamp with time zone,
  "resolution" text CHECK ("resolution" IN ('release', 'manual')),
  "resolved_by" text,
  "evidence" text,
  "resolved_at" timestamp with time zone,
  CONSTRAINT "settlement_holds_exchange_operation_check"
    CHECK (("cause" = 'exchange-rejected') = ("exchange_operation_id" IS NOT NULL)),
  CONSTRAINT "settlement_holds_resolution_fields_check"
    CHECK (
      ("resolution" IS NULL AND "resolved_by" IS NULL AND "evidence" IS NULL AND "resolved_at" IS NULL)
      OR ("resolution" IS NOT NULL AND length(trim("resolved_by")) > 0
          AND length(trim("evidence")) > 0 AND "resolved_at" IS NOT NULL)
    ),
  CONSTRAINT "settlement_holds_taken_check"
    CHECK (
      ("taken_by" IS NULL AND "taken_at" IS NULL)
      OR (length(trim("taken_by")) > 0 AND "taken_at" IS NOT NULL)
    ),
  -- A2: settled by hand only after it was taken; a taken hold is never released.
  CONSTRAINT "settlement_holds_manual_taken_check"
    CHECK ("resolution" IS DISTINCT FROM 'manual' OR "taken_at" IS NOT NULL),
  CONSTRAINT "settlement_holds_release_untaken_check"
    CHECK ("resolution" IS DISTINCT FROM 'release' OR "taken_at" IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_holds_one_open"
  ON "settlement_holds" ("submission_id") WHERE "resolved_at" IS NULL;
CREATE INDEX IF NOT EXISTS "settlement_holds_submission_idx"
  ON "settlement_holds" ("submission_id");

CREATE TABLE IF NOT EXISTS "hold_draft_releases" (
  "id" uuid PRIMARY KEY,
  -- The order whose persisted pointer named the draft, and that draft (gid).
  "order_id" text NOT NULL,
  "draft_order_id" text NOT NULL,
  "outcome" text NOT NULL
    CHECK ("outcome" IN ('unreadable', 'already-gone', 'completed', 'deleted', 'still-exists')),
  "detail" jsonb NOT NULL,
  "released_by" text NOT NULL CHECK (length(trim("released_by")) > 0),
  -- The order's pointer was cleared by this row's statement (it still named this draft).
  "pointer_cleared" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "hold_draft_releases_pointer_check"
    CHECK (NOT "pointer_cleared" OR "outcome" IN ('deleted', 'already-gone'))
);
CREATE INDEX IF NOT EXISTS "hold_draft_releases_order_idx"
  ON "hold_draft_releases" ("order_id");

ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_holder_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_holder_check"
  CHECK ("holder" IS NULL OR "holder" IN ('settlement', 'cancellation', 'manual'));

ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_accepted_at_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_accepted_at_check"
  CHECK ("state" <> 'accepted' OR "accepted_at" IS NOT NULL);
