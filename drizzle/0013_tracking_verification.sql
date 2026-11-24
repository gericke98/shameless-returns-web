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
-- re-offer them. Named one by one, by orders.id: the cohort audited on prod 2026-11-24
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
   AND id IN (  -- orders.id, with order number and Amphora status as audited
     '13241157779782', -- #311349 RECEIVED
     '13261798801734', -- #311531 RECEIVED
     '13269784822086', -- #311607 RECEIVED
     '13273500451142', -- #311658 RECEIVED
     '13287776944454', -- #311801 RECEIVED
     '13288358707526', -- #311811 RECEIVED
     '13288504328518', -- #311812 RECEIVED
     '13311092064582', -- #311997 RECEIVED
     '13315041100102', -- #312011 RECEIVED
     '13385395011910', -- #312152 APROVED
     '13398442705222', -- #312202 APROVED
     '13421796426054', -- #312284 RECEIVED
     '13431698358598', -- #312332 RECEIVED
     '13481797026118', -- #312577 APROVED
     '13508827447622', -- #312665 RECEIVED
     '13530002227526', -- #312737 APROVED
     '13540873732422', -- #312783 APROVED
     '13579117199686'  -- #313127 APROVED
   );
