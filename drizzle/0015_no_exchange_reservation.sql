-- FX step P4 (docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md §#8).
--
-- Applied ONLY after scripts/release-hold-drafts.ts --write has left no
-- releasable pointer (P3). From here on no code path can set a Shopify
-- stock-hold draft on an order: the column stays as history of what was
-- released (hold_draft_releases), and must be NULL.
--
-- Validated: it FAILS if any pointer remains. Then stop — Santi decides each
-- remaining `completed` / `still-exists` draft by hand before re-running.
-- Re-running it after success is harmless.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_no_exchange_reservation";
ALTER TABLE "orders" ADD CONSTRAINT "orders_no_exchange_reservation"
  CHECK ("exchange_reservation_id" IS NULL);
