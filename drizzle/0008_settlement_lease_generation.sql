-- Separate WHO may act on an operation from WHICH financial attempt it is
-- (S2 review finding 1).
--
-- 0007 fenced every transition on `attempt`, the same number that forms the
-- refundCreate idempotency key `<op id>:<attempt>`. So taking over an expired
-- claim — an ownership change — also minted a new financial attempt, and a
-- root refund whose first send was still in flight could be re-sent under a
-- fresh key and paid twice.
--
-- `lease_gen` is the worker fence: it moves on every claim or takeover, and
-- every dispatch and record is fenced on (owner, lease_gen). `attempt` now
-- moves ONLY when a new send is proven safe (a pending op's first send, or an
-- op Shopify rejected), never on an ownership change.
--
-- Additive: one column with a default. Applied by hand; re-running is harmless.
ALTER TABLE "settlement_operations"
  ADD COLUMN IF NOT EXISTS "lease_gen" integer NOT NULL DEFAULT 0;
