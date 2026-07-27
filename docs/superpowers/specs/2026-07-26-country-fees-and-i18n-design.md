# Country-based shipping fees & ES/EN language switcher

**Date:** 2026-07-26
**Status:** Implemented — 2026-07-27
**Author:** Santiago Gericke (with Claude)

## Context & driver

Two independent asks against the returns portal:

1. **Language dropdown.** The customer-facing flow is hardcoded Spanish across ~10 files. Now that non-ES orders route through Amphora (see `2026-07-23-amphora-international-returns-design.md`), international customers are reading a Spanish-only portal.
2. **Country-based shipping fees.** The return/exchange fee is a single flat amount for every destination. Amphora's international collection costs materially more than a Correos national label, so one flat fee either undercharges international or overcharges Spain.

Both land in the same components (`summary.tsx`, `secondWindow.tsx`, `lastWindow.tsx`), so they are specified together but **shipped in sequence** — fees first, language second.

## Goals

- Fee resolved per destination country, editable by ops without a deploy.
- Fee resolution moved server-side; the browser can no longer set the amount charged.
- One fee rule, applied identically in the summary, at checkout, in the Shopify return, and in the gift-card calculation.
- Customer-selectable ES/EN across the portal and the transactional emails.
- Spain's current pricing and flow behave identically on day one.

## Non-goals

- No change to the Correos / Amphora / Sendcloud routing logic (`actions/return.ts`, the Stripe webhook).
- No translation of `/dashboard` or `/login` — internal, English-only.
- No languages beyond ES and EN this cycle.
- No component or end-to-end test suite; unit tests for pure fee/country logic only.
- No change to the admin refund/gift-card/exchange-order step beyond swapping in the shared fee resolver.

## Current-state facts (verified)

### Fees

- The fee is two `NEXT_PUBLIC_` env vars, `SHIPPING_RETURN_COST` and `SHIPPING_EXCHANGE_COST`, read directly at **8 call sites**.
- Those call sites implement **two different rules**:
  - **Rule A** — `totalPrice > 0 ? RETURN : EXCHANGE`
    `clientOrder.tsx:62`, `secondWindow.tsx:65`, `secondWindowForm.tsx:56`, `thirdWindow.tsx:191`, `orderWindowContent.tsx:37`
  - **Rule B** — `itemsToDev.length > 0 ? RETURN : itemsToCambio.length > 0 ? EXCHANGE : 0`
    `summary.tsx:86`, `lastWindow.tsx:65`
- They diverge in two live cases. `itemsToDev` matches only `action === "DEVOLUCIÓN"`:
  - **Pure exchange for a cheaper item** — `totalPrice > 0`, so Rule A charges the *return* fee while Rule B charges the *exchange* fee. The summary the customer reads (`summary.tsx`) and the total sent to Stripe (`clientOrder.tsx` → `AsyncButton`) therefore come from different rules.
  - **Nothing selected** — Rule A charges the exchange fee, Rule B charges 0. Unreachable today because the continue button is hidden, but encoded in the code.
- The fee is also hardcoded server-side at `refund.ts:31` (gift-card value) and `queries.ts:464` (Shopify `returnShippingFee`).
- `createStripeUrl` (`payments.ts:10`) accepts `total` **from the client** and charges `Math.round(total * 100)`. The browser controls the amount.

### Country

- `orders.shippingCountry` is free text (`db/schema.ts:16`), seeded from Shopify at `db/repository.ts:42`.
- `secondWindowForm.tsx:121` renders `País` as a **free-text input**, and `updateOrder.ts:130` writes it back unvalidated. The country is customer-editable mid-flow, immediately before checkout.
- Two independent country interpretations exist: `COUNTRY_NAME_TO_ISO2` (`sendcloudReturn.ts:44`, used by `euIso2ForReturn`) and an inline lowercase compare in `isInternationalOrder` (`amphoraReturn.ts:20`).

### Language

- No i18n library; no `next-intl`, no `react-i18next`.
- Customer-facing Spanish copy concentrated in `app/[id]/windows/*`, `app/[id]/components/summary/*`, `dialogForm.tsx`, `productLineClient.tsx`, `inputComponent.tsx`, `app/success/page.tsx`.
- `generateEmailTemplate` (`shipping.ts:154`) already emits **both** EN and ES stacked in a single message.
- No test tooling in `package.json`.

## Decisions

| Question | Decision |
|---|---|
| Languages | ES + EN, **always default to ES**, manual dropdown only (no country or browser inference) |
| Language scope | Portal UI **and** transactional emails; `/dashboard` and `/login` stay English |
| i18n mechanism | Hand-rolled typed dictionaries, no dependency |
| Locale persistence | Written to `orders.locale` **on every dropdown change** |
| Fee storage | **DB table**, editable from `/dashboard` |
| Fee table shape | **One row per country** (ISO-2) plus a `*` default row |
| Fee rule | **Rule A** — by net amount — with an explicit `0` for an empty basket |
| Amount trust | `createStripeUrl` **recomputes server-side**; no webhook reconciliation |
| Pricing country | The **edited** shipping address, with `País` converted to a dropdown |
| Sequencing | Fees first (phases 1–3), language second (phase 4) |

### Note on the fee rule

Rule A was chosen because it is what Stripe charges today, so adopting it keeps revenue unchanged; only the displayed summary moves to match. The empty-basket case is defined as `0` rather than Rule A's literal `totalPrice > 0 ? RETURN : EXCHANGE` fallthrough, which would charge an exchange fee for an empty selection.

### Note on the pricing country

Pricing from the edited address rather than the original Shopify order is deliberate: the label is created for the address the customer entered, so that address is what drives the real carrier cost. Converting `País` to a validated dropdown removes the typo and gaming surface that made free text unsafe to price from.

## Design

### 1. Canonical country module — `lib/countries.ts` (new)

- `SUPPORTED_COUNTRIES: { code: Iso2; nameEs: string; nameEn: string }[]`
- `normalizeCountry(input: string | null | undefined): Iso2 | null`

`COUNTRY_NAME_TO_ISO2` **moves here** from `sendcloudReturn.ts:44`; that file imports it. `isInternationalOrder` (`amphoraReturn.ts:20`) switches to `normalizeCountry(...) !== "ES"`, replacing its inline string compare. One interpretation of "what country is this" for the whole codebase.

### 2. `País` becomes a validated dropdown

`secondWindowForm.tsx:121` swaps `FormInput` for the existing `formSelect` component, options from `SUPPORTED_COUNTRIES` (labels localized once phase 4 lands). `updateOrder.ts` `updateData` validates `data.country` through `normalizeCountry` and rejects unknown values rather than writing arbitrary text. `orders.shippingCountry` holds ISO-2 going forward; `normalizeCountry` keeps historical rows readable.

### 3. Fee table — `db/schema.ts`

```ts
export const shippingFees = pgTable("shipping_fees", {
  countryCode:      text("country_code").primaryKey(),  // ISO-2, or "*" default row
  returnFeeCents:   integer("return_fee_cents").notNull(),
  exchangeFeeCents: integer("exchange_fee_cents").notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
});
```

Integer cents, not float — money in floats produces `4.199999999`. Euro formatting happens at the render edge.

### 4. Fee resolver — `lib/fees.ts` (new)

```ts
resolveFee(
  countryCode: Iso2 | null,
  basket: { hasItems: boolean; netAmount: number },
): { feeCents: number; kind: "return" | "exchange" | "none" }
```

Rule A, stated once:

- `!basket.hasItems` → `{ feeCents: 0, kind: "none" }`
- `netAmount > 0` → return fee for the country
- otherwise → exchange fee for the country

Country lookup falls back to the `*` row when the country has no row or does not normalize. All 8 call sites collapse into this function; client components stop reading `process.env` entirely. The fee is resolved server-side in `app/[id]/page.tsx` and passed down as a prop for display.

Reads go through `db/queries.ts` wrapped in `unstable_cache` tagged `shipping-fees`, so rendering does not hit the DB per request.

### 5. Server-authoritative checkout

`createStripeUrl` (`payments.ts:10`) changes signature: it takes the order id (and the credit flag) instead of `total`. It loads the order and its items, calls `resolveFee`, computes the amount itself, and charges that. The client keeps computing a total for **display only**.

### 6. Shared resolver on the back end

`refund.ts:31` and `queries.ts:464` both switch to `resolveFee`, so the fee charged, the fee deducted from store credit, and the fee reported to Shopify cannot drift apart.

### 7. Fee admin — `/dashboard/shipping-fees` (new)

Protected by the existing admin-role check in `middleware.ts` — no new auth work. A flat table over `SUPPORTED_COUNTRIES`, euro inputs for return and exchange, with the `*` default row pinned at the top. A server action validates (non-negative, at most 2 decimals, country in the supported list), upserts, and calls `revalidateTag("shipping-fees")`. Countries without a row fall through to `*`; ops does not need to fill in every country.

### 8. i18n — `lib/i18n/` (new)

- `es.ts` exports the dictionary; `en.ts` is typed `const en: typeof es`, so a missing key is a **compile error** rather than `undefined` rendered to a customer.
- A `locale` cookie is read in the server components (`app/[id]/page.tsx`, `app/page.tsx`, `app/success/page.tsx`) and supplied to a `LocaleProvider` client context; components call `useT()`. Cookie rather than a URL segment, so `middleware.ts` and the `/[id]` route shape are untouched. Absent cookie → `es`.
- Currency and number formatting via `Intl.NumberFormat` so `4,00 €` and `€4.00` render correctly per locale, replacing the hardcoded `{shippingCost},00 €` at `secondWindow.tsx:123` and `summaryShipping.tsx:6`.
- The dropdown lives in `windows/header.tsx` (rendered across the order flow) and on the lookup page. Switching writes the cookie, persists `orders.locale` via a server action, and calls `router.refresh()`.

### 9. Emails

New `locale` column on `orders`. `generateEmailTemplate` (`shipping.ts:154`) takes the locale and emits **one** language instead of the stacked EN+ES block. The Amphora and Sendcloud confirmation emails follow the same pattern. Absent locale → `es`.

## Verification

`vitest` is added and scoped to the pure functions only — `normalizeCountry` and `resolveFee` — because that is where the Rule A/B bug lived and where a country-keyed lookup can silently fall through to `*`.

Cases: return-only; exchange-only; mixed basket; **exchange for a cheaper item** (the divergence case); empty basket; unknown country; unmapped country falling back to `*`; `"España"` / `"Spain"` / `"ES"` / `"es"` equivalence.

No component or E2E tests.

## Phases

Each phase is independently deployable and independently verifiable.

**Phase 1 — country foundation.**
`lib/countries.ts`; `COUNTRY_NAME_TO_ISO2` relocated; `isInternationalOrder` switched to `normalizeCountry`; `País` converted to a validated dropdown.
*Success:* ES and Amphora international flows behave exactly as before; no pricing change; `normalizeCountry` tests green.

**Phase 2 — fee resolution.**
`shipping_fees` table, seeded from the current env values so prices do not move; `lib/fees.ts`; all 8 client call sites plus `refund.ts` and `queries.ts` migrated; `createStripeUrl` made server-authoritative.
*Success:* `resolveFee` tests green; a real Spanish checkout charges exactly what it charges today; the summary and the Stripe amount agree on a cheaper-exchange basket (they do not today).

**Phase 3 — fee administration.**
`/dashboard/shipping-fees` and its server action.
*Success:* change a country's fee in the dashboard and see it reflected in the portal without a deploy. Env vars deleted after this phase ships clean.

**Phase 4 — language.**
`lib/i18n/`, `LocaleProvider`, `useT()`, dropdown, `orders.locale`, single-language emails.
*Success:* the complete flow — lookup through confirmation — reads correctly in EN; the confirmation email arrives in the selected language only; `es` remains the default for a visitor who never touches the dropdown.

## Risks

- **Phase 2 touches the payment path** while the Amphora approval behaviour is still being diagnosed (`1da2cf0`). Mitigated by shipping fees before language, so a checkout regression has one obvious cause.
- **Rule A adoption changes the displayed summary** on cheaper-exchange baskets. Revenue is unchanged; the number the customer sees moves to match what they are actually charged.
- **Historical `shippingCountry` values** are free text. `normalizeCountry` handles the known spellings; anything unrecognized prices at the `*` default rather than failing.
