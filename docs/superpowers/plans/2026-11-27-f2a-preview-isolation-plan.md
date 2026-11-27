# F2a — A preview can never act on production

Status: PLAN 2026-11-27 against `main` @ `76ee0a2`. Part of F2 (`2026-11-24-foundation-plan.md`), moved before F4 by
Santi 2026-11-27. Tier: code LIGHT (no production behaviour change), environment changes HEAVY-careful (each Vercel
env write listed and confirmed with Santi before it runs). Foundations rules 1–2 apply verbatim (see the foundation
plan): root cause, reuse official primitives (Neon–Vercel integration, Vercel env scopes, Stripe test mode, Postmark
sandbox server).

## Root weakness

The Preview environment holds the PRODUCTION value of every service key (DB, Shopify, Amphora, Correos, Postmark,
Stripe), so any preview — and F4's durable runs on a preview — acts on real orders and real customers. Some clients
also fail SILENTLY when a key is absent (`opsAlert.ts:38` returns; `lib/stripe.ts` crashes at import; Shopify URLs
become `undefined/admin/...`), so removing keys alone is not safe.

## Santi's decision (2026-11-27)

Preview gets its own Neon branch and **no production keys**: Stripe test keys, a Postmark sandbox server, and NO
Shopify / Amphora / Correos keys (calls refuse loudly). Real E2E runs on a Neon branch with keys passed by hand.

## Build

1. `lib/server/serviceEnv.ts` — the ONLY reader of service keys. `shopifyEnv()`, `amphoraEnv()`, `correosEnv()`,
   `postmarkEnv()`, `stripeEnv()`; each returns its config or throws `ServiceNotConfigured(service)`. Every client
   reads through it (inventory: `db/queries.ts`, `lib/settlement/shopify.ts`, `lib/fulfillmentLines.ts`,
   `lib/submissionCancellation.ts`, `lib/server/amphora.ts`, `lib/server/shipping.ts`, `lib/carrierLookup.ts`,
   7 Postmark callers, `lib/stripe.ts` (lazy client), `app/api/webhooks/stripe/route.ts`). A test fails on any
   `process.env.<service key>` outside the module (scripts excluded: they run locally with explicit env).
2. No silent skips: `opsAlert` without Postmark returns a typed failure, so the outbox keeps the alert pending
   instead of dropping it.
3. Shopify admin token becomes server-only: `SHOPIFY_ADMIN_TOKEN` / `SHOPIFY_SHOP_URL` (the `NEXT_PUBLIC_` names are
   inlined into any client bundle that references them). Rollout: add the new names → deploy → remove the old.
4. Dead variables removed everywhere: `NEXT_PUBLIC_API_KEY`, `NEXT_PUBLIC_SECRET_KEY`, `GMAIL_*`, `REFRESH_TOKEN`
   (no reader in the repo; only the local `.env`).

## Environment (in this order, each confirmed with Santi)

a. Santi: Neon–Vercel integration on project `dry-firefly-81844312`, "create a branch per preview", injecting
   `DATABASE_URL` for Preview only. b. Santi: Stripe test secret + test webhook secret; Postmark sandbox server token →
   added to Preview. c. Claude: remove the Preview scope of the production `DATABASE_URL`, Shopify, Amphora, Correos,
   Postmark, Stripe values (listed one by one before running). d. New Shopify names (step 3) added to Production and
   Development.

## Check (done = all true)

- `vercel env pull --environment=preview` → `DATABASE_URL` host ≠ production host, and none of the production
  Shopify/Amphora/Correos/Postmark/Stripe values present (compared by hash, never printed).
- A preview deploy: lookup refuses with "Shopify not configured in this environment"; no request reaches Shopify,
  Amphora or Correos (logs).
- Production unchanged: suite green, deploy, one portal lookup + the 15-min crons healthy.
- One Codex code review of the diff.
