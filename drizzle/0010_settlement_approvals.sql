-- Settlement S3: Santi's approval of a legacy payment, as data.
--
-- docs/superpowers/specs/2026-10-30-settlement-S3-legacy-plan.md (D1/D2, and
-- Santi's decision of 30 Oct: "You set each amount").
--
-- The reconciliation lists settled lines it found unpaid (D2) and settled
-- exchanges whose replacement was cheaper than what came back (D1). Nothing
-- computes what is owed: the approver states the amount for each line. Each
-- approval is one row here, written in the SAME statement as the accepted
-- legacy submission that pays it, whose line pays exactly `amount_cents`.
--
-- The row is also admission's authority to plan that payment on a return that
-- is no longer OPEN (lib/settlement/plan.ts): the OPEN gate exists to catch a
-- settlement made outside the ledger, and an approval is the explicit human
-- finding, after a complete read, that none was. Only a line with a row here
-- is admitted past that gate.
--
-- One approval per line, ever. Additive: one new table. Applied by hand;
-- re-running it is harmless.
CREATE TABLE IF NOT EXISTS "settlement_approvals" (
  "productsorder_id" integer PRIMARY KEY,
  "submission_id" uuid NOT NULL REFERENCES "return_submissions" ("id"),
  -- 'unpaid': no payment evidence (D2). 'swap': the owed part of a cheaper
  -- exchange (D1).
  "basis" text NOT NULL CHECK ("basis" IN ('unpaid', 'swap')),
  "amount_cents" integer NOT NULL CHECK ("amount_cents" > 0),
  -- returned − replacement at approval time: the most an approval may pay.
  "cap_cents" integer NOT NULL,
  "approved_by" text NOT NULL CHECK (length(trim("approved_by")) > 0),
  "approved_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_approvals_cap_check" CHECK ("amount_cents" <= "cap_cents")
);
CREATE INDEX IF NOT EXISTS "settlement_approvals_submission_idx"
  ON "settlement_approvals" ("submission_id");
