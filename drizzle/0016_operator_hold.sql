-- An operator may hold an accepted submission before settlement holds it
-- itself (scripts/resolve-hold.ts --submission <id> --open): the case where
-- a customer was paid by hand outside the ledger and nothing automated may
-- settle it again. Widens one CHECK; additive. Applied by hand BEFORE deploy;
-- re-running it is harmless.
ALTER TABLE "settlement_holds" DROP CONSTRAINT IF EXISTS "settlement_holds_cause_check";
ALTER TABLE "settlement_holds" ADD CONSTRAINT "settlement_holds_cause_check"
  CHECK ("cause" IN ('stock-short', 'exchange-rejected', 'legacy-plan', 'operator'));
