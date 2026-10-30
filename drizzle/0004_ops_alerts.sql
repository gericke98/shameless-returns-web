-- Durable ops-alert outbox. `alertOps` is best effort: a Postmark outage or a
-- crash loses the alert. A row here is retried until Postmark accepts it.
--
-- `dedupe_key` is explicit identity chosen by the producer
-- (`match-conflict:<amphora return id>`, later `shortfall:<id>:open<n>:stage1`),
-- so the same condition seen on every 15-minute run is one alert, not 96 a day.
-- Additive: a new table, nothing existing changes.
CREATE TABLE IF NOT EXISTS "ops_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dedupe_key" text NOT NULL UNIQUE,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "accepted_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_error" text
);
CREATE INDEX IF NOT EXISTS "ops_alerts_pending_idx"
  ON "ops_alerts" ("created_at") WHERE "accepted_at" IS NULL;
