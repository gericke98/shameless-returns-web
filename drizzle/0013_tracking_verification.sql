-- Self-booked tracking is verified before Amphora pins it (write-once).
-- Additive only: two nullable columns, and a stamp in them (below); nothing existing changes.
--
-- tracking_verified_at: when the number was verified. NULL with a locator on a
--   SELF return means "submitted, waiting for ops to confirm" — the number is
--   stored but NOT sent to Amphora.
-- tracking_verified_by: who verified it: a carrier ('correos', 'nacex',
--   'bpost') or the admin who confirmed it in the dashboard.
--
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_verified_at timestamptz NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_verified_by text NULL;

-- Stamp, explicitly, the self-booked numbers Amphora already pinned under the
-- old flow, so the dashboard's "Tracking to confirm" list (locator set,
-- tracking_verified_at NULL) does not re-offer them. Read on prod 2026-11-24:
-- every SELF row with a locator is APROVED or RECEIVED at Amphora except
-- #311595, which is PENDING with its own order number as "tracking" — it stays
-- unverified and appears in the list for ops to reject. Only the two new
-- columns are written; nothing existing changes.
UPDATE orders
   SET tracking_verified_at = COALESCE(tracking_submitted_at, now()),
       tracking_verified_by = 'approved-before-verification'
 WHERE return_method = 'SELF'
   AND locator IS NOT NULL
   AND tracking_verified_at IS NULL
   AND return_status IS DISTINCT FROM 'PENDING';
