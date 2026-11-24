-- Self-booked tracking is verified before Amphora pins it (write-once).
-- Additive only: two nullable columns, no backfill, nothing existing changes.
--
-- tracking_verified_at: when the number was verified. NULL with a locator on a
--   SELF return means "submitted, waiting for ops to confirm" — the number is
--   stored but NOT sent to Amphora.
-- tracking_verified_by: who verified it: a carrier ('correos', 'nacex',
--   'bpost') or the admin who confirmed it in the dashboard.
--
-- Rows submitted before this migration keep NULL in both. They were approved
-- at Amphora under the old flow; the confirm/reject UI only lists SELF rows
-- whose Amphora return is still PENDING, so they are not re-offered.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_verified_at timestamptz NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_verified_by text NULL;
