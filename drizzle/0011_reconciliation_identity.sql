-- Settlement S3: identity the legacy reconciliation needs as data, not as
-- inference (docs/superpowers/specs/2026-10-30-settlement-S3-legacy-plan.md,
-- Codex review of 30 Oct, findings 1, 3 and 5).
--
-- reconciliation_effect_decisions — a human's decision about ONE historical
--   effect, by its stable id: a Shopify Refund gid that moved money and names
--   no line, or a Stripe Checkout Session id paid with no order in its
--   metadata. `binds` attributes it to one productsorder line; `excludes`
--   says it paid no reconciled line. Until one exists, every line the effect
--   could have paid stays ambiguous (lib/settlement/reconcile.ts) and every
--   funding it could have carried stays unresolved. One decision per effect,
--   ever.
--
-- legacy_replacement_orders — the exchange orders the pre-ledger code created,
--   by Shopify order id, recorded independently of whether their funding was
--   reconciled. A replacement order is valued from replacement_lines or not at
--   all: an order named here with no funding REFUSES valuation
--   (db/replacementLines.ts); absence of funding never makes it ordinary.
--
-- legacy_replacement_census — one row per COMPLETE scan of every Shopify
--   order tagged `Change` (the tag the pre-S2 createOrder wrote), each found
--   order recorded above in the same transaction. Until a census exists, no
--   order can be shown NOT to be a replacement, so the portal refuses to value
--   any order as ordinary (cutover coverage).
--
-- replacement_funding_decisions — an operator's record (Santi, 30 Oct: A) of
--   ONE legacy exchange line's Stripe funding, read from a paid pre-S1
--   checkout session whose metadata names the source order. Pre-S1 sessions
--   carry no per-line split, so the amount is the operator's, bounded by the
--   session's total less what earlier decisions already took from it. Written
--   in the same statement as the replacement_lines row it funds
--   (scripts/fund-replacement-line.ts). One per replacement line, ever.
--
-- Additive: four new tables. Applied by hand; re-running it is harmless.
CREATE TABLE IF NOT EXISTS "reconciliation_effect_decisions" (
  "effect_id" text PRIMARY KEY,
  "verdict" text NOT NULL CHECK ("verdict" IN ('binds', 'excludes')),
  "productsorder_id" integer,
  "decided_by" text NOT NULL CHECK (length(trim("decided_by")) > 0),
  "evidence" text NOT NULL CHECK (length(trim("evidence")) > 0),
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "reconciliation_effect_decisions_binds_check"
    CHECK (("verdict" = 'binds') = ("productsorder_id" IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS "legacy_replacement_orders" (
  -- The Shopify order id, bare, as orders.id stores it.
  "order_id" text PRIMARY KEY,
  -- orders.id of the order whose exchange it fulfilled; NULL when the census
  -- found it but no single order of ours matches its `Order <number>` tag.
  "source_order_id" text,
  "found_by" text NOT NULL CHECK ("found_by" IN ('census', 'reconciliation', 'operator')),
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "legacy_replacement_census" (
  "id" serial PRIMARY KEY,
  "orders_found" integer NOT NULL CHECK ("orders_found" >= 0),
  "run_by" text NOT NULL CHECK (length(trim("run_by")) > 0),
  "completed_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "replacement_funding_decisions" (
  "id" serial PRIMARY KEY,
  -- The replacement (exchange) order, bare Shopify id, and the line it replaced.
  "order_id" text NOT NULL,
  "source_productsorder_id" integer NOT NULL,
  "stripe_session_id" text NOT NULL,
  -- The session's amount_total as Stripe answered it when the decision was made.
  "session_amount_cents" integer NOT NULL CHECK ("session_amount_cents" > 0),
  "funded_cents" integer NOT NULL CHECK ("funded_cents" > 0),
  "decided_by" text NOT NULL CHECK (length(trim("decided_by")) > 0),
  "evidence" text NOT NULL CHECK (length(trim("evidence")) > 0),
  "decided_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "replacement_funding_decisions_within_session"
    CHECK ("funded_cents" <= "session_amount_cents")
);
CREATE UNIQUE INDEX IF NOT EXISTS "replacement_funding_decisions_line_idx"
  ON "replacement_funding_decisions" ("order_id", "source_productsorder_id");
CREATE INDEX IF NOT EXISTS "replacement_funding_decisions_session_idx"
  ON "replacement_funding_decisions" ("stripe_session_id");
