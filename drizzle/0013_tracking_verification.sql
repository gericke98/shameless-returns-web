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

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_submission_id uuid NULL;

-- Self-booked rows with a number on 2026-11-24 were submitted under the old
-- flow, which approved at Amphora at once. Each gets an id, so ops review can
-- name it like any new submission.
UPDATE orders
   SET tracking_submission_id = gen_random_uuid()
 WHERE return_method = 'SELF'
   AND locator IS NOT NULL
   AND tracking_submission_id IS NULL;

-- Mark the ones Amphora ALREADY PINNED, so "Tracking to confirm" does not
-- re-offer them. Named one by one: the cohort audited on prod 2026-11-24
-- (Amphora status APROVED or RECEIVED for each). Not inferred from a status
-- rule, so a row that appears later, or one whose approve never happened,
-- is never stamped by this. Left out on purpose: #311595 (PENDING at Amphora,
-- its own order number as "tracking") — it appears for ops to reject.
-- `tracking_verified_by` says what this is: not a verification, a record that
-- the number was pinned before verification existed.
UPDATE orders
   SET tracking_verified_at = COALESCE(tracking_submitted_at, now()),
       tracking_verified_by = 'pinned-before-verification'
 WHERE return_method = 'SELF'
   AND locator IS NOT NULL
   AND tracking_verified_at IS NULL
   AND order_number IN (
     '#311658', '#311607', '#311349', '#311811', '#311531', '#311812',
     '#311801', '#312011', '#311997', '#312152', '#312202', '#312332',
     '#312577', '#312284', '#312665', '#312783', '#312737', '#313127'
   );
