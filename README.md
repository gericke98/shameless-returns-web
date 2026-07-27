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

2. Sync database schema:

   ```bash
   npx drizzle-kit push:pg
   ```

3. Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

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
   ```

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

The two `NEXT_PUBLIC_SHIPPING_*_COST` environment variables can be deleted
from Vercel's project settings, but **only after step 2 has run** — the
seed script is the last remaining reader of them.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.
