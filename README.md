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

Return/exchange shipping fees are per-country rows in the `shipping_fees`
table, edited by ops at `/dashboard/shipping-fees` — no deploy required. Each
row has a country code plus a return fee and an exchange fee, both in
integer cents. The `*` row is the fallback used for any country that does
not have its own row (see `feesForCountry` in `lib/fees.ts`); if the `*` row
is also missing, the fee resolves to zero rather than `NaN`.

The old `NEXT_PUBLIC_SHIPPING_RETURN_COST` and
`NEXT_PUBLIC_SHIPPING_EXCHANGE_COST` environment variables are **gone**.
Nothing under `app/`, `components/`, `lib/`, `actions/`, or `db/` reads them
anymore — the only remaining reference is `scripts/seed-shipping-fees.ts`,
and it only reads them once, to seed the table with the values that were
already in effect (see "Deploy prerequisites" below).

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
