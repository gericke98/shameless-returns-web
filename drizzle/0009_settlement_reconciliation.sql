-- Settlement S3: the legacy reconciliation, recorded in the ledger.
--
-- docs/superpowers/specs/2026-10-30-settlement-S3-legacy-plan.md
--
-- scripts/reconcile-legacy.ts reads Shopify for every confirmed line the
-- ledger has never touched and records what it found as operations:
-- a payment already made is a `done` operation, evidence that does not decide
-- is an `unresolved` one for a human. Those operations RECORD THE PAST — none
-- of them may ever be sent. Their submission is therefore in its own state,
-- `reconciled`:
--
--  * it is never `accepted`, so admission never plans or pays from it, and a
--    line found unpaid can still be paid through an ordinary accepted legacy
--    submission once Santi approves it (D1/D2 = A);
--  * the ledger's claim and recovery skip every operation that belongs to one
--    (lib/settlement/ledger.ts), so an operator's `rejected` ("no payment
--    happened") cannot turn a record into a send.
--
-- And D3 = A: a human sets the action on a line whose action is NULL, through
-- scripts/set-line-action.ts. Each decision is a row here, written in the same
-- statement as the change it explains.
--
-- Additive: a widened CHECK and one new table. Applied by hand; re-running it
-- is harmless.

ALTER TABLE "return_submissions" DROP CONSTRAINT IF EXISTS "return_submissions_state_check";
ALTER TABLE "return_submissions" ADD CONSTRAINT "return_submissions_state_check"
  CHECK ("state" IN ('awaiting_payment', 'accepted', 'superseded', 'abandoned', 'cancelled', 'reconciled'));

CREATE TABLE IF NOT EXISTS "line_action_decisions" (
  "id" serial PRIMARY KEY,
  "productsorder_id" integer NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('DEVOLUCIÓN', 'CAMBIO')),
  "new_variant_id" text,
  "decided_by" text NOT NULL,
  "evidence" text NOT NULL,
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "line_action_decisions_cambio_check"
    CHECK (("action" = 'CAMBIO') = ("new_variant_id" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "line_action_decisions_line_idx"
  ON "line_action_decisions" ("productsorder_id");
