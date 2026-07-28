# Shameless Returns

A Next.js application for managing product returns and exchanges in an e-commerce environment.

## Features

- Product return management
- Exchange processing
- Stock tracking
- Order management
- Real-time inventory updates

## Tech Stack

- Next.js 14
- TypeScript
- Tailwind CSS
- Drizzle ORM
- PostgreSQL

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/gericke98/shameless-returns-web.git
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up your environment variables:
   Create a `.env` file in the root directory with the following variables:
   ```
   DATABASE_URL=your_database_url
   ```

## Getting Started

1. Run the development server:

   ```bash
   npm run dev
   ```

2. Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

Schema changes are applied by hand, not with `drizzle-kit push:pg` — see the
migration section below for why and for the statements applied so far.

## Development

- The application uses Next.js App Router
- Components are built with TypeScript and Tailwind CSS
- Database operations are handled through Drizzle ORM
- Real-time updates are managed through server actions

## Shipping fees and language switcher

### Shipping fees

Return/exchange shipping fees are rows in the `shipping_fees` table, one per
(destination country, weight band), edited by ops at
`/dashboard/shipping-fees` — no deploy required. Each row has a country code,
a `max_grams` upper bound, and a return and exchange fee in integer cents. The
`*` rows are the fallback for any country without its own (see
`feesForCountry` in `lib/fees.ts`); if `*` is missing too, the fee resolves to
zero rather than `NaN`.

Fees come from the carrier tariff committed at `data/return-tariff.csv` and
are applied with `scripts/seed-shipping-fees-by-country.ts`. The CSV is the
source of truth in the repo, so a price change is a reviewable diff and the
values behind any past charge are recoverable from git history. It carries the
carrier's own cost alongside each fee, which is what makes the margin on a row
auditable.

**The fee is the carrier's cost rounded up to the whole euro.** No tiers, no
subsidy, no anchor — which is what keeps it honest under the two orderings
that matter: a heavier parcel is never cheaper than a lighter one, and a
costlier destination is never cheaper than a cheaper one. Both are asserted in
`tests/shippingFeeCoverage.test.ts`. An earlier scheme banded the ≤1 kg fee
into four tiers and added the carrier's increment on top; the flattening let a
costlier destination come out cheaper, which is a class of bug this rule does
not have. Exchanges keep the historical €1.00 discount and so sit just below
cost by design.

`country_code` is really a **zone** key, not strictly an ISO-2 country. For
almost every destination the two coincide; Spain is the exception, because it
is one country and several carrier zones:

| Zone | Postal prefixes | ≤1 kg |
|---|---|---:|
| `ES` | everything else | €5 |
| `ES-IB` | 07 | €9 |
| `ES-CN` | 35, 38 | €22 |
| `ES-CM` | 51, 52 | €45 |

`resolveZone` (`lib/zones.ts`) maps a delivery address to one of these; every
fee lookup goes through it. Two digits is all the tariff can distinguish — 07
covers Mallorca as well as the minor Balearics, and both Canarian provinces
hold a major island and minor ones — so where a prefix spans two tariff rows
the CSV carries the dearer one, keeping every row at or above cost. A Spanish
address with an unparseable postcode resolves to peninsular.

**Known gap:** `shipping_zip` is customer-editable through `updateData`, so a
Tenerife customer can enter a Madrid postcode and pay €5 rather than €22. It
is the same shape as the hole deliberately closed for `shippingCountry`, but
the postcode has to stay editable because it is also where the label is sent.
Closing it properly needs a separate immutable column holding the postcode as
it was at purchase. Current exposure is 12 of 489 Spanish orders.

The `*` fallback is derived as the most expensive fee at each band rather than
chosen, so it cannot go stale when the carrier republishes. It is deliberately
the worst case: an unpriced market should announce itself, not bleed quietly.
The cost of that is Andorra, which is road-adjacent to Spain and would
realistically be cheap, but appears in neither tariff tab and so inherits
Israel's prices. It has never received an order.

Weight matters because the carrier prices by it, steeply — a 2.5 kg return
from the US costs €86.97 against €21.53 for the same parcel under a kilo.
`max_grams` is the band's **inclusive** upper bound, bands are contiguous from
zero, and the heaviest carries `UNBOUNDED_MAX_GRAMS` so no parcel can fall
through unpriced. `tests/shippingFeeCoverage.test.ts` fails the build if a
destination is missing, has no unbounded band, or gets cheaper as it gets
heavier.

The parcel's weight is summed by `parcelGrams` (`lib/basket.ts`) from the
catalogue weight of the items the customer selected — the originals they ship
back, not an exchange replacement, which travels separately. Weights come from
the current variant via `inventoryItem.measurement.weight`, never from
`line_items[].grams`: Shopify freezes that onto the line at purchase time, so
it still reports whatever the catalogue said when the order was placed. A
variant that has since been deleted falls back to `FALLBACK_ITEM_GRAMS` rather
than zero — zero would make an unknown item *reduce* the fee.

The old `NEXT_PUBLIC_SHIPPING_RETURN_COST` and
`NEXT_PUBLIC_SHIPPING_EXCHANGE_COST` environment variables are **gone**.
Nothing under `app/`, `components/`, `lib/`, `actions/`, or `db/` reads them
anymore — the only remaining reference is `scripts/seed-shipping-fees.ts`,
which is superseded and already refuses to run because those variables no
longer exist in any environment. Do not resurrect it: it writes a single
unbounded band per country at one flat price, which would erase both the
per-country and the per-weight rows.

### Applying the weight-band migration

`shipping_fees` gained `max_grams` and its primary key moved from
`country_code` to `(country_code, max_grams)`. Apply this before deploying:

```sql
-- Existing rows become the unbounded top band, so prices do not change until
-- the narrower bands are seeded.
ALTER TABLE shipping_fees
  ADD COLUMN max_grams integer NOT NULL DEFAULT 2147483647;

ALTER TABLE shipping_fees DROP CONSTRAINT shipping_fees_pkey;
ALTER TABLE shipping_fees ADD PRIMARY KEY (country_code, max_grams);

-- Every future row must state its band explicitly.
ALTER TABLE shipping_fees ALTER COLUMN max_grams DROP DEFAULT;
```

Then seed: `npx tsx scripts/seed-shipping-fees-by-country.ts --dry-run` to
review, then without the flag to write.

**Order matters.** Reads stay compatible across the migration — the old code
does `SELECT *` and ignores the extra column — but the currently deployed
`saveShippingFee` upserts with `target: country_code`, which stops matching
the primary key the moment it changes. Between running the SQL and deploying,
the ops dashboard's Save button will fail. Migrate and deploy together, or
accept that window.

The Stripe charge is derived server-side from this table (see
`actions/payments.ts`), so the browser can no longer influence the amount
charged.

Money is stored as integer cents everywhere. `centsToEuros` (`lib/fees.ts`)
and `formatEuros` (`lib/i18n/index.ts`) are the two helpers a cents value
should go through to become a euro amount for display. There is one further
conversion, `toEuros` in `app/dashboard/shipping-fees/FeesTable.tsx`, which
formats the fee inputs in the internal admin table. Do not add any more ad hoc
`/ 100` or `.toFixed(2)` conversions.

### Language switcher (ES/EN)

The customer portal and its transactional emails are available in Spanish
and English. The active locale is stored in a cookie
(`LOCALE_COOKIE` / `lib/i18n/index.ts`) and, server-side, `returnFunction`
(`actions/return.ts`) writes it to `orders.locale` at return time so the
transactional email can later be sent in the customer's language even from
a context with no cookies (e.g. the Stripe webhook).

To add a language:

1. Add the new locale code to `LOCALES` in `lib/i18n/index.ts` (and to the
   `Locale` union type).
2. Add a dictionary file for it under `lib/i18n/` and register it in
   `dictionaries`.
3. Because `en.ts` is typed against the shape of `es.ts` (`Dictionary`), a
   dictionary that is missing a key is a **build error** (TypeScript), not
   something that silently renders `undefined` at runtime.

## Portal session (`/[id]`)

The returns portal has no accounts. Ownership is proven once, at lookup, by
order number **plus** the matching contact email — and `actions/order.ts`
`getOrder` now records that proof as a signed cookie (`return_session`) instead
of discarding it.

- **Signed with `NEXTAUTH_SECRET`.** No new env var, no table, no migration.
- **Two hours, absolute** from issue — not sliding. Long enough for a return
  including a detour to Stripe and back; short enough to bound exposure on a
  shared browser.
- **One order per session.** Looking up a second order replaces the first.
- Verified by `app/[id]/page.tsx` and by every customer-facing action. Absent,
  expired, and issued-for-another-order are treated identically, so the response
  never reveals whether an order id names a real order.

Why it exists: `orders.id` is the raw Shopify order id — sequential and
enumerable — and `/[id]` renders the customer's name, street address and phone.
Before this, possession of a guessable URL was the only credential.

Crypto lives in `lib/orderSession.ts` (pure, unit-tested) and the cookie layer in
`lib/orderAccess.ts`. Design: `docs/superpowers/specs/2026-07-27-portal-session-design.md`.

### Lookup rate limiting

The lookup is now the only door, so it is rate limited: **10 failed attempts per
IP per 15 minutes**, after which that IP is refused for the rest of the window.

- **Only failures count** — a wrong order number, or a real order number with a
  non-matching email. A successful lookup records nothing, so a customer who
  finds their order is never penalised.
- **It fails open.** If the counter cannot be read, the lookup proceeds and the
  error is logged. This is defence in depth on top of the email match; a database
  blip must never lock every customer out of returns.
- Attempts live in `lookup_attempts`, pruned opportunistically on each write, so
  the table stays bounded with no cron job.
- Caller identity prefers `x-real-ip` and `x-vercel-forwarded-for` (platform-set,
  unforgeable) over `x-forwarded-for` (client-prependable, leftmost entry only).
  An unattributable caller is allowed through rather than bucketed together.

Policy lives in `lib/rateLimit.ts` (pure, unit-tested); the counting in
`db/lookupAttempts.ts`.

**Requires a migration** — see Deploy prerequisites below.

### Four functions are deliberately NOT session-gated

**Do not "fix" this.** `updateFinalOrder`, `createShippingLabel`,
`createInternationalReturn` and `createSendcloudReturn` are each reached from two
callers: `returnFunction` (a customer, who has a session) and the Stripe webhook,
which is an inbound request from Stripe with **no cookies**, authenticated by
signature verification instead.

Adding a session check to any of them breaks every **paid** return: the payment
succeeds and the return is never created. Each carries a comment saying so.

The gate belongs on the customer entry points, which is where it is.

### Admin actions are separate

`middleware.ts` guards the `/dashboard` **routes**, but a server action is not a
route — it is an independently addressable endpoint, so rendering a button inside
`/dashboard` protects the button and not the endpoint. Admin actions call
`isAdmin()` from `lib/requireAdmin.ts`. **Any new admin action must too.**

## Deploy prerequisites for this branch

This branch requires a database migration and a one-time data seed before
it can go live. Do these **in this exact order**:

1. **Run the migration.** Apply exactly these two statements against the
   production database (`psql "$DATABASE_URL" -f ...`, or the Neon SQL
   editor). They are the complete schema delta for this branch:

   ```sql
   CREATE TABLE shipping_fees (
     country_code       text    PRIMARY KEY,
     return_fee_cents   integer NOT NULL,
     exchange_fee_cents integer NOT NULL,
     updated_at         timestamp NOT NULL DEFAULT now()
   );

   ALTER TABLE orders ADD COLUMN locale text;

   CREATE TABLE lookup_attempts (
     id           serial    PRIMARY KEY,
     ip           text      NOT NULL,
     attempted_at timestamp NOT NULL DEFAULT now()
   );

   CREATE INDEX lookup_attempts_ip_attempted_at_idx
     ON lookup_attempts (ip, attempted_at);
   ```

   `lookup_attempts` backs the lookup rate limit. Unlike `shipping_fees` it needs
   no seed — an empty table simply means nobody has failed a lookup yet, and the
   limit reads zero. It is safe to create before or after deploying.

   `locale` is intentionally nullable: every read site goes through
   `readLocale`, which falls back to `"es"`, so existing rows need no
   backfill.

   **Do not use `npx drizzle-kit push:pg` for this.** There is no `drizzle/`
   directory and no committed migration history, so `push` has nothing to
   diff against except whatever production happens to be right now. Any
   pre-existing drift between `db/schema.ts` and the live database surfaces
   as a proposed `DROP` — on a live `orders` table. If you run it anyway,
   read every statement it proposes before confirming, and abort if it
   proposes anything beyond the two above.

2. **Seed the fee table**, with `DATABASE_URL`,
   `NEXT_PUBLIC_SHIPPING_RETURN_COST`, and
   `NEXT_PUBLIC_SHIPPING_EXCHANGE_COST` all still set in the environment:

   ```bash
   npx tsx scripts/seed-shipping-fees.ts
   ```

   This writes the `*` and `ES` rows from the values the app is already
   charging, so the table starts at today's prices and no price moves as a
   side effect of this migration.

3. **Only then deploy** the new application code.

**Why the order matters:** between step 1 and step 2, `shipping_fees`
exists but is empty. In that window, `getFeeTable()` (`db/fees.ts`) returns
`{}`, and `feesForCountry` (`lib/fees.ts`) falls through to its zero
default because there is no `*` row yet. If the new code were live during
that gap, every return and exchange would be charged a shipping fee of
zero. Running the seed before deploying closes that gap entirely — the
table is never empty while the new code can read it.

**Status: this migration has been applied to production.** Steps 1–3 are
recorded here as history — the schema, the seed, and the deploy are all done.
`NEXT_PUBLIC_SHIPPING_RETURN_COST` and `NEXT_PUBLIC_SHIPPING_EXCHANGE_COST`
have since been removed from Vercel, so `scripts/seed-shipping-fees.ts` will
now refuse to run rather than seed anything. That is deliberate: fees live in
`shipping_fees` and are edited at `/dashboard/shipping-fees`. To re-seed a
fresh database, set those two variables in your shell for the one command.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.
