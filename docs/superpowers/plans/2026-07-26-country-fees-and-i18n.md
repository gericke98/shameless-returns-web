# Country-Based Shipping Fees & ES/EN Language Switcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price return/exchange fees per destination country from a dashboard-editable table, resolve the Stripe amount server-side, and let customers switch the portal and their confirmation email between Spanish and English.

**Architecture:** A single canonical country module replaces three competing country interpretations. A `shipping_fees` table (one row per ISO-2, plus a `*` default) is read through a tagged cache and applied by one pure resolver that both the client (for display) and the server (for the actual charge) call. Language is a cookie-driven React context over hand-rolled typed dictionaries, with `en` typed as `typeof es` so a missing key fails the build.

**Tech Stack:** Next.js 14.2.4 App Router, React 18, Drizzle ORM 0.30.9 + drizzle-kit 0.20.17 (`push:pg`) against Neon, Stripe, Tailwind, TypeScript 5. Vitest added in Task 1 for pure-function tests only.

## Global Constraints

- **Spain's prices must not move.** Every migration seeds from the current `NEXT_PUBLIC_SHIPPING_RETURN_COST` / `NEXT_PUBLIC_SHIPPING_EXCHANGE_COST` values so deploying changes no price.
- **Money is stored as integer cents.** Never store or sum currency as a float. Display converts at the render edge only.
- **Fee rule is Rule A (by net amount)**, with one addition: an empty basket resolves to `0`, not the exchange fee.
- **`db/queries.ts` has `"use server"` at the top** — every export in it must be an async function. Sync helpers and non-action DB reads go in new modules.
- **Do not change return routing.** `actions/return.ts` `createReturnShipment`, the Stripe webhook router, and the Correos/Amphora/Sendcloud flag logic stay as they are.
- **Do not translate** `/dashboard` or `/login`.
- **Persisted values must never be translated.** Anything written to the DB or compared as a string (`ACTIONS`, `REASONS`, `action`, `reason`) keeps a stable Spanish-or-code value; only labels are localized.
- Commit after every task. Conventional-commit prefixes, matching existing history (`feat:`, `fix:`, `chore:`, `docs:`).

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `lib/countries.ts` | The only place that answers "what country is this string". Supported list + `normalizeCountry`. Pure, no imports from `db/`. |
| `lib/fees.ts` | The only place that answers "what fee applies". Pure — takes a fee table, returns cents. Safe to import from client components. |
| `lib/basket.ts` | Pure basket valuation. Mirrors the discount math currently inline in `app/[id]/page.tsx` so client and server agree on the net amount. No `db/` imports, so it is unit-testable. |
| `lib/loadBasket.ts` | Server-only wrapper: loads the order and its catalogue, then delegates to `lib/basket.ts`. Kept separate so importing the math does not drag in Neon and the Shopify adapter. |
| `db/fees.ts` | Reads `shipping_fees` into a `FeeTable`, wrapped in `unstable_cache` tagged `shipping-fees`. No `"use server"`. |
| `actions/shippingFees.ts` | Admin server action: validate + upsert a fee row, revalidate the tag. |
| `app/[id]/feesContext.tsx` | Client context carrying the order country's fee pair, so the 7 client call sites stop reading `process.env`. |
| `app/dashboard/shipping-fees/page.tsx` | Admin fee editor. |
| `app/dashboard/shipping-fees/FeesTable.tsx` | Client table for the editor. |
| `lib/i18n/es.ts` | Spanish dictionary — the canonical shape. |
| `lib/i18n/en.ts` | English dictionary, typed `typeof es`. |
| `lib/i18n/index.ts` | `Locale`, `dictionaries`, `formatEuros`. |
| `lib/i18n/context.tsx` | `LocaleProvider` + `useT()`. |
| `actions/locale.ts` | Server action: write the `locale` cookie and persist `orders.locale`. |
| `components/LanguageSwitcher.tsx` | The dropdown. |
| `tests/countries.test.ts`, `tests/fees.test.ts` | Vitest unit tests. |
| `vitest.config.ts` | Vitest config with the `@/` alias. |
| `scripts/seed-shipping-fees.ts` | One-shot seed from the current env values. |

**Modified**

| Path | Change |
|---|---|
| `db/schema.ts` | Add `shippingFees` table; add `locale` column to `orders`. |
| `actions/sendcloudReturn.ts:44-65` | `COUNTRY_NAME_TO_ISO2` removed; import from `lib/countries.ts`. |
| `actions/amphoraReturn.ts:20-25` | `isInternationalOrder` delegates to `normalizeCountry`. |
| `actions/updateOrder.ts:86, 114-137, 186` | Compare against a stable action key; validate country; pass the fee to `createReturn`. |
| `actions/payments.ts:10-42` | `createStripeUrl` takes an order id and derives the amount itself. |
| `actions/return.ts:40-75` | `returnFunction` stops taking `totalPrice`. |
| `actions/refund.ts:30-32` | Use the resolved return fee. |
| `db/queries.ts:462-466` | `createReturn` takes the fee as a parameter. |
| `app/[id]/page.tsx` | Resolve the fee pair and the locale; wrap in providers; use `lib/basket.ts` for the discount math. |
| `app/[id]/clientOrder.tsx:62-66` | Use `useFees()`. |
| `app/[id]/windows/secondWindow.tsx:65-68, 123` | Use `useFees()`; format via `formatEuros`. |
| `app/[id]/components/secondWindowForm.tsx:56-59, 121-126` | Use `useFees()`; `País` becomes a `FormSelect`. |
| `app/[id]/windows/thirdWindow.tsx:191-194` | Use `useFees()`. |
| `app/[id]/windows/lastWindow.tsx:65-70` | Use `useFees()` — **switches from Rule B to Rule A**. |
| `app/[id]/windows/orderWindowContent.tsx:37-40` | Use `useFees()`. |
| `app/[id]/components/summary/summary.tsx:86-91` | Use `useFees()` — **switches from Rule B to Rule A**. |
| `app/[id]/components/buttons/asyncButton.tsx` | Drop the `totalPrice` prop. |
| `app/[id]/windows/header.tsx` | Add the language switcher. |
| `placeholder.ts:1-17` | `ACTIONS`/`REASONS` gain stable keys. |
| `actions/shipping.ts:154-219` | Single-language email. |
| `package.json` | Add `vitest`, `test` script. |

---

## PHASE 1 — Country foundation

*Gate: existing Spain and Amphora international flows behave identically; no price changes.*

### Task 1: Vitest + canonical country module

**Files:**
- Create: `vitest.config.ts`, `lib/countries.ts`, `tests/countries.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Iso2 = string` (branded only by convention — a 2-char uppercase code)
  - `SUPPORTED_COUNTRIES: readonly { code: string; nameEs: string; nameEn: string }[]`
  - `normalizeCountry(input: string | null | undefined): string | null`
  - `EU_ISO2: Set<string>`

- [ ] **Step 1: Install vitest**

```bash
npm install --save-dev vitest@^2 vite-tsconfig-paths@^5
```

- [ ] **Step 2: Add the test script to `package.json`**

In the `"scripts"` block, after `"lint": "next lint",`, add:

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write the failing test**

Create `tests/countries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EU_ISO2, SUPPORTED_COUNTRIES, normalizeCountry } from "@/lib/countries";

describe("normalizeCountry", () => {
  it("accepts an ISO-2 code in any case", () => {
    expect(normalizeCountry("ES")).toBe("ES");
    expect(normalizeCountry("es")).toBe("ES");
    expect(normalizeCountry(" fr ")).toBe("FR");
  });

  it("accepts the English display name Shopify sends", () => {
    expect(normalizeCountry("Spain")).toBe("ES");
    expect(normalizeCountry("France")).toBe("FR");
    expect(normalizeCountry("Czech Republic")).toBe("CZ");
  });

  it("accepts the Spanish display name", () => {
    expect(normalizeCountry("España")).toBe("ES");
    expect(normalizeCountry("Espana")).toBe("ES");
    expect(normalizeCountry("Francia")).toBe("FR");
  });

  it("returns null for empty or unknown input", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry("   ")).toBeNull();
    expect(normalizeCountry("Atlantis")).toBeNull();
    expect(normalizeCountry("ZZ")).toBeNull();
  });

  it("every supported country round-trips through its own names", () => {
    for (const c of SUPPORTED_COUNTRIES) {
      expect(normalizeCountry(c.code)).toBe(c.code);
      expect(normalizeCountry(c.nameEn)).toBe(c.code);
      expect(normalizeCountry(c.nameEs)).toBe(c.code);
    }
  });

  it("keeps the EU set free of Spain", () => {
    expect(EU_ISO2.has("ES")).toBe(false);
    expect(EU_ISO2.has("FR")).toBe(true);
    expect(EU_ISO2.has("GB")).toBe(false);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "@/lib/countries"`.

- [ ] **Step 6: Create `lib/countries.ts`**

```ts
// The single source of truth for "what country is this string".
//
// Three interpretations previously coexisted: COUNTRY_NAME_TO_ISO2 in
// sendcloudReturn.ts, an inline lowercase compare in isInternationalOrder,
// and a "spain" | "españa" check in actions/order.ts. They are all replaced
// by normalizeCountry().
//
// Pure module — must not import from db/ or any server-only code, because
// client components import it for the country dropdown.

export type Country = {
  /** ISO 3166-1 alpha-2, uppercase. */
  code: string;
  nameEs: string;
  nameEn: string;
};

export const SUPPORTED_COUNTRIES: readonly Country[] = [
  { code: "ES", nameEs: "España", nameEn: "Spain" },
  { code: "AT", nameEs: "Austria", nameEn: "Austria" },
  { code: "BE", nameEs: "Bélgica", nameEn: "Belgium" },
  { code: "BG", nameEs: "Bulgaria", nameEn: "Bulgaria" },
  { code: "HR", nameEs: "Croacia", nameEn: "Croatia" },
  { code: "CY", nameEs: "Chipre", nameEn: "Cyprus" },
  { code: "CZ", nameEs: "República Checa", nameEn: "Czech Republic" },
  { code: "DK", nameEs: "Dinamarca", nameEn: "Denmark" },
  { code: "EE", nameEs: "Estonia", nameEn: "Estonia" },
  { code: "FI", nameEs: "Finlandia", nameEn: "Finland" },
  { code: "FR", nameEs: "Francia", nameEn: "France" },
  { code: "DE", nameEs: "Alemania", nameEn: "Germany" },
  { code: "GR", nameEs: "Grecia", nameEn: "Greece" },
  { code: "HU", nameEs: "Hungría", nameEn: "Hungary" },
  { code: "IE", nameEs: "Irlanda", nameEn: "Ireland" },
  { code: "IT", nameEs: "Italia", nameEn: "Italy" },
  { code: "LV", nameEs: "Letonia", nameEn: "Latvia" },
  { code: "LT", nameEs: "Lituania", nameEn: "Lithuania" },
  { code: "LU", nameEs: "Luxemburgo", nameEn: "Luxembourg" },
  { code: "MT", nameEs: "Malta", nameEn: "Malta" },
  { code: "NL", nameEs: "Países Bajos", nameEn: "Netherlands" },
  { code: "PL", nameEs: "Polonia", nameEn: "Poland" },
  { code: "PT", nameEs: "Portugal", nameEn: "Portugal" },
  { code: "RO", nameEs: "Rumanía", nameEn: "Romania" },
  { code: "SK", nameEs: "Eslovaquia", nameEn: "Slovakia" },
  { code: "SI", nameEs: "Eslovenia", nameEn: "Slovenia" },
  { code: "SE", nameEs: "Suecia", nameEn: "Sweden" },
  { code: "GB", nameEs: "Reino Unido", nameEn: "United Kingdom" },
  { code: "CH", nameEs: "Suiza", nameEn: "Switzerland" },
  { code: "NO", nameEs: "Noruega", nameEn: "Norway" },
  { code: "US", nameEs: "Estados Unidos", nameEn: "United States" },
  { code: "CA", nameEs: "Canadá", nameEn: "Canada" },
  { code: "MX", nameEs: "México", nameEn: "Mexico" },
  { code: "AU", nameEs: "Australia", nameEn: "Australia" },
] as const;

/** EU member states, excluding Spain (national/Correos). Used by the
 *  Sendcloud EU-only lane check. */
export const EU_ISO2: Set<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "SE",
]);

const VALID_CODES = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));

/** Lowercased display name (ES and EN) -> ISO-2. Includes unaccented
 *  variants because historical rows contain "Espana". */
const NAME_TO_ISO2: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const strip = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const c of SUPPORTED_COUNTRIES) {
    map[c.nameEn.toLowerCase()] = c.code;
    map[c.nameEs.toLowerCase()] = c.code;
    map[strip(c.nameEn)] = c.code;
    map[strip(c.nameEs)] = c.code;
  }
  // Aliases seen in historical Shopify data.
  map["czechia"] = "CZ";
  map["esp"] = "ES";
  map["holland"] = "NL";
  map["uk"] = "GB";
  map["great britain"] = "GB";
  map["usa"] = "US";
  map["united states of america"] = "US";
  return map;
})();

/**
 * Resolve any stored or user-supplied country string to a supported ISO-2
 * code, or null if it is empty or unrecognised. Callers decide what null
 * means: the fee resolver falls back to the "*" default row; the shipment
 * router treats it as international.
 */
export function normalizeCountry(
  input: string | null | undefined
): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (raw.length === 2) {
    const upper = raw.toUpperCase();
    return VALID_CODES.has(upper) ? upper : null;
  }

  const stripped = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return NAME_TO_ISO2[raw.toLowerCase()] ?? NAME_TO_ISO2[stripped] ?? null;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 6 tests in `tests/countries.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts lib/countries.ts tests/countries.test.ts
git commit -m "feat: add canonical country module with vitest coverage"
```

---

### Task 2: Route the three existing country checks through `normalizeCountry`

**Files:**
- Modify: `actions/sendcloudReturn.ts:36-65`, `actions/amphoraReturn.ts:18-25`, `actions/order.ts:96-98`

**Interfaces:**
- Consumes: `normalizeCountry`, `EU_ISO2` from `lib/countries.ts`.
- Produces: no signature changes. `euIso2ForReturn` and `isInternationalOrder` keep their exact current signatures and semantics.

- [ ] **Step 1: Replace the country map in `actions/sendcloudReturn.ts`**

Delete lines 36-51 (the `EU_ISO2` set and the `COUNTRY_NAME_TO_ISO2` record) and replace `euIso2ForReturn` (lines 53-65) with:

```ts
/**
 * Returns the ISO-2 code if the order is an in-scope EU return (EU member,
 * not Spain); otherwise null. Non-EU and Spain both fall through to their
 * existing flows.
 */
export function euIso2ForReturn(shippingCountry: string | null | undefined): string | null {
  const iso = normalizeCountry(shippingCountry);
  if (!iso || iso === "ES") return null; // Spain stays national
  return EU_ISO2.has(iso) ? iso : null; // only EU lanes handled here
}
```

Add to the imports at the top of the file:

```ts
import { EU_ISO2, normalizeCountry } from "@/lib/countries";
```

- [ ] **Step 2: Replace `isInternationalOrder` in `actions/amphoraReturn.ts:20-25`**

```ts
/** Spain (incl. Canarias/Ceuta/Melilla) stays on the Correos flow; everything
 *  else is routed to Amphora. Accepts the stored country name or an ISO code.
 *  An unrecognised country is treated as international, matching the previous
 *  behaviour (anything not in the Spain list was international). */
export function isInternationalOrder(shippingCountry: string | null | undefined): boolean {
  const raw = String(shippingCountry ?? "").trim();
  if (!raw) return false;
  return normalizeCountry(raw) !== "ES";
}
```

Add to the imports:

```ts
import { normalizeCountry } from "@/lib/countries";
```

- [ ] **Step 3: Replace the Spain check in `actions/order.ts:96-98`**

```ts
  const rawCountry = order.shipping_address.country;
  const isSpain = normalizeCountry(rawCountry) === "ES";
```

Add to the imports:

```ts
import { normalizeCountry } from "@/lib/countries";
```

Leave lines 99-111 (the Amphora and Sendcloud gate logic) exactly as they are.

- [ ] **Step 4: Add regression tests for the two exported helpers**

Append to `tests/countries.test.ts`:

```ts
describe("country helpers keep their previous semantics", () => {
  it("treats Spain in every stored spelling as national", async () => {
    const { isInternationalOrder } = await import("@/actions/amphoraReturn");
    for (const spelling of ["Spain", "España", "Espana", "ES", "es", "esp"]) {
      expect(isInternationalOrder(spelling)).toBe(false);
    }
  });

  it("treats empty as not international, matching the old guard", async () => {
    const { isInternationalOrder } = await import("@/actions/amphoraReturn");
    expect(isInternationalOrder("")).toBe(false);
    expect(isInternationalOrder(null)).toBe(false);
  });

  it("keeps Spain and non-EU out of the Sendcloud EU lane", async () => {
    const { euIso2ForReturn } = await import("@/actions/sendcloudReturn");
    expect(euIso2ForReturn("Spain")).toBeNull();
    expect(euIso2ForReturn("United Kingdom")).toBeNull();
    expect(euIso2ForReturn("France")).toBe("FR");
    expect(euIso2ForReturn("Portugal")).toBe("PT");
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS. If `@/actions/amphoraReturn` fails to import because of the Neon client, set `DATABASE_URL=postgres://test` in the shell for the run — the module only constructs the client lazily at import, and no query executes.

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: compiles with no type errors.

- [ ] **Step 7: Commit**

```bash
git add actions/sendcloudReturn.ts actions/amphoraReturn.ts actions/order.ts tests/countries.test.ts
git commit -m "refactor: route all country checks through normalizeCountry"
```

---

### Task 3: `País` becomes a validated dropdown

**Files:**
- Modify: `app/[id]/components/secondWindowForm.tsx:121-126`, `actions/updateOrder.ts:114-137`

**Interfaces:**
- Consumes: `SUPPORTED_COUNTRIES`, `normalizeCountry` from `lib/countries.ts`; the existing `FormSelect` from `components/formSelect.tsx`.
- Produces: `orders.shippingCountry` now always holds an ISO-2 code for any order that passes through this form.

- [ ] **Step 1: Swap the input for a select in `secondWindowForm.tsx`**

Replace lines 121-126:

```tsx
      <FormSelect
        name="country"
        title="País"
        options={SUPPORTED_COUNTRIES.map((c) => ({
          value: c.code,
          label: c.nameEs,
        }))}
        valueini={normalizeCountry(order.shippingCountry) ?? "ES"}
        required
      />
```

Add to the imports at the top of the file:

```tsx
import { FormSelect } from "@/components/formSelect";
import { SUPPORTED_COUNTRIES, normalizeCountry } from "@/lib/countries";
```

- [ ] **Step 2: Validate the country in `actions/updateOrder.ts`**

Replace `updateData` (lines 114-137) with:

```ts
export async function updateData(prevState: number, formData: FormData) {
  const data = parseFormData(formData);

  if (!data.orderId || !data.name || !data.address) {
    return prevState;
  }

  // The country drives which carrier is used and which fee is charged, so it
  // must be a supported ISO-2 code. The form is a <select> over
  // SUPPORTED_COUNTRIES, so an unrecognised value means a tampered request —
  // reject rather than writing arbitrary text.
  const country = normalizeCountry(data.country);
  if (!country) {
    return prevState;
  }

  await db
    .update(orders)
    .set({
      shippingName: data.name,
      shippingAddress1: data.address,
      shippingAddress2: data.address2,
      shippingZip: data.zip,
      shippingCity: data.city,
      shippingProvince: data.province,
      shippingCountry: country,
      shippingPhone: data.phone,
    })
    .where(eq(orders.id, data.orderId));

  revalidatePath("/", "layout");
  return prevState + 1;
}
```

Add to the imports:

```ts
import { normalizeCountry } from "@/lib/countries";
```

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 4: Manual verification**

Run `npm run dev`, look up a real Spanish order, advance to the address step. Confirm: the `País` field is a dropdown pre-selected to **España**; submitting advances to the next step; the `orders` row now shows `shipping_country = 'ES'`.

- [ ] **Step 5: Commit**

```bash
git add app/\[id\]/components/secondWindowForm.tsx actions/updateOrder.ts
git commit -m "feat: validated country dropdown on the returns address form"
```

---

## PHASE 2 — Fee resolution

*Gate: `resolveFee` tests green; a real Spanish checkout charges exactly what it charges today; the summary and the Stripe amount agree on a cheaper-exchange basket.*

### Task 4: Fee table schema and seed

**Files:**
- Modify: `db/schema.ts:1-23`
- Create: `scripts/seed-shipping-fees.ts`

**Interfaces:**
- Produces:
  - `shippingFees` Drizzle table with columns `countryCode` (PK, text), `returnFeeCents` (int), `exchangeFeeCents` (int), `updatedAt` (timestamp).

- [ ] **Step 1: Add the table to `db/schema.ts`**

Change the import on line 2 to include `timestamp`:

```ts
import { integer, text, pgTable, serial, boolean, timestamp } from "drizzle-orm/pg-core";
```

Append at the end of the file, before the trailing `// CODE TO UPDATE...` comment:

```ts
/**
 * Return/exchange shipping fee per destination country.
 *
 * One row per ISO-2 country, plus a single row with country_code = '*' that
 * every unlisted or unrecognised country falls back to. Amounts are integer
 * cents — never floats, which is how you end up charging 4.199999999.
 */
export const shippingFees = pgTable("shipping_fees", {
  countryCode: text("country_code").primaryKey(),
  returnFeeCents: integer("return_fee_cents").notNull(),
  exchangeFeeCents: integer("exchange_fee_cents").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

- [ ] **Step 2: Push the schema**

Run: `npx drizzle-kit push:pg`
Expected: creates `shipping_fees`. Accept the prompt to create the table.

- [ ] **Step 3: Write the seed script**

Create `scripts/seed-shipping-fees.ts`:

```ts
// One-shot seed. Writes the '*' default and the 'ES' row from the values the
// app currently uses, so introducing the table changes no prices. Safe to
// re-run: it upserts.
//
// Run with: npx tsx scripts/seed-shipping-fees.ts
import "dotenv/config";
import db from "../db/drizzle";
import { shippingFees } from "../db/schema";

async function main() {
  const returnEuros = Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST);
  const exchangeEuros = Number(process.env.NEXT_PUBLIC_SHIPPING_EXCHANGE_COST);

  if (!Number.isFinite(returnEuros) || !Number.isFinite(exchangeEuros)) {
    throw new Error(
      "NEXT_PUBLIC_SHIPPING_RETURN_COST / NEXT_PUBLIC_SHIPPING_EXCHANGE_COST must be set to seed from current prices"
    );
  }

  const returnCents = Math.round(returnEuros * 100);
  const exchangeCents = Math.round(exchangeEuros * 100);

  for (const countryCode of ["*", "ES"]) {
    await db
      .insert(shippingFees)
      .values({
        countryCode,
        returnFeeCents: returnCents,
        exchangeFeeCents: exchangeCents,
      })
      .onConflictDoUpdate({
        target: shippingFees.countryCode,
        set: { returnFeeCents: returnCents, exchangeFeeCents: exchangeCents },
      });
    console.log(`seeded ${countryCode}: return=${returnCents}c exchange=${exchangeCents}c`);
  }
}

main().then(() => process.exit(0));
```

- [ ] **Step 4: Run the seed**

Run: `npx tsx scripts/seed-shipping-fees.ts`
Expected: two lines logged, both showing the same cent values your env vars imply.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts scripts/seed-shipping-fees.ts
git commit -m "feat: add shipping_fees table seeded from current flat prices"
```

---

### Task 5: The pure fee resolver

**Files:**
- Create: `lib/fees.ts`, `tests/fees.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type CountryFees = { returnFeeCents: number; exchangeFeeCents: number }`
  - `type FeeTable = Record<string, CountryFees>`
  - `type FeeKind = "return" | "exchange" | "none"`
  - `type Basket = { hasItems: boolean; netAmount: number }`
  - `DEFAULT_FEE_KEY = "*"`
  - `feesForCountry(table: FeeTable, country: string | null): CountryFees`
  - `resolveFee(fees: CountryFees, basket: Basket): { feeCents: number; kind: FeeKind }`
  - `centsToEuros(cents: number): number`

- [ ] **Step 1: Write the failing test**

Create `tests/fees.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_KEY,
  centsToEuros,
  feesForCountry,
  resolveFee,
  type FeeTable,
} from "@/lib/fees";

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: { returnFeeCents: 2000, exchangeFeeCents: 1500 },
  ES: { returnFeeCents: 400, exchangeFeeCents: 0 },
  FR: { returnFeeCents: 900, exchangeFeeCents: 600 },
};

describe("feesForCountry", () => {
  it("returns the country's own row when present", () => {
    expect(feesForCountry(TABLE, "ES")).toEqual({ returnFeeCents: 400, exchangeFeeCents: 0 });
    expect(feesForCountry(TABLE, "FR")).toEqual({ returnFeeCents: 900, exchangeFeeCents: 600 });
  });

  it("falls back to the default row for a country with no row", () => {
    expect(feesForCountry(TABLE, "DE")).toEqual({ returnFeeCents: 2000, exchangeFeeCents: 1500 });
  });

  it("falls back to the default row for a null country", () => {
    expect(feesForCountry(TABLE, null)).toEqual({ returnFeeCents: 2000, exchangeFeeCents: 1500 });
  });

  it("returns zero fees when even the default row is missing", () => {
    expect(feesForCountry({}, "ES")).toEqual({ returnFeeCents: 0, exchangeFeeCents: 0 });
  });
});

describe("resolveFee — Rule A, by net amount", () => {
  const es = TABLE.ES;

  it("charges nothing for an empty basket", () => {
    expect(resolveFee(es, { hasItems: false, netAmount: 0 })).toEqual({
      feeCents: 0,
      kind: "none",
    });
  });

  it("charges the return fee when money flows back to the customer", () => {
    expect(resolveFee(es, { hasItems: true, netAmount: 42.5 })).toEqual({
      feeCents: 400,
      kind: "return",
    });
  });

  it("charges the exchange fee when the customer owes money", () => {
    expect(resolveFee(es, { hasItems: true, netAmount: -12 })).toEqual({
      feeCents: 0,
      kind: "exchange",
    });
  });

  it("charges the exchange fee on an even swap", () => {
    expect(resolveFee(TABLE.FR, { hasItems: true, netAmount: 0 })).toEqual({
      feeCents: 600,
      kind: "exchange",
    });
  });

  // The divergence that made summary.tsx and the Stripe amount disagree:
  // a pure exchange for a CHEAPER item leaves netAmount > 0, so Rule A
  // charges the return fee. Rule B charged the exchange fee here.
  it("charges the return fee on an exchange for a cheaper item", () => {
    expect(resolveFee(TABLE.FR, { hasItems: true, netAmount: 5 })).toEqual({
      feeCents: 900,
      kind: "return",
    });
  });

  it("ignores netAmount entirely when the basket is empty", () => {
    expect(resolveFee(TABLE.FR, { hasItems: false, netAmount: 99 })).toEqual({
      feeCents: 0,
      kind: "none",
    });
  });
});

describe("centsToEuros", () => {
  it("converts without float drift", () => {
    expect(centsToEuros(419)).toBe(4.19);
    expect(centsToEuros(0)).toBe(0);
    expect(centsToEuros(2000)).toBe(20);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/fees.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/fees"`.

- [ ] **Step 3: Create `lib/fees.ts`**

```ts
// The single source of truth for "what fee applies to this basket".
//
// Pure — no db, no env, no server-only imports — so client components can
// import it for display while payments.ts imports it for the real charge.
// Before this module, eight call sites each reimplemented the rule and two
// of them disagreed with the other six.

export type CountryFees = {
  returnFeeCents: number;
  exchangeFeeCents: number;
};

export type FeeTable = Record<string, CountryFees>;

export type FeeKind = "return" | "exchange" | "none";

export type Basket = {
  /** Any item selected for return or exchange and not already confirmed. */
  hasItems: boolean;
  /** Value returned minus value of replacement items, in euros. Positive
   *  means the customer is owed money. */
  netAmount: number;
};

/** Row that every unlisted or unrecognised country falls back to. */
export const DEFAULT_FEE_KEY = "*";

const ZERO: CountryFees = { returnFeeCents: 0, exchangeFeeCents: 0 };

/**
 * Pick the fee pair for a country. An unknown, unlisted or null country
 * falls back to the '*' row; if that row is missing too, fees are zero
 * rather than NaN — undercharging is recoverable, a NaN checkout is not.
 */
export function feesForCountry(
  table: FeeTable,
  country: string | null | undefined
): CountryFees {
  if (country && table[country]) return table[country];
  return table[DEFAULT_FEE_KEY] ?? ZERO;
}

/**
 * Rule A — by net amount.
 *
 * Empty basket    -> no fee.
 * netAmount > 0   -> the customer is getting money back: return fee.
 * otherwise       -> the customer owes or breaks even: exchange fee.
 */
export function resolveFee(
  fees: CountryFees,
  basket: Basket
): { feeCents: number; kind: FeeKind } {
  if (!basket.hasItems) return { feeCents: 0, kind: "none" };
  if (basket.netAmount > 0) {
    return { feeCents: fees.returnFeeCents, kind: "return" };
  }
  return { feeCents: fees.exchangeFeeCents, kind: "exchange" };
}

export function centsToEuros(cents: number): number {
  return Math.round(cents) / 100;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all `tests/countries.test.ts` and `tests/fees.test.ts` cases.

- [ ] **Step 5: Commit**

```bash
git add lib/fees.ts tests/fees.test.ts
git commit -m "feat: single pure fee resolver replacing eight divergent call sites"
```

---

### Task 6: Cached fee-table read

**Files:**
- Create: `db/fees.ts`

**Interfaces:**
- Consumes: `FeeTable` from `lib/fees.ts`; `shippingFees` from `db/schema.ts`; `db` from `db/drizzle.ts`.
- Produces:
  - `getFeeTable(): Promise<FeeTable>` — cached, tagged `shipping-fees`.
  - `SHIPPING_FEES_TAG = "shipping-fees"`

- [ ] **Step 1: Create `db/fees.ts`**

```ts
// NOT a "use server" module. db/queries.ts carries "use server", which forces
// every export there to be an async server action; this file needs to export
// a plain constant alongside its reader, and is only ever imported by server
// components and server actions.
import { unstable_cache } from "next/cache";
import db from "./drizzle";
import { shippingFees } from "./schema";
import type { FeeTable } from "@/lib/fees";

export const SHIPPING_FEES_TAG = "shipping-fees";

/**
 * Read every fee row into a lookup keyed by country code (plus the '*'
 * default). Cached and tagged so rendering does not hit the DB per request;
 * the admin save action calls revalidateTag(SHIPPING_FEES_TAG) to publish a
 * price change without a deploy.
 */
export const getFeeTable = unstable_cache(
  async (): Promise<FeeTable> => {
    const rows = await db.select().from(shippingFees);
    const table: FeeTable = {};
    for (const row of rows) {
      table[row.countryCode] = {
        returnFeeCents: row.returnFeeCents,
        exchangeFeeCents: row.exchangeFeeCents,
      };
    }
    return table;
  },
  ["shipping-fees-table"],
  { tags: [SHIPPING_FEES_TAG] }
);
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add db/fees.ts
git commit -m "feat: cached shipping fee table reader"
```

---

### Task 7: Server-side basket valuation

**Files:**
- Create: `lib/basket.ts`, `lib/loadBasket.ts`
- Modify: `app/[id]/page.tsx:46-96`

**Interfaces:**
- Consumes: `getOrderById`, `getProducts` from `db/queries.ts` (in `lib/loadBasket.ts` only); `Product`, `OrderItem` from `types`.
- Produces:
  - `lib/basket.ts` (pure): `applyGlobalDiscount(allProducts: Product[], firstOrderProduct: { productId: string | number; price: string } | undefined): Product[]`
  - `lib/basket.ts` (pure): `valueBasket(items: OrderItem[], discountedProducts: Product[]): { returnPrice: number; exchangePrice: number; netAmount: number; hasItems: boolean }`
  - `lib/loadBasket.ts` (server): `loadBasket(orderId: string): Promise<{ order; discountedProducts; basket } | null>`

> **Why two files.** `db/queries.ts` pulls in the Shopify Node adapter and the Neon client at import time. If the valuation math lived alongside `loadBasket`, `tests/fees.test.ts` could not import it without a live `DATABASE_URL`. The math is pure and belongs in its own module.

- [ ] **Step 1: Create `lib/basket.ts` (pure — no `db/` imports)**

```ts
// Basket valuation. The client computes the same numbers for display; the
// server uses these to derive the *charge*, so the browser can no longer
// decide how much it pays.
//
// The discount math here is lifted verbatim from app/[id]/page.tsx so the two
// cannot drift — page.tsx now calls applyGlobalDiscount rather than inlining it.
//
// Pure module: no db, no env, no server-only imports, so it is unit-testable
// and safe to import from anywhere. The DB-backed wrapper is lib/loadBasket.ts.
import type { OrderItem, Product } from "@/types";

/**
 * Shopify returns current catalogue prices, but the customer paid the price at
 * order time. Derive a single ratio from the order's first line and apply it to
 * every variant, so replacement items are priced at what the customer would
 * effectively have paid.
 */
export function applyGlobalDiscount(
  allProducts: Product[],
  firstOrderProduct: { productId: string | number; price: string } | undefined
): Product[] {
  let globalDiscountRatio = 1;

  if (firstOrderProduct) {
    const firstProductId = firstOrderProduct.productId.toString();
    const firstCurrentProduct = allProducts.find(
      (p: Product) => p.id.split("/").pop() === firstProductId
    );
    if (firstCurrentProduct) {
      const orderPrice = parseFloat(firstOrderProduct.price);
      const currentPrice = parseFloat(
        firstCurrentProduct.variants.edges[0].node.price
      );
      if (currentPrice > 0) {
        globalDiscountRatio = orderPrice / currentPrice;
      }
    }
  }

  return allProducts.map((product: Product) => ({
    ...product,
    variants: {
      ...product.variants,
      edges: product.variants.edges.map((edge: { node: { price: string } }) => ({
        ...edge,
        node: {
          ...edge.node,
          price: (parseFloat(edge.node.price) * globalDiscountRatio).toFixed(2),
        },
      })),
    },
  }));
}

/**
 * Value a basket the same way every client component does: everything with an
 * action counts toward the return total; CAMBIO lines subtract the price of
 * their replacement variant (falling back to the original price when the
 * variant cannot be found).
 */
export function valueBasket(
  items: OrderItem[],
  discountedProducts: Product[]
): {
  returnPrice: number;
  exchangePrice: number;
  netAmount: number;
  hasItems: boolean;
} {
  const active = items.filter((item) => item.action && !item.confirmed);

  const returnPrice = active.reduce(
    (sum, item) => sum + parseFloat(item.price),
    0
  );

  const exchangePrice = active
    .filter((item) => item.action === "CAMBIO")
    .reduce((sum, item) => {
      if (item.new_variant_id) {
        const newProduct = discountedProducts.find((p) =>
          p.variants.edges.some((v) => v.node.id === item.new_variant_id)
        );
        const newVariant = newProduct?.variants.edges.find(
          (v) => v.node.id === item.new_variant_id
        );
        if (newVariant) return sum + parseFloat(newVariant.node.price);
      }
      return sum + parseFloat(item.price);
    }, 0);

  return {
    returnPrice,
    exchangePrice,
    netAmount: returnPrice - exchangePrice,
    hasItems: active.length > 0,
  };
}

```

- [ ] **Step 2: Create `lib/loadBasket.ts` (server-only)**

```ts
// Server-only wrapper around lib/basket.ts. Separate file because importing
// db/queries.ts pulls in the Shopify Node adapter and the Neon client, which
// must not be dragged into unit tests or client bundles.
import { getOrderById, getProducts } from "@/db/queries";
import { applyGlobalDiscount, valueBasket } from "@/lib/basket";
import type { OrderItem } from "@/types";

/** Load an order and value its basket. Returns null if the order is gone. */
export async function loadBasket(orderId: string) {
  const order = await getOrderById(orderId);
  if (!order) return null;

  const allProducts = await getProducts();
  const discountedProducts = applyGlobalDiscount(allProducts, order.products[0]);
  const basket = valueBasket(order.products as OrderItem[], discountedProducts);

  return { order, discountedProducts, basket };
}
```

- [ ] **Step 3: Add a test for `valueBasket`**

Append to `tests/fees.test.ts`:

```ts
import { valueBasket } from "@/lib/basket";

const product = (variantId: string, price: string) => ({
  id: "gid://shopify/Product/1",
  title: "T",
  handle: "t",
  description: "",
  images: { edges: [] },
  variants: { edges: [{ node: { id: variantId, price } }] },
}) as any;

const line = (over: Record<string, unknown>) => ({
  id: 1, lineItemId: "1", orderId: "o", productId: "1", title: "T",
  variant_title: "M", variant_id: "v1", price: "30.00", quantity: 1,
  changed: false, action: null, reason: null, notes: null,
  new_variant_title: null, new_variant_id: null, confirmed: false,
  return_id: null, refunded: null, credit: null, gift_card_id: null,
  return_line_item_id: null, transaction_id: null, transaction_amount: null,
  ...over,
}) as any;

describe("valueBasket", () => {
  it("reports an empty basket when nothing is selected", () => {
    expect(valueBasket([line({})], [])).toMatchObject({ hasItems: false, netAmount: 0 });
  });

  it("ignores lines already confirmed", () => {
    const b = valueBasket([line({ action: "DEVOLUCIÓN", confirmed: true })], []);
    expect(b.hasItems).toBe(false);
  });

  it("values a pure return at the line price", () => {
    const b = valueBasket([line({ action: "DEVOLUCIÓN" })], []);
    expect(b).toMatchObject({ returnPrice: 30, exchangePrice: 0, netAmount: 30, hasItems: true });
  });

  it("nets an exchange against the replacement variant price", () => {
    const b = valueBasket(
      [line({ action: "CAMBIO", new_variant_id: "v2" })],
      [product("v2", "25.00")]
    );
    expect(b).toMatchObject({ returnPrice: 30, exchangePrice: 25, netAmount: 5 });
  });

  it("falls back to the original price when the variant is missing", () => {
    const b = valueBasket([line({ action: "CAMBIO", new_variant_id: "gone" })], []);
    expect(b.netAmount).toBe(0);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. The import of `@/lib/basket` must succeed without `DATABASE_URL` set — if it does not, the pure/server split in Steps 1-2 was not applied correctly.

- [ ] **Step 5: Make `app/[id]/page.tsx` use the shared helper**

Replace lines 46-96 of `app/[id]/page.tsx` with:

```tsx
  const discountedAllProducts = applyGlobalDiscount(
    allProducts,
    orderData.products[0]
  );

  const feeTable = await getFeeTable();
  const fees = feesForCountry(
    feeTable,
    normalizeCountry(orderData.shippingCountry)
  );

  return (
    <FeesProvider fees={fees}>
      <ClientOrder
        name={orderData.orderNumber}
        items={orderData.products}
        order={orderData}
        id={orderData.id}
        allProducts={discountedAllProducts}
      />
    </FeesProvider>
  );
}
```

Replace the imports at the top of the file with:

```tsx
import { getOrderById, getProduct, getProducts } from "@/db/queries";
import { ClientOrder } from "./clientOrder";
import { redirect } from "next/navigation";
import { applyGlobalDiscount } from "@/lib/basket";
import { getFeeTable } from "@/db/fees";
import { feesForCountry } from "@/lib/fees";
import { normalizeCountry } from "@/lib/countries";
import { FeesProvider } from "./feesContext";
```

The now-unused `Product` import and the `firstProduct` / `globalDiscountRatio` block are deleted by the replacement above.

- [ ] **Step 6: Create `app/[id]/feesContext.tsx`**

```tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { CountryFees } from "@/lib/fees";

const ZERO: CountryFees = { returnFeeCents: 0, exchangeFeeCents: 0 };

const FeesContext = createContext<CountryFees>(ZERO);

/**
 * Carries the order country's fee pair to the components that display it.
 * Context rather than props because seven components across four levels need
 * it, and none of the intermediate ones care.
 *
 * This is for DISPLAY ONLY. The amount actually charged is recomputed
 * server-side in actions/payments.ts.
 */
export const FeesProvider = ({
  fees,
  children,
}: {
  fees: CountryFees;
  children: ReactNode;
}) => <FeesContext.Provider value={fees}>{children}</FeesContext.Provider>;

export const useFees = (): CountryFees => useContext(FeesContext);
```

- [ ] **Step 7: Verify the build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 8: Commit**

```bash
git add lib/basket.ts lib/loadBasket.ts app/\[id\]/page.tsx app/\[id\]/feesContext.tsx tests/fees.test.ts
git commit -m "feat: server-side basket valuation and fee context provider"
```

---

### Task 8: Migrate all fee call sites and make the charge server-authoritative

**Files:**
- Modify: `app/[id]/clientOrder.tsx:62-66`, `app/[id]/windows/orderWindowContent.tsx:36-41`, `app/[id]/windows/secondWindow.tsx:64-68`, `app/[id]/components/secondWindowForm.tsx:55-60`, `app/[id]/windows/thirdWindow.tsx:190-198`, `app/[id]/windows/lastWindow.tsx:55-72`, `app/[id]/components/summary/summary.tsx:85-93`, `app/[id]/components/buttons/asyncButton.tsx`, `actions/payments.ts`, `actions/return.ts:40-53`, `actions/refund.ts:30-32`, `actions/updateOrder.ts:186-191`, `db/queries.ts:441-466`

**Interfaces:**
- Consumes: `useFees` from `app/[id]/feesContext.tsx`; `resolveFee`, `centsToEuros` from `lib/fees.ts`; `loadBasket` from `lib/loadBasket.ts`; `getFeeTable` from `db/fees.ts`.
- Produces:
  - `createStripeUrl(id: string, email: string, isCredit: boolean): Promise<{ data: string | null }>` — **signature changed**, no longer takes `total`.
  - `returnFunction(id: string, isCredit: boolean, email: string): Promise<void>` — **signature changed**, no longer takes `totalPrice`.
  - `createReturn(orderId, fulfillmentLineItem, product, discount, returnFeeEuros: number)` — **new fifth parameter**.

- [ ] **Step 1: Replace the fee block in `app/[id]/clientOrder.tsx`**

Replace lines 62-66 (inside `calculatePrices`) with:

```tsx
    const { feeCents } = resolveFee(fees, {
      hasItems: items.some((item) => item.action && !item.confirmed),
      netAmount: totalPrice,
    });
    totalPrice -= centsToEuros(feeCents);
```

Add `fees` to the `useCallback` dependency array on line 72: `}, [allProducts, fees]);`

Immediately after `const [isPending, startTransition] = useTransition();` (line 18), add:

```tsx
  const fees = useFees();
```

Add to the imports:

```tsx
import { useFees } from "./feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
```

Then change the `AsyncButton` usage (lines 103-109) to drop `totalPrice`:

```tsx
              <AsyncButton
                text="Actualizar pedido"
                id={id}
                isCredit={credito}
                email={order.email}
              />
```

- [ ] **Step 2: Replace the fee block in `app/[id]/windows/orderWindowContent.tsx`**

`calculatePrices` here is a module-level function, so it must take the fees. Change its signature (line 8) and body (lines 36-41):

```tsx
const calculatePrices = (
  items: OrderItem[],
  allProducts: Product[],
  fees: CountryFees
): Prices => {
```

and

```tsx
  let totalPrice = returnPrice - exchangePrice;
  const { feeCents } = resolveFee(fees, {
    hasItems: items.some((item) => item.action && !item.confirmed),
    netAmount: totalPrice,
  });
  totalPrice -= centsToEuros(feeCents);
```

Add to the imports:

```tsx
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee, type CountryFees } from "@/lib/fees";
```

Inside the `OrderWindowContent` component body add `const fees = useFees();` and pass it at every `calculatePrices(items, allProducts)` call site in this file, making them `calculatePrices(items, allProducts, fees)`.

- [ ] **Step 3: Replace the fee block in `app/[id]/windows/secondWindow.tsx`**

Replace lines 64-68:

```tsx
  const totalPrice = totalPriceDevolver - totalPriceCambio;
  const fees = useFees();
  const { feeCents } = resolveFee(fees, {
    hasItems: items.some((item) => item.action && !item.confirmed),
    netAmount: totalPrice,
  });
```

Replace the hardcoded currency on lines 122-124:

```tsx
              <h5 className="text-xxs sm:text-xs">
                Coste: {formatEuros(centsToEuros(feeCents), "es")}
              </h5>
```

Add to the imports:

```tsx
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
import { formatEuros } from "@/lib/i18n";
```

> **Note:** `formatEuros` does not exist until Task 10. Until then, use `` `${centsToEuros(feeCents).toFixed(2)} €` `` and revisit in Task 13. Prefer to do that rather than introducing a forward dependency.

- [ ] **Step 4: Replace the fee block in `app/[id]/components/secondWindowForm.tsx`**

Replace lines 55-60:

```tsx
  const totalPriceAux = totalPriceDevolver - totalPriceCambio;
  const fees = useFees();
  const { feeCents } = resolveFee(fees, {
    hasItems: items.some((item) => item.action && !item.confirmed),
    netAmount: totalPriceAux,
  });
  const totalPrice = totalPriceAux - centsToEuros(feeCents);
```

Add to the imports:

```tsx
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
```

- [ ] **Step 5: Replace the fee block in `app/[id]/windows/thirdWindow.tsx`**

Replace lines 190-198:

```tsx
    let result = totalPriceDevolver - totalPriceCambio;
    const { feeCents } = resolveFee(fees, {
      hasItems: items.some((item) => item.action && !item.confirmed),
      netAmount: result,
    });

    if (shipping) {
      result -= centsToEuros(feeCents);
    }
    return result;
  }, [allProducts, items, shipping, fees]);
```

Add `const fees = useFees();` inside `ThirdWindowBase` before the `useMemo`, and to the imports:

```tsx
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
```

- [ ] **Step 6: Replace the fee block in `app/[id]/windows/lastWindow.tsx` — this changes behaviour**

This site used Rule B. Replace lines 55-72:

```tsx
      let totalPrice = totalPriceDevolver - totalPriceCambio;

      // Rule A, shared with every other site and with the server-side charge.
      // This previously used a Rule B variant keyed on action type, which
      // disagreed with the checkout total on a cheaper-item exchange.
      const { feeCents } = resolveFee(fees, {
        hasItems: items.some((item) => item.action && !item.confirmed),
        netAmount: totalPrice,
      });

      totalPrice -= centsToEuros(feeCents);
```

Add `fees` to the `useMemo` dependency array on line 79: `}, [allProducts, credito, items, fees]);`

Add `const fees = useFees();` inside `LastWindowBase` before the `useMemo`, and to the imports:

```tsx
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
```

The now-unused `itemsToDev` / `itemsToCambio` locals inside the `useMemo` are removed by the replacement above.

- [ ] **Step 7: Replace the fee block in `app/[id]/components/summary/summary.tsx` — this changes behaviour**

This site also used Rule B. Replace lines 85-93:

```tsx
  let totalPrice = totalPriceDevolver - totalPriceCambio;
  const fees = useFees();
  const { feeCents } = resolveFee(fees, {
    hasItems: itemsToDevolver.length > 0,
    netAmount: totalPrice,
  });
  const shippingCost = centsToEuros(feeCents);

  totalPrice -= shippingCost;
```

`itemsToDev` and `itemsToCambio` are still used for the accordion rendering on lines 152, 159 and 176, so keep them in the `useMemo`.

Add to the imports:

```tsx
import { useFees } from "../../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
```

- [ ] **Step 8: Drop `totalPrice` from `app/[id]/components/buttons/asyncButton.tsx`**

```tsx
"use client";
import { returnFunction } from "@/actions/return";
import { cn } from "@/lib/utils";

export const AsyncButton = ({
  text,
  id,
  isCredit,
  email,
}: {
  text: string;
  id: string;
  isCredit: boolean;
  email: string;
}) => {
  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      )}
      type="submit"
      onClick={async () => {
        await returnFunction(id, isCredit, email);
      }}
    >
      {text}
    </button>
  );
};
```

- [ ] **Step 9: Make `actions/payments.ts` derive the amount itself**

Replace the whole file:

```ts
"use server";

import { stripe } from "@/lib/stripe";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { normalizeCountry } from "@/lib/countries";
import { centsToEuros, feesForCountry, resolveFee } from "@/lib/fees";

function absoluteUrl(path: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL}${path}`;
}
const returnUrl = absoluteUrl("/");

/**
 * Create a Stripe Checkout session for the amount the customer owes.
 *
 * The amount is derived here, from the order's own items and its destination
 * country. It is deliberately NOT accepted from the caller: this used to take
 * a `total` computed in the browser, which meant the page could set its own
 * price.
 *
 * Returns { data: null } when the basket does not actually owe anything —
 * callers must treat a null URL as "no payment required".
 */
export const createStripeUrl = async (
  id: string,
  email: string,
  isCredit: boolean
) => {
  const loaded = await loadBasket(id);
  if (!loaded) return { data: null };

  const { order, basket } = loaded;
  const feeTable = await getFeeTable();
  const fees = feesForCountry(feeTable, normalizeCountry(order.shippingCountry));
  const { feeCents } = resolveFee(fees, basket);

  // netAmount is what the customer is owed; the fee reduces it. A negative
  // total means the customer owes us that much.
  const totalEuros = basket.netAmount - centsToEuros(feeCents);
  if (totalEuros >= 0) return { data: null };

  const amountCents = Math.round(-totalEuros * 100);

  const isCreditMeta = isCredit ? "true" : "false";
  const stripeSession = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "EUR",
          product_data: {
            name: "Returns & Exchanges Fee",
            description: "Shameless Collective",
          },
          unit_amount: amountCents,
        },
      },
    ],
    metadata: {
      id: id,
      isCredit: isCreditMeta,
    },
    success_url: returnUrl + "/success",
    cancel_url: returnUrl,
  });
  return { data: stripeSession.url };
};
```

- [ ] **Step 10: Update `actions/return.ts` to match**

Replace lines 40-53:

```ts
export async function returnFunction(
  id: string,
  isCredit: boolean,
  email: string
) {
  // Whether the customer owes anything is decided server-side, inside
  // createStripeUrl. A null URL means nothing to pay.
  const url = (await createStripeUrl(id, email, isCredit)).data;
  if (url) {
    redirect(url);
  }
```

Leave the rest of the function (the `try`/`catch` and the `redirect("/success")`) unchanged.

> **Careful:** `redirect()` throws a `NEXT_REDIRECT` error by design. It is currently called before the `try` block and must stay outside it, or the catch will swallow the redirect.

- [ ] **Step 11: Update `actions/refund.ts` to use the resolved fee**

Replace lines 30-32:

```ts
      const feeTable = await getFeeTable();
      const orderFees = feesForCountry(
        feeTable,
        normalizeCountry(order.shippingCountry)
      );
      const giftCardValue =
        (product.price - centsToEuros(orderFees.returnFeeCents)) * 1.15;
```

Add to the imports:

```ts
import { getFeeTable } from "@/db/fees";
import { normalizeCountry } from "@/lib/countries";
import { centsToEuros, feesForCountry } from "@/lib/fees";
```

- [ ] **Step 12: Parameterise the Shopify return fee in `db/queries.ts`**

Change the `createReturn` signature (line 441) to:

```ts
export async function createReturn(
  orderId: string,
  fulfillmentLineItem: string,
  product: any,
  discount: any,
  returnFeeEuros: number
) {
```

and line 464 to:

```ts
                amount: ${returnFeeEuros.toFixed(2)},
```

- [ ] **Step 13: Pass the fee at the `createReturn` call site**

In `actions/updateOrder.ts`, `processProductReturn` needs the fee. Change its signature:

```ts
async function processProductReturn(
  product: { action?: string; variant_id: string; [key: string]: any },
  totalOrder: OrderData,
  isCredit: boolean,
  returnFeeEuros: number
) {
```

and the `createReturn` call (lines 186-191):

```ts
    result = await createReturn(
      totalOrder.id,
      fulfillmentsProduct.node.id,
      adjustedProduct,
      lineitem.discount_allocations?.[0],
      returnFeeEuros
    );
```

In `updateFinalOrder`, resolve the fee once before the `Promise.all` (after line 256):

```ts
  const dbOrder = await getOrderById(id);
  const feeTable = await getFeeTable();
  const orderFees = feesForCountry(
    feeTable,
    normalizeCountry(dbOrder?.shippingCountry)
  );
  const returnFeeEuros = centsToEuros(orderFees.returnFeeCents);
```

and pass it through:

```ts
      processProductReturn(
        { ...product, action: product.action || undefined },
        totalOrder,
        isCredit,
        returnFeeEuros
      )
```

Add to the imports in `actions/updateOrder.ts`:

```ts
import { getOrderById } from "@/db/queries";
import { getFeeTable } from "@/db/fees";
import { normalizeCountry } from "@/lib/countries";
import { centsToEuros, feesForCountry } from "@/lib/fees";
```

(`getOrderById` joins the existing import list from `@/db/queries`.)

- [ ] **Step 14: Confirm nothing still reads the fee env vars**

Run:

```bash
grep -rn "NEXT_PUBLIC_SHIPPING_RETURN_COST\|NEXT_PUBLIC_SHIPPING_EXCHANGE_COST" --include="*.ts" --include="*.tsx" app components lib actions db
```

Expected: **no matches**. (`scripts/seed-shipping-fees.ts` is excluded from that path list and legitimately still reads them.)

- [ ] **Step 15: Run tests and build**

Run: `npm test && npm run build`
Expected: all tests PASS; build compiles clean.

- [ ] **Step 16: Manual verification — the critical gate**

With `npm run dev`:

1. **Spanish return, refund to card.** Look up a real ES order, select one item to return, walk to the final summary. The fee shown must equal today's `NEXT_PUBLIC_SHIPPING_RETURN_COST`, and the total must match what the pre-change build produced.
2. **Paid exchange.** Select an exchange for a more expensive item so the customer owes money. Confirm Stripe Checkout opens with an amount equal to `|netAmount − fee|`.
3. **The divergence case.** Exchange one item for a *cheaper* one. Confirm the summary and the checkout amount now agree — before this change they did not.
4. **Tamper check.** In devtools, modify the client-side total before clicking through. Confirm the Stripe amount is unchanged.

- [ ] **Step 17: Commit**

```bash
git add app actions db lib
git commit -m "feat: country-based fees with server-authoritative Stripe amount

Collapses eight divergent fee call sites into lib/fees.ts (Rule A) and moves
the charged amount out of the browser: createStripeUrl now derives it from the
order's items and destination country.

Fixes the summary/checkout disagreement on an exchange for a cheaper item,
where summary.tsx and lastWindow.tsx charged the exchange fee while the Stripe
total used the return fee."
```

---

## PHASE 3 — Fee administration

*Gate: change a price in the dashboard, see it in the portal without a deploy.*

### Task 9: Dashboard fee editor

**Files:**
- Create: `actions/shippingFees.ts`, `app/dashboard/shipping-fees/page.tsx`, `app/dashboard/shipping-fees/FeesTable.tsx`
- Modify: `app/dashboard/components/DashboardHeader.tsx`

**Interfaces:**
- Consumes: `getFeeTable`, `SHIPPING_FEES_TAG` from `db/fees.ts`; `SUPPORTED_COUNTRIES` from `lib/countries.ts`; `DEFAULT_FEE_KEY` from `lib/fees.ts`.
- Produces: `saveShippingFee(formData: FormData): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: Create the server action**

`actions/shippingFees.ts`:

```ts
"use server";

import db from "@/db/drizzle";
import { SHIPPING_FEES_TAG } from "@/db/fees";
import { shippingFees } from "@/db/schema";
import { normalizeCountry } from "@/lib/countries";
import { DEFAULT_FEE_KEY } from "@/lib/fees";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { revalidateTag } from "next/cache";

/** "12", "12.5", "12.50" -> cents. Rejects negatives, NaN and >2 decimals. */
function parseEurosToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const euros = Number(trimmed);
  if (!Number.isFinite(euros) || euros < 0) return null;
  return Math.round(euros * 100);
}

export async function saveShippingFee(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  // middleware.ts guards the /dashboard route, but a server action is its own
  // entry point and is not covered by route middleware.
  const session = await getServerSession(authOptions);
  if (session?.user?.role !== "admin") {
    return { ok: false, error: "Not authorised" };
  }

  const rawCountry = String(formData.get("countryCode") ?? "");
  const countryCode =
    rawCountry === DEFAULT_FEE_KEY ? DEFAULT_FEE_KEY : normalizeCountry(rawCountry);
  if (!countryCode) {
    return { ok: false, error: `Unsupported country: ${rawCountry}` };
  }

  const returnFeeCents = parseEurosToCents(String(formData.get("returnFee") ?? ""));
  const exchangeFeeCents = parseEurosToCents(String(formData.get("exchangeFee") ?? ""));
  if (returnFeeCents === null || exchangeFeeCents === null) {
    return { ok: false, error: "Fees must be a non-negative amount with at most 2 decimals" };
  }

  await db
    .insert(shippingFees)
    .values({ countryCode, returnFeeCents, exchangeFeeCents, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: shippingFees.countryCode,
      set: { returnFeeCents, exchangeFeeCents, updatedAt: new Date() },
    });

  revalidateTag(SHIPPING_FEES_TAG);
  return { ok: true };
}
```

> Verify the `authOptions` export name in `lib/auth.ts` before writing this — if it exports something else, use that name.

- [ ] **Step 2: Create the page**

`app/dashboard/shipping-fees/page.tsx`:

```tsx
import { getFeeTable } from "@/db/fees";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { DEFAULT_FEE_KEY } from "@/lib/fees";
import { FeesTable } from "./FeesTable";

export const dynamic = "force-dynamic";

export default async function ShippingFeesPage() {
  const table = await getFeeTable();

  const rows = [
    {
      countryCode: DEFAULT_FEE_KEY,
      label: "Default (all other countries)",
      returnFeeCents: table[DEFAULT_FEE_KEY]?.returnFeeCents ?? 0,
      exchangeFeeCents: table[DEFAULT_FEE_KEY]?.exchangeFeeCents ?? 0,
      hasRow: Boolean(table[DEFAULT_FEE_KEY]),
    },
    ...SUPPORTED_COUNTRIES.map((c) => ({
      countryCode: c.code,
      label: `${c.nameEn} (${c.code})`,
      returnFeeCents: table[c.code]?.returnFeeCents ?? table[DEFAULT_FEE_KEY]?.returnFeeCents ?? 0,
      exchangeFeeCents:
        table[c.code]?.exchangeFeeCents ?? table[DEFAULT_FEE_KEY]?.exchangeFeeCents ?? 0,
      hasRow: Boolean(table[c.code]),
    })),
  ];

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">Shipping fees</h1>
      <p className="mt-2 text-sm text-gray-600">
        Amounts charged to the customer for a return or an exchange, by
        destination country. Countries left as{" "}
        <span className="font-semibold">inherited</span> use the default row.
        Changes apply immediately — no deploy needed.
      </p>
      <FeesTable rows={rows} />
    </main>
  );
}
```

- [ ] **Step 3: Create the client table**

`app/dashboard/shipping-fees/FeesTable.tsx`:

```tsx
"use client";

import { saveShippingFee } from "@/actions/shippingFees";
import { useState, useTransition } from "react";

type Row = {
  countryCode: string;
  label: string;
  returnFeeCents: number;
  exchangeFeeCents: number;
  hasRow: boolean;
};

const toEuros = (cents: number) => (cents / 100).toFixed(2);

export const FeesTable = ({ rows }: { rows: Row[] }) => {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<Record<string, string>>({});

  const onSave = (countryCode: string) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await saveShippingFee(formData);
      setStatus((prev) => ({
        ...prev,
        [countryCode]: result.ok ? "Saved" : result.error ?? "Failed",
      }));
    });
  };

  return (
    <table className="mt-6 w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Country</th>
          <th className="py-2">Return fee (€)</th>
          <th className="py-2">Exchange fee (€)</th>
          <th className="py-2" />
          <th className="py-2" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.countryCode} className="border-b">
            <td className="py-2">
              {row.label}
              {!row.hasRow && (
                <span className="ml-2 text-xs text-gray-500">inherited</span>
              )}
            </td>
            <td colSpan={4}>
              <form onSubmit={onSave(row.countryCode)} className="flex items-center gap-3 py-1">
                <input type="hidden" name="countryCode" value={row.countryCode} />
                <input
                  name="returnFee"
                  defaultValue={toEuros(row.returnFeeCents)}
                  inputMode="decimal"
                  className="w-24 rounded border px-2 py-1"
                />
                <input
                  name="exchangeFee"
                  defaultValue={toEuros(row.exchangeFeeCents)}
                  inputMode="decimal"
                  className="w-24 rounded border px-2 py-1"
                />
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded bg-cyan-800 px-3 py-1 text-white disabled:opacity-50"
                >
                  Save
                </button>
                <span className="text-xs text-gray-600">{status[row.countryCode]}</span>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
```

- [ ] **Step 4: Link it from the dashboard header**

In `app/dashboard/components/DashboardHeader.tsx`, add a link to `/dashboard/shipping-fees` alongside the existing header content, matching the file's existing markup style.

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: compiles clean.

- [ ] **Step 6: Manual verification**

Log in as admin, open `/dashboard/shipping-fees`. Set `FR` return fee to `9.00` and save. In a second tab, open a French order's return flow and confirm the summary shows `9,00 €` without restarting the server. Confirm a logged-out request to the page redirects to `/login`.

- [ ] **Step 7: Delete the obsolete env vars**

Remove `NEXT_PUBLIC_SHIPPING_RETURN_COST` and `NEXT_PUBLIC_SHIPPING_EXCHANGE_COST` from the Vercel project (all environments) and from `.env.local`. Keep `scripts/seed-shipping-fees.ts` — it documents where the seed values came from and is harmless once the vars are gone (it will refuse to run).

- [ ] **Step 8: Commit**

```bash
git add actions/shippingFees.ts app/dashboard
git commit -m "feat: dashboard editor for per-country shipping fees"
```

---

## PHASE 4 — Language

*Gate: the whole flow reads correctly in EN; the confirmation email arrives in one language; `es` stays the default.*

### Task 10: Dictionaries and locale plumbing

**Files:**
- Create: `lib/i18n/index.ts`, `lib/i18n/es.ts`, `lib/i18n/en.ts`, `lib/i18n/context.tsx`, `actions/locale.ts`, `components/LanguageSwitcher.tsx`
- Modify: `db/schema.ts`

**Interfaces:**
- Produces:
  - `type Locale = "es" | "en"`
  - `DEFAULT_LOCALE: Locale` (= `"es"`)
  - `LOCALE_COOKIE = "locale"`
  - `readLocale(value: string | undefined): Locale`
  - `formatEuros(amount: number, locale: Locale): string`
  - `dictionaries: Record<Locale, Dictionary>`
  - `LocaleProvider`, `useT(): Dictionary`, `useLocale(): Locale`
  - `setLocale(locale: Locale, orderId?: string): Promise<void>`

- [ ] **Step 1: Add the `locale` column**

In `db/schema.ts`, inside the `orders` table definition, after `carrierUrl`:

```ts
  // Language the customer chose in the portal; drives the transactional email.
  locale: text("locale"),
```

Run: `npx drizzle-kit push:pg`

- [ ] **Step 2: Create `lib/i18n/es.ts`**

```ts
// The canonical dictionary. en.ts is typed against this shape, so adding a
// key here without adding it there is a compile error.
export const es = {
  common: {
    continue: "Continuar",
    processing: "Procesando...",
    updateOrder: "Actualizar pedido",
    header: "CAMBIOS Y DEVOLUCIONES",
  },
  lookup: {
    intro: "Introduce los datos de tu pedido original para iniciar el proceso.",
    policyLink: "Ver política de devoluciones",
    orderNumber: "Número de pedido",
    orderPlaceholder: "Introduce tu número de pedido",
    email: "Email",
    emailPlaceholder: "Introduce tu email",
    submit: "Buscar pedido",
    consent: "Al continuar, confirmas que aceptas los",
    errorTitle: "Ha habido un error en tu solicitud",
  },
  first: {
    orderTitle: "Pedido",
    selectPrompt: "Selecciona los productos que deseas gestionar:",
  },
  dialog: {
    actionTitle: "Acción a realizar",
    actionChange: "Cambio",
    actionReturn: "Devolución",
    reasonChange: "Motivo del cambio",
    reasonReturn: "Motivo de la devolución",
    notes: "Notas",
    newSize: "Nueva talla",
  },
  reasons: {
    TOO_BIG: "Me queda grande",
    TOO_SMALL: "Me queda pequeño",
    UNCOMFORTABLE: "Es incómodo o me hace daño",
    DISLIKE: "No me gusta",
    BOUGHT_OPTIONS: "Compré varias opciones para probar",
    DAMAGED: "El producto está dañado",
    WRONG_ITEM: "Recibí el producto equivocado",
    LATE: "El producto llegó demasiado tarde",
    OTHER: "Otro motivo",
    NOT_AS_SHOWN: "El producto no es como se mostraba",
  },
  second: {
    title: "Método de devolución",
    subtitle:
      "Escoge el método de envío que quieres usar para devolver los productos seleccionados",
    correosDropoff: "Entrega en punto de recogida Correos",
    cost: "Coste",
    dropoffTitle: "Entrega en punto de recogida",
    dropoffBody:
      "Valida tu dirección de envío para poder generar la etiqueta de devolución que recibirás en tu email, con la que podrás llevar tu paquete a un punto de recogida de Correos.",
    dropoffLink: "Ver listado",
    name: "Nombre",
    address: "Calle y número",
    address2: "Apartamento, local, etc (Opcional)",
    zip: "Código postal",
    city: "Ciudad",
    province: "Provincia",
    country: "País",
    phone: "Teléfono",
  },
  third: {
    title: "Elige tu reembolso",
    storeCredit: "Crédito en tienda",
    storeCreditBadge: "+15% extra",
    storeCreditBody:
      "Recibe, cuando se acepte tu devolución, un cheque regalo para volver a comprar en la tienda online de Shameless Collective, con hasta un +15% extra de regalo sobre tu devolución.",
    originalPayment: "Método de pago original",
    originalPaymentBody:
      "Recibe tu dinero, cuando se acepte tu devolución, en el método de pago que usaste en tu compra. Puede demorar hasta 15 días.",
    totalRefund: "Reembolso total",
  },
  summary: {
    heading: "DESGLOSE DE TU SOLICITUD",
    toReturn: "Productos a devolver",
    newProducts: "Nuevos productos",
    andLogistics: "& Logística",
    shipping: "Envío",
    bonus: "Bonificaciones - Crédito en tienda",
    totalRefund: "Total reembolso",
    totalToPay: "Total a pagar",
    provisional: "Resumen provisional. Puede cambiar a lo largo del proceso",
  },
  last: {
    title: "Resumen final",
    exchangeTitle: "Cambio de productos",
    exchangeBodyBold: "Una vez devuelvas tus productos,",
    exchangeBodyRest: "recibirás los nuevos que has seleccionado.",
    creditTitle: "Crédito en tienda",
    creditBodyStart: "Recibirás en tu correo un código por valor de",
    creditBodyMid: "con el que comprar de nuevo en Shameless Collective,",
    creditBodyEnd: "cuando se acepte tu devolución.",
    refundTitle: "Reembolso tradicional",
    refundBodyStart: "Recibirás tu reembolso de",
    refundBodyMid: "en el método de pago que usaste en tu compra original,",
    refundBodyEnd: "cuando se acepte tu devolución.",
    refundDelayStart:
      "Debido al tiempo necesario para recibir los productos, revisarlos, y procesar la devolución,",
    refundDelayBold: "pueden pasar hasta 15 días",
    refundDelayEnd: "hasta que recibas tu dinero.",
  },
  success: {
    title: "¡Hemos recibido tu solicitud correctamente!",
    body: "Hemos recibido tu solicitud y te hemos enviado un correo electrónico con los próximos pasos.",
  },
} as const;

export type Dictionary = typeof es;
```

- [ ] **Step 3: Create `lib/i18n/en.ts`**

```ts
import type { Dictionary } from "./es";

// Typed against the Spanish dictionary: a key added to es.ts and forgotten
// here fails `npm run build` instead of rendering "undefined" to a customer.
export const en: Dictionary = {
  common: {
    continue: "Continue",
    processing: "Processing...",
    updateOrder: "Update order",
    header: "RETURNS & EXCHANGES",
  },
  lookup: {
    intro: "Enter your original order details to start the process.",
    policyLink: "See returns policy",
    orderNumber: "Order number",
    orderPlaceholder: "Enter your order number",
    email: "Email",
    emailPlaceholder: "Enter your email",
    submit: "Find order",
    consent: "By continuing, you confirm that you accept the",
    errorTitle: "There was an error in your request",
  },
  first: {
    orderTitle: "Order",
    selectPrompt: "Select the items you want to manage:",
  },
  dialog: {
    actionTitle: "Action",
    actionChange: "Exchange",
    actionReturn: "Return",
    reasonChange: "Reason for the exchange",
    reasonReturn: "Reason for the return",
    notes: "Notes",
    newSize: "New size",
  },
  reasons: {
    TOO_BIG: "Too big",
    TOO_SMALL: "Too small",
    UNCOMFORTABLE: "Uncomfortable or it hurts",
    DISLIKE: "I don't like it",
    BOUGHT_OPTIONS: "I bought several options to try",
    DAMAGED: "The item is damaged",
    WRONG_ITEM: "I received the wrong item",
    LATE: "The item arrived too late",
    OTHER: "Another reason",
    NOT_AS_SHOWN: "The item is not as shown",
  },
  second: {
    title: "Return method",
    subtitle: "Choose the shipping method you want to use to return the selected items",
    correosDropoff: "Drop off at a Correos pickup point",
    cost: "Cost",
    dropoffTitle: "Drop off at a pickup point",
    dropoffBody:
      "Confirm your shipping address so we can generate the return label you will receive by email, which you can use to drop your parcel at a Correos pickup point.",
    dropoffLink: "See locations",
    name: "Name",
    address: "Street and number",
    address2: "Apartment, unit, etc. (Optional)",
    zip: "Postcode",
    city: "City",
    province: "Province",
    country: "Country",
    phone: "Phone",
  },
  third: {
    title: "Choose your refund",
    storeCredit: "Store credit",
    storeCreditBadge: "+15% extra",
    storeCreditBody:
      "Once your return is accepted, receive a gift voucher to shop again at the Shameless Collective online store, with up to +15% extra on top of your refund.",
    originalPayment: "Original payment method",
    originalPaymentBody:
      "Once your return is accepted, receive your money back via the payment method you used for your purchase. It can take up to 15 days.",
    totalRefund: "Total refund",
  },
  summary: {
    heading: "BREAKDOWN OF YOUR REQUEST",
    toReturn: "Items to return",
    newProducts: "New items",
    andLogistics: "& Shipping",
    shipping: "Shipping",
    bonus: "Bonus - Store credit",
    totalRefund: "Total refund",
    totalToPay: "Total to pay",
    provisional: "Provisional summary. It may change during the process",
  },
  last: {
    title: "Final summary",
    exchangeTitle: "Item exchange",
    exchangeBodyBold: "Once you return your items,",
    exchangeBodyRest: "you will receive the new ones you selected.",
    creditTitle: "Store credit",
    creditBodyStart: "You will receive a code by email worth",
    creditBodyMid: "to shop again at Shameless Collective,",
    creditBodyEnd: "once your return is accepted.",
    refundTitle: "Standard refund",
    refundBodyStart: "You will receive your refund of",
    refundBodyMid: "via the payment method you used for your original purchase,",
    refundBodyEnd: "once your return is accepted.",
    refundDelayStart:
      "Because we need time to receive the items, inspect them and process the return,",
    refundDelayBold: "it can take up to 15 days",
    refundDelayEnd: "for you to receive your money.",
  },
  success: {
    title: "We have received your request!",
    body: "We have received your request and sent you an email with the next steps.",
  },
};
```

- [ ] **Step 4: Create `lib/i18n/index.ts`**

```ts
import { es, type Dictionary } from "./es";
import { en } from "./en";

export type Locale = "es" | "en";
export type { Dictionary };

export const DEFAULT_LOCALE: Locale = "es";
export const LOCALE_COOKIE = "locale";
export const LOCALES: Locale[] = ["es", "en"];

export const dictionaries: Record<Locale, Dictionary> = { es, en };

/** Coerce an untrusted cookie value to a supported locale. */
export function readLocale(value: string | null | undefined): Locale {
  return value === "en" || value === "es" ? value : DEFAULT_LOCALE;
}

/** Locale-correct currency: "4,00 €" in es-ES, "€4.00" in en. */
export function formatEuros(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-IE", {
    style: "currency",
    currency: "EUR",
  }).format(amount);
}
```

- [ ] **Step 5: Create `lib/i18n/context.tsx`**

```tsx
"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, dictionaries, type Dictionary, type Locale } from ".";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export const LocaleProvider = ({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) => <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;

export const useLocale = (): Locale => useContext(LocaleContext);

/** The active dictionary. Usage: const t = useT(); ... {t.second.title} */
export const useT = (): Dictionary => dictionaries[useContext(LocaleContext)];
```

- [ ] **Step 6: Create `actions/locale.ts`**

```ts
"use server";

import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { LOCALE_COOKIE, readLocale, type Locale } from "@/lib/i18n";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

/**
 * Persist the customer's language choice. The cookie drives what the portal
 * renders; the orders row drives which language the transactional email is
 * sent in, which is why it is written on every switch rather than only at
 * checkout — the customer may abandon and have the return created later.
 */
export async function setLocale(locale: Locale, orderId?: string) {
  const safe = readLocale(locale);

  cookies().set(LOCALE_COOKIE, safe, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  if (orderId) {
    await db.update(orders).set({ locale: safe }).where(eq(orders.id, orderId));
  }

  revalidatePath("/", "layout");
}
```

- [ ] **Step 7: Create `components/LanguageSwitcher.tsx`**

```tsx
"use client";

import { setLocale } from "@/actions/locale";
import { useLocale } from "@/lib/i18n/context";
import { useTransition } from "react";

export const LanguageSwitcher = ({ orderId }: { orderId?: string }) => {
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();

  return (
    <select
      aria-label="Language"
      value={locale}
      disabled={isPending}
      onChange={(e) => {
        const next = e.target.value === "en" ? "en" : "es";
        startTransition(async () => {
          await setLocale(next, orderId);
        });
      }}
      className="text-xs bg-transparent border border-slate-200 rounded px-2 py-1"
    >
      <option value="es">Español</option>
      <option value="en">English</option>
    </select>
  );
};
```

- [ ] **Step 8: Verify the build**

Run: `npm run build`
Expected: compiles clean. If `en.ts` is missing a key present in `es.ts`, this is where it fails — that is the mechanism working.

- [ ] **Step 9: Commit**

```bash
git add lib/i18n actions/locale.ts components/LanguageSwitcher.tsx db/schema.ts
git commit -m "feat: ES/EN dictionaries, locale context and language switcher"
```

---

### Task 11: Decouple persisted action/reason values from their labels

**Files:**
- Modify: `placeholder.ts:1-17`, `app/[id]/components/dialogForm.tsx:36, 366-387`, `actions/updateOrder.ts:85-86`

**Interfaces:**
- Consumes: `useT` from `lib/i18n/context.tsx`.
- Produces:
  - `ACTIONS = { CHANGE: "CAMBIO", RETURN: "DEVOLUCIÓN" }` — **values changed** to the stable codes already used in the DB.
  - `REASON_KEYS: readonly (keyof Dictionary["reasons"])[]`

> **This is the highest-risk task in Phase 4.** `updateOrder.ts:86` currently decides exchange-vs-return by comparing the submitted value against the literal string `"Quiero cambiar este producto"`, which is also the dropdown's visible label. Translating the label without this task turns every English exchange into a return.

- [ ] **Step 1: Change `placeholder.ts`**

Replace lines 1-17:

```ts
// ACTIONS values are the codes persisted in productsOrder.action — NOT display
// text. They were previously the Spanish sentences shown in the dropdown, which
// meant translating the label silently changed which branch updateOrder took.
export const ACTIONS = {
  CHANGE: "CAMBIO",
  RETURN: "DEVOLUCIÓN",
};

// Stable keys into the `reasons` dictionary. productsOrder.reason stores the
// key, not the localized sentence, so a reason recorded in English and one
// recorded in Spanish are the same value in the database.
export const REASON_KEYS = [
  "TOO_BIG",
  "TOO_SMALL",
  "UNCOMFORTABLE",
  "DISLIKE",
  "BOUGHT_OPTIONS",
  "DAMAGED",
  "WRONG_ITEM",
  "LATE",
  "OTHER",
  "NOT_AS_SHOWN",
] as const;

export type ReasonKey = (typeof REASON_KEYS)[number];
```

Leave `PRIVACY_LINKS` and everything below it unchanged.

- [ ] **Step 2: Update the action comparison in `actions/updateOrder.ts:85-86`**

```ts
  const actionType = data.action === ACTIONS.CHANGE ? "CAMBIO" : "DEVOLUCIÓN";
```

Add to the imports:

```ts
import { ACTIONS } from "@/placeholder";
```

- [ ] **Step 3: Update `dialogForm.tsx` to separate value from label**

Line 36 — default reason becomes a key:

```tsx
    orderProduct.reason || "TOO_SMALL"
```

Lines 366-387 — the two selects and the notes input:

```tsx
        <FormSelect
          name="accion"
          title={t.dialog.actionTitle}
          options={[
            { value: ACTIONS.CHANGE, label: t.dialog.actionChange },
            { value: ACTIONS.RETURN, label: t.dialog.actionReturn },
          ]}
          valueini={action || ACTIONS.CHANGE}
        />
        <FormSelect
          name="motivo"
          title={
            action === ACTIONS.CHANGE
              ? t.dialog.reasonChange
              : t.dialog.reasonReturn
          }
          options={REASON_KEYS.map((key) => ({
            value: key,
            label: t.reasons[key],
          }))}
          valueini={reason}
        />
        <FormInput name="notas" title={t.dialog.notes} icon={false} valueini="" />
```

Add `const t = useT();` inside the component, and to the imports:

```tsx
import { ACTIONS, REASON_KEYS } from "@/placeholder";
import { useT } from "@/lib/i18n/context";
```

Also localize the `title="Nueva talla"` on line 580 to `title={t.dialog.newSize}`.

- [ ] **Step 4: Verify remaining `ACTIONS` consumers**

Run:

```bash
grep -rn "ACTIONS\." --include="*.tsx" --include="*.ts" app components actions
```

Every hit must compare against `ACTIONS.CHANGE` / `ACTIONS.RETURN` rather than a literal sentence. Fix any that don't.

- [ ] **Step 5: Backfill existing reason rows**

Existing rows store the Spanish sentence in `productsOrder.reason`. They are display-only in `/dashboard`, so leave them — but confirm the dashboard renders an unknown reason without crashing. If `ReturnsTable.tsx` looks the reason up in a map, add a fallback to the raw stored string.

- [ ] **Step 6: Verify the build and test the exchange path**

Run: `npm run build`, then with `npm run dev` create an **exchange** on a test order. Confirm the DB row has `action = 'CAMBIO'` and `changed = true`. This is the regression this task exists to prevent.

- [ ] **Step 7: Commit**

```bash
git add placeholder.ts app/\[id\]/components/dialogForm.tsx actions/updateOrder.ts
git commit -m "fix: decouple persisted action/reason values from display labels

ACTIONS.CHANGE was the Spanish sentence shown in the dropdown AND the string
updateOrder compared against, so translating the label would have turned every
exchange into a return."
```

---

### Task 12: Wire the providers and the switcher

**Files:**
- Modify: `app/[id]/page.tsx`, `app/page.tsx`, `app/success/page.tsx`, `app/[id]/windows/header.tsx`, `app/[id]/clientOrder.tsx`

- [ ] **Step 1: Read the locale in `app/[id]/page.tsx`**

Inside `OrderPage`, before the return:

```tsx
  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
```

and wrap the existing `FeesProvider` return:

```tsx
  return (
    <LocaleProvider locale={locale}>
      <FeesProvider fees={fees}>
        <ClientOrder
          name={orderData.orderNumber}
          items={orderData.products}
          order={orderData}
          id={orderData.id}
          allProducts={discountedAllProducts}
        />
      </FeesProvider>
    </LocaleProvider>
  );
```

Add to the imports:

```tsx
import { cookies } from "next/headers";
import { LOCALE_COOKIE, readLocale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/context";
```

- [ ] **Step 2: Do the same in `app/page.tsx`**

Wrap `<InputComponent />` in `<LocaleProvider locale={locale}>`, reading the cookie the same way. Add the `LanguageSwitcher` above the logo inside the white card.

- [ ] **Step 3: Localize `app/success/page.tsx`**

It is a server component with no interactivity, so read the locale and index the dictionary directly rather than using the hook:

```tsx
  const locale = readLocale(cookies().get(LOCALE_COOKIE)?.value);
  const t = dictionaries[locale];
```

and replace the two hardcoded strings with `{t.success.title}` and `{t.success.body}`.

- [ ] **Step 4: Add the switcher to `app/[id]/windows/header.tsx`**

```tsx
"use client";
import Image from "next/image";
import Logo from "@/public/LOGO_black.png";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useT } from "@/lib/i18n/context";

export const Header = ({ orderId }: { orderId?: string }) => {
  const t = useT();
  return (
    <div className="bg-white flex flex-col lg:w-[30%] w-[85%] rounded-b-3xl items-center py-3 px-4 lg:px-6">
      <div className="w-full flex justify-end">
        <LanguageSwitcher orderId={orderId} />
      </div>
      <Image src={Logo} alt="Logo" width={150} height={150} className="w-auto h-auto" />
      <span className="border w-full border-slate-200 mt-2" />
      <h3 className="text-xs mt-2 text-slate-500">{t.common.header}</h3>
    </div>
  );
};
```

- [ ] **Step 5: Pass the order id in `app/[id]/clientOrder.tsx`**

Change `<Header />` on line 86 to `<Header orderId={id} />`.

- [ ] **Step 6: Verify**

Run `npm run build`, then `npm run dev`. Switch the dropdown to English on the lookup page and confirm the header changes and the choice survives a reload. Open an order, switch to English, and confirm the `orders.locale` column is now `'en'`.

- [ ] **Step 7: Commit**

```bash
git add app components
git commit -m "feat: mount locale provider and language switcher across the portal"
```

---

### Task 13: Translate the flow components

**Files:**
- Modify: `components/inputComponent.tsx`, `app/[id]/windows/firstWindow.tsx`, `app/[id]/windows/secondWindow.tsx`, `app/[id]/components/secondWindowForm.tsx`, `app/[id]/windows/thirdWindow.tsx`, `app/[id]/windows/lastWindow.tsx`, `app/[id]/components/summary/summary.tsx`, `app/[id]/components/summary/summaryShipping.tsx`, `app/[id]/components/buttons/nextButton.tsx`, `app/[id]/clientOrder.tsx`

For each file: add `const t = useT();` (and `const locale = useLocale();` where currency is rendered), then replace every hardcoded Spanish string with its dictionary key, and every `X.toFixed(2) + " €"` with `formatEuros(X, locale)`.

- [ ] **Step 1: `components/inputComponent.tsx`**

`t.lookup.errorTitle`, `t.common.header`, `t.lookup.intro`, `t.lookup.policyLink`, `t.lookup.consent`, `t.lookup.orderNumber`, `t.lookup.orderPlaceholder`, `t.lookup.email`, `t.lookup.emailPlaceholder`, `t.lookup.submit`.

- [ ] **Step 2: `app/[id]/windows/firstWindow.tsx`**

Line 30 → `{t.first.orderTitle} {name}`; line 32 → `{t.first.selectPrompt}`.

- [ ] **Step 3: `app/[id]/windows/secondWindow.tsx`**

Lines 87, 92-93, 118, 123, 134-136, 139-148 → `t.second.*`. Line 123 becomes:

```tsx
                {t.second.cost}: {formatEuros(centsToEuros(feeCents), locale)}
```

(this replaces the `.toFixed(2)` placeholder left in Task 8, Step 3).

- [ ] **Step 4: `app/[id]/components/secondWindowForm.tsx`**

All eight `FormInput`/`FormSelect` titles → `t.second.name`, `t.second.address`, `t.second.address2`, `t.second.zip`, `t.second.city`, `t.second.province`, `t.second.country`, `t.second.phone`. The country dropdown's option labels switch on locale:

```tsx
        options={SUPPORTED_COUNTRIES.map((c) => ({
          value: c.code,
          label: locale === "en" ? c.nameEn : c.nameEs,
        }))}
```

The submit button on line 146 → `{t.common.continue}`.

- [ ] **Step 5: `app/[id]/windows/thirdWindow.tsx`**

`StoreCredit` and `OriginalPayment` are module-level components, so pass `t` and `locale` in as props rather than calling the hook there. Strings: lines 62, 64, 70-72, 86, 126, 131-132, 146 → `t.third.*`, with `formatEuros` for both totals.

- [ ] **Step 6: `app/[id]/windows/lastWindow.tsx`**

Line 93 → `t.last.title`; lines 123-155 → `t.last.*`; both `{finalTotal.toFixed(2)} €` → `formatEuros(finalTotal, locale)`.

- [ ] **Step 7: `app/[id]/components/summary/summary.tsx`**

Lines 111, 123, 151-152, 187, 198 → `t.summary.*`; all five `.toFixed(2)` currency renders → `formatEuros(..., locale)`; line 207 → `t.summary.provisional`.

- [ ] **Step 8: `app/[id]/components/summary/summaryShipping.tsx`**

The `- {shippingCost}.00 €` on line 6 is wrong for non-integer fees regardless of language. Replace with:

```tsx
const ShippingCost = ({ shippingCost }: { shippingCost: number }) => {
  const locale = useLocale();
  return <h6 className="text-sm font-light">- {formatEuros(shippingCost, locale)}</h6>;
};
```

and localize the label in `SummaryShipping` to `t.summary.shipping`.

- [ ] **Step 9: `app/[id]/components/buttons/nextButton.tsx`**

Line 19 → `{isPending ? t.common.processing : t.common.continue}`.

- [ ] **Step 10: `app/[id]/clientOrder.tsx`**

The `AsyncButton` text on line 105 → `t.common.updateOrder`.

- [ ] **Step 11: Confirm no Spanish literals remain in the customer flow**

Run:

```bash
grep -rnE '"[^"]*[áéíóúñ¡¿][^"]*"|>[^<>{]*[áéíóúñ][^<>{]*<' \
  --include="*.tsx" app/\[id\] app/success app/page.tsx components/inputComponent.tsx \
  | grep -v "lib/i18n"
```

Expected: no matches outside `lib/i18n/`. Comments in Spanish are fine — check each hit before removing it.

- [ ] **Step 12: Verify**

Run: `npm test && npm run build`, then walk the entire flow in English with `npm run dev`: lookup → item selection → exchange dialog → address → refund choice → final summary. Every visible string must be English and every amount must render as `€4.00`.

- [ ] **Step 13: Commit**

```bash
git add app components
git commit -m "feat: translate the customer returns flow to EN via typed dictionaries"
```

---

### Task 14: Single-language transactional emails

**Files:**
- Modify: `actions/shipping.ts:154-219`, `actions/amphoraReturn.ts` (the `sendAmphoraConfirmationEmail` body), `actions/sendcloudReturn.ts` (its email body)

**Interfaces:**
- Consumes: `readLocale`, `type Locale` from `lib/i18n`.
- Produces: `generateEmailTemplate(name: string, locale: Locale)` — **new second parameter**.

- [ ] **Step 1: Rewrite `generateEmailTemplate` in `actions/shipping.ts`**

Replace the function at line 154 with a version that takes a locale and emits one block. Keep the existing outer `<div>` wrapper, the logo `<img src="cid:embedded-image">` and the inline styles exactly as they are — only the language block changes:

```ts
const EMAIL_COPY = {
  es: {
    subject: "Tu devolución se ha creado correctamente",
    text: "¡Tu devolución se ha creado correctamente!",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Gracias por iniciar un proceso de devolución con <strong>Shameless Collective</strong>. Adjunto encontrarás tu etiqueta de devolución para incluir en el paquete.",
    stepsTitle: "Pasos para completar tu devolución:",
    steps: [
      "Imprime la etiqueta de devolución adjunta (PDF).",
      "Empaqueta los artículos que deseas devolver en su envoltorio original.",
      "Coloca la etiqueta en el exterior del paquete.",
      "Lleva el paquete a tu oficina de <strong>Correos</strong> más cercana.",
    ],
    contact: "Si tienes alguna pregunta, no dudes en contactarnos en",
    closing: "¡Esperamos volver a verte pronto!",
    signoff: "Saludos cordiales,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your return was successfully created",
    text: "Your return was successfully created!",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "Thank you for initiating a return with <strong>Shameless Collective</strong>. Attached is your return label to include with the package.",
    stepsTitle: "Steps to complete your return:",
    steps: [
      "Print the attached return label (PDF).",
      "Securely package the items you wish to return.",
      "Attach the label to the outside of your package.",
      "Drop off the package at your nearest <strong>Correos office</strong>.",
    ],
    contact: "If you have any questions, feel free to contact us at",
    closing: "We look forward to seeing you again!",
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

function generateEmailTemplate(name: string, locale: Locale) {
  const c = EMAIL_COPY[locale];
  const p = 'style="font-size: 16px; color: #555;"';
  return {
    From: "hello@shamelesscollective.com",
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 20px auto;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="cid:embedded-image" alt="Shameless Collective Logo" style="max-width: 400px; height: auto;"/>
        </div>
        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          <p ${p}>${c.stepsTitle}</p>
          <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
            ${c.steps.map((s) => `<li style="margin-bottom: 10px;">${s}</li>`).join("")}
          </ol>
          <p ${p}>${c.contact}
            <a href="mailto:hello@shamelesscollective.com" style="color: #0073e6; text-decoration: none;">hello@shamelesscollective.com</a>.
          </p>
          <p ${p}>${c.closing}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>
    `,
  };
}
```

Add to the imports:

```ts
import { readLocale, type Locale } from "@/lib/i18n";
```

- [ ] **Step 2: Pass the order's locale at the call site**

Find where `generateEmailTemplate(name)` is called in `actions/shipping.ts` and change it to `generateEmailTemplate(name, readLocale(order.locale))`, loading the order if the function does not already have it in scope.

- [ ] **Step 3: Do the same for the Amphora email**

In `actions/amphoraReturn.ts`, `sendAmphoraConfirmationEmail` currently hardcodes English. Give it a `locale: Locale` parameter, add a Spanish variant of its copy in the same shape, and pass `readLocale(order.locale)` from `createInternationalReturn`.

- [ ] **Step 4: Do the same for the Sendcloud email**

Same treatment in `actions/sendcloudReturn.ts`. This path is currently dormant (`SENDCLOUD_INTL_RETURNS_ENABLED` off) but must not be left inconsistent.

- [ ] **Step 5: Verify**

Run: `npm run build`. Then create a test return with the portal in English and confirm the Postmark email arrives in English only, with the label PDF still attached. Repeat in Spanish.

- [ ] **Step 6: Commit**

```bash
git add actions/shipping.ts actions/amphoraReturn.ts actions/sendcloudReturn.ts
git commit -m "feat: send transactional emails in the customer's chosen language"
```

---

### Task 15: Documentation and cleanup

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-26-country-fees-and-i18n-design.md`

- [ ] **Step 1: Document the new operational surface in `README.md`**

Add a short section covering: where fees are edited (`/dashboard/shipping-fees`), that the `*` row is the fallback, that `NEXT_PUBLIC_SHIPPING_*_COST` are gone, and how to add a language (add to `LOCALES`, add a dictionary, `en.ts`-style typing enforces completeness).

- [ ] **Step 2: Mark the spec implemented**

Change the spec's `**Status:**` line to `Implemented — 2026-07-26`.

- [ ] **Step 3: Final full verification**

Run: `npm test && npm run build && npm run lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-26-country-fees-and-i18n-design.md
git commit -m "docs: document per-country fees and the language switcher"
```

---

## Self-Review Notes

**Spec coverage.** Every numbered design section maps to a task: §1 → Task 1-2, §2 → Task 3, §3 → Task 4, §4 → Task 5-6, §5 → Task 8 (steps 9-10), §6 → Task 8 (steps 11-13), §7 → Task 9, §8 → Task 10 + 12 + 13, §9 → Task 14. The Verification section maps to Tasks 1, 5, 7.

**Deviation from the spec, deliberately added.** Task 11 has no counterpart in the spec. It was found while writing the plan: `ACTIONS.CHANGE` is simultaneously a display label and the string `updateOrder.ts:86` branches on. Without it, Phase 4 would silently convert every English exchange into a return. It is a prerequisite for Task 13, not optional.

**Known forward reference.** Task 8 Step 3 renders the fee with `.toFixed(2)` because `formatEuros` does not exist until Task 10; Task 13 Step 3 replaces it. This is called out at both ends.

**Signature changes rippling across tasks:** `createStripeUrl` (4 args → 3, reordered), `returnFunction` (4 → 3), `createReturn` (4 → 5), `processProductReturn` (3 → 4), `generateEmailTemplate` (1 → 2), `Header` (0 props → optional `orderId`), `AsyncButton` (drops `totalPrice`), `calculatePrices` in `orderWindowContent.tsx` (2 → 3). All are declared in the Interfaces block of the task that changes them.
