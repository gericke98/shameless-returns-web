# F1: The server boundary is structural (spec, rev 3)

Base: `main` @ `cbbf980`. Branch: `feat/f1-server-boundary`. Parent plan: `docs/superpowers/plans/2026-11-24-foundation-plan.md`.
Tier: HEAVY (it fronts the submit, cancel and payment entry points). Rev 1: Codex CHANGES-REQUIRED (14 findings).
Rev 2: Codex CHANGES-REQUIRED (10 of 14 resolved; #7, #9, #12 open, #11 accepted as F4; new blockers 15, 16).
The 2-round Codex cap is reached. Rev 3 fixes #12 and 16 directly and writes the recommended option for #7, #9 and 15,
Santi chose option A for all three on 2026-11-25 (§9). The spec is approved for implementation.

## Rules (verbatim from the owner)
1. Fix the root cause. Never a heuristic, tie-breaker, special case, flag, retry, regex over words, "until phase N"
   stopgap, or workaround for an existing weakness. If the root fix is bigger than the ask, say so and do the root fix
   (or stop and ask) — never ship the patch silently.
2. Before designing anything, read the official skills and docs for what already exists, and reuse it instead of
   rebuilding. State in the design which official primitive you use, or why none fits.
4. Identity, state and ownership are explicit data with stable ids — never derived from content, position, object
   identity, names, lineage or quote text.

## Scope decision (Santi, 2026-11-24)
Resolving an **unknown submit outcome** (the connection drops mid-submit) is **F4's**: it needs a submit command id plus
explicit submission states (awaiting payment / processing / completed / failed), built once with the durable lifecycle.
F1 adds no workaround for it. In F1, a dropped connection on submit behaves exactly as today (error boundary).
`/success` is unchanged in F1.

## Root weakness (verified at `cbbf980`)
Every export of a `"use server"` module is an HTTP endpoint. Each action re-implements authorization, takes identity
from the client, and shares modules with internals that then become endpoints:
- `actions/updateOrder.ts:98-102`: the session is checked on `parentOrderId`, but the write filters on row id + variant → cross-order write.
- `actions/shipping.ts` is `"use server"` and imported by `app/[id]/page.tsx:11` → `createShippingLabel`/`resendReturnLabel`
  (no session, by design) are registered actions (`.next` manifest `a7fefb8ebb`, `9fadcb5304`).
- `actions/selfBookedReturn.ts`, `selfReturnSweep.ts`, `payments.ts`, and `db/repository.ts` (incl. unused `updateOrderProduct`,
  which filters by variant + order id but takes any column set) are `"use server"` internals.
- `actions/authentication.ts` (`login`, `checkAuth`) is dead code.
- Results: `updateOrder`/`anularOrder`/`returnFunction`/`validateReturn` return `undefined` on refusal. `lib/submissionProposal.ts:106`
  throws an expected conflict. (The payout refusal is already a value, `actions/return.ts:243-249`.)
- Client identity reaches effects: the browser's `email` → Stripe `customer_email` (`actions/payments.ts:125`).
- Tracking can be written without an accepted self-booked submission (`selfBookedTracking.ts:52` checks only `orders.returnMethod`,
  which `return.ts:343` persists before checkout).
- `/api/shipping-status` is public with our Correos credentials. The cron secret is compared non-constant-time in 6 routes.
  `app/dashboard/shipping-fees/page.tsx` relies on middleware alone (`app/dashboard/page.tsx:161-176` already checks).

## Official primitives
- **Next.js server actions** and the Next.js data-security guidance: authorize inside every action; a `server-only` Data Access Layer.
- **`server-only`** (installed): internals cannot reach a client bundle (build error).
- **zod** (new dependency): action input validation, as in the Next.js forms docs. Schemas are `.strict()`.
- **`useFormState` (Next 14) form-action signature** `(prevState, formData)` for the lookup form.
- **TypeScript nominal ("branded") types** for verified identity. This is a language primitive; no library fits.
- **Vercel Cron bearer secret**, compared with `crypto.timingSafeEqual`.
- **next-auth session role** for admin (existing).

## Design

### 1. Verified identity is a type (`lib/server/identity.ts`, `server-only`)
```ts
declare const verified: unique symbol
export type VerifiedOrderId = string & { readonly [verified]: "order" }
export type VerifiedSubmission = { readonly id: string; readonly orderId: VerifiedOrderId; readonly [verified]: "submission" }
```
**Order mints**, each named by its source, each callable only from the files listed (enforced, §Enforcement 4):
| Mint | Credential it stands for | Only caller |
|---|---|---|
| `fromSession(sessionOrderId)` | portal session ∩ `expectedOrderId` | `lib/server/actions.ts` (`customerAction`) |
| `verifiedByLookup(order)` (decided A) | order number + contact email matched against Shopify by `validateOrderDetails`, rate limit passed | `lib/server/handlers/lookup.ts`, after validation, **before** `saveOrderToDatabase` and `issueOrderAccess` (blocker 15) |
| `verifiedByStripeSignature(metadata)` | Stripe signature verified by `constructEvent` | `app/api/webhooks/stripe/route.ts` |
| `adminTarget(id, ctx)` | admin session (`adminAction` ctx) | `lib/server/handlers/admin/*` |
| `systemTarget(id, job)` | a cron, for an id it selected from our own DB | `app/api/cron/*/route.ts`, `lib/server/handlers/system/*` |

**Submission capability (blocker 15, finding 7).** A `VerifiedSubmission` binds a server-minted submission id to the
verified order it belongs to. It is never minted from an id alone:
- `proposeSubmission(orderId: VerifiedOrderId, …)` returns one for the row it inserted (customer submit, free path).
- `submissionOf(orderId: VerifiedOrderId, submissionId)`: `SELECT … WHERE id = $sid AND order_id = $orderId`; `null` if the
  pair does not match. Used by the Stripe webhook (with its signature-minted order) and by crons (with `systemTarget`).
Every function keyed by a submission takes `VerifiedSubmission`, and **every statement also carries `order_id = sub.orderId`**:
`attachStripeSession`, `acceptFreeSubmission`, `acceptPaidSubmission`, `confirmSubmission`, `recordConfirmation`
(its `UPDATE productsorder` gains `AND p.order_id = ${sub.orderId}`), `claimForCancellation`, `finishCancellation`,
the tracking claim (§4). A submission id from one order can then never move another order's rows.

**Every function that writes keyed by an order id takes `VerifiedOrderId`**: `orderScope`, `proposeCurrentSelection`/`currentAgreement`,
`createStripeUrl`, `createReturnShipment` and its three lanes (`createShippingLabel`, `createInternationalReturn`, `createSelfBookedReturn`),
`revertFinalOrder`, `persistOrderLocale`, `persistReturnMethod`, the cancel internals, the tracking write, `resendReturnLabel`,
`saveOrderDetails`/`saveOrderItem`/`saveOrderToDatabase`, `issueOrderAccess`.
Branding alone does not stop a handler from importing a raw writer (finding 7); §Enforcement 6 closes that.

### 2. Three action factories, handlers imported, never inline (`lib/server/actions.ts`, `server-only`)
```ts
type BoundaryRefusal = "no-session" | "order-mismatch" | "not-admin" | "invalid-input" | "failed"
type ActionResult<V, R extends string> = { ok: true; value: V } | { ok: false; reason: R | BoundaryRefusal }

customerAction<S extends ZodObject<{ expectedOrderId: ZodString }>, V, R extends string>(
  name: string, schema: S, handler: (ctx: { orderId: VerifiedOrderId; order: OrderScope }, input: Omit<z.infer<S>, "expectedOrderId">) => Promise<ActionResult<V, R>>,
): (input: z.input<S>) => Promise<ActionResult<V, R>>
adminAction<S extends ZodObject, V, R extends string>(
  name: string, schema: S, handler: (ctx: { admin: string }, input: z.infer<S>) => Promise<ActionResult<V, R>>,
): (input: z.input<S>) => Promise<ActionResult<V, R>>
publicAction<S extends ZodObject, V, R extends string>(
  name: string, schema: S, handler: (ctx: {}, input: z.infer<S>) => Promise<ActionResult<V, R>>,
): (input: z.input<S>) => Promise<ActionResult<V, R>>
publicFormAction<S extends ZodObject, State extends { message: MessageKey | null }>(
  name: string, schema: S, handler: (ctx: {}, input: z.infer<S>, prevState: State) => Promise<State>,
): (prevState: State, formData: FormData) => Promise<State>
```
All four take the **same three arguments** `(literal name, schema identifier, imported handler identifier)`, so one
enforcement rule covers them (finding 12). `publicFormAction` parses `Object.fromEntries(formData)` with its schema.
Refusals carry **no free-text `detail`**: every refusal is a member of a closed union, so `ActionResult` has no other field.
- **The factories are synchronous** and return an `async (input) => ActionResult` closure. Auth and `cookies()` are read
  on **each call**, inside that closure.
- **Handlers live in `lib/server/handlers/{customer,admin,system}/*.ts` and `lib/server/handlers/lookup.ts`** (`server-only`, no directive). The action file only does
  `export const X = customerAction("X", schema, importedHandler)`. An inline arrow is forbidden: Codex showed that Next
  14.2.4's compiler registers an inline handler as a second, unwrapped `$$ACTION_n` endpoint.
- **`customerAction`, per call:** read the verified session order (`currentOrderId()`). None → `no-session`. Parse the input.
  If `input.expectedOrderId !== sessionOrderId` → `order-mismatch` (a stale tab never acts on another order). Then mint
  `VerifiedOrderId`, build `orderScope(id)`, and call the handler with `{ orderId, order }` plus the input minus `expectedOrderId`.
- **Exceptions:** the handler returns its domain refusals as values. An unexpected throw → `failed`, plus a log
  `[action-error] {name, orderId?, error}` and `enqueueOpsAlert` (dedupe `action-error:<name>:<orderId>:<hour>`). The
  enqueue is itself wrapped: if it throws, the action still returns `failed` and logs `[action-error-alert-failed]`.
  `isRedirectError` / `isNotFoundError` (`next/dist/client/components/redirect`, `.../not-found`, Next 14.2.4 paths)
  are rethrown. Only `publicFormAction` (lookup) still redirects server-side.
- **`publicFormAction` failure mapping** (it returns `State`, not `ActionResult`): schema failure → `{ message: "lookup.invalidInput" }`;
  unexpected throw → the same log + alert as above, then `{ message: "lookup.failed" }`; redirect errors rethrown.
  The handler's own refusals (`lookup.tooManyAttempts`, `lookup.notFound`, `lookup.mismatch`, `lookup.contactSupport`) are
  i18n keys in `lib/i18n/{es,en}.ts`; the hardcoded English strings in `order.ts` go.
- `R` is a **closed** union per action (the table in §4). There are no `string & {}` escapes.

### 3. Order-scoped DAL (`lib/server/orderScope.ts`, `server-only`)
`orderScope(id: VerifiedOrderId)`. Every statement has `orders.id = id` / `productsorder.order_id = id` in its own WHERE:
- `read()`: fresh, uncached order with products.
- `setLineSelection(rowId, sel)`: WHERE `id = rowId AND order_id = id AND confirmed IS NOT TRUE AND rowNotHeldBySettlement`.
  For an exchange, `sel.newVariantId` is validated by `isOfferedReplacement(variant)` (`lib/replacementCatalogue.ts`),
  the **same predicate the dialog's product list uses**. Cross-product exchanges stay allowed (`dialogForm.tsx:513,571`).
  The variant is read with `getVariantsByIds`, extended to return `product { id status }`, `inventoryQuantity`, `availableForSale`.
  The implementer reads `getProducts()` and the dialog's filters and encodes exactly that offer policy in the predicate, which both call sites then use.
  `new_variant_title` is taken from Shopify. The client's `newSize` is dropped. The original line's identity (`variant_id`,
  `line_item`) is never written. Ids are normalised with the existing `variantGid()`.
- `clearLineSelection(rowId)`: the same WHERE.
- `saveAddress(fields)`: WHERE `id`. Fields as in §4.
Zero rows matched → `not-editable`, a value, never silent success.

### 4. Every action's contract
Customer inputs all include `expectedOrderId: string`. The client never sends the email or the order's own data.

| Action (file) | Input (zod `.strict()`) | ok value | Domain refusals |
|---|---|---|---|
| `submitReturn` (`actions/return.ts`) | `payout: "refund"\|"credit"\|null`, `method: "CORREOS"\|"AMPHORA"\|"SELF"` (a claim; server-resolved as today) | `{ navigate: string }` (Stripe URL or `/success`) | `payout-required`, `nothing-selected`, `submission-in-progress` (was the throw at `submissionProposal.ts:106`) |
| `setLineSelection` (`actions/lines.ts`) | `rowId: int>0`, `action: "CAMBIO"\|"DEVOLUCIÓN"`, `reason: enum(REASON_KEYS)`, `notes: string≤1000`, `newVariantId?: string` (required iff CAMBIO) | `{}` | `not-editable`, `variant-not-offered` |
| `clearLineSelection` (`actions/lines.ts`) | `rowId` | `{}` | `not-editable` |
| `saveAddress` (`actions/address.ts`) | `name, address1, zip, city` (non-empty ≤200), `address2, province, phone` (≤200, optional), `delivery: {name,address1,address2?,zip,city,province?,country} \| null`, `deliveryBlockOffered: boolean` | `{}` | `incomplete`, `invalid-delivery` |
| `submitTracking` (`actions/tracking.ts`) | `carrierCode: string`, `trackingNumber: string≤64`, `trackingUrl?: string≤500` | `{ pending: boolean }` | `unknown-carrier`, `no-active-self-return`, `empty-tracking`, `too-long`, `wrong-format`, `order-number` (`TrackingNumberProblem`, `lib/carriers.ts:187`), `missing-url`, `invalid-url` (`lib/trackingUrl.ts:11`), `not-at-carrier` (carrier verdict `unknown`, `selfBookedTracking.ts:99`), `already-submitted` |
| `cancelReturn` (`actions/cancelReturn.ts`) | (none) | `{}` | every `CancelBlockedReason`, `carrier-cancel-failed`, `needs-support` |
| `settleRow` admin (`actions/refund.ts`) | `rowId: int>0` | `{ lines: {rowId,status}[] }` | `not-settleable` |
| `saveShippingFee` admin | `country: string`, `band: enum(weight bands)`, `fee: string` (FeesTable sends an object, no FormData) | `{}` | `unsupported-destination`, `invalid-band`, `invalid-amount` (the three refusals at `shippingFees.ts:31,38,44`; `:19` becomes `not-admin`, `:64` becomes `failed`) |
| `confirmSelfTracking` admin | `orderId, submissionId` | `{ pinned: boolean }` | `not-pending` |
| `rejectSelfTracking` admin | `orderId, submissionId` | `{}` | `not-pending` |
| `lookupOrder` public (`publicFormAction`) | FormData `order, email` (field names as today) | state `{ message: MessageKey \| null }`; success mints `verifiedByLookup`, saves, issues the session and `redirect("/<id>")` as today | `lookup.tooManyAttempts`, `lookup.notFound`, `lookup.mismatch`, `lookup.contactSupport`, plus `lookup.invalidInput`/`lookup.failed` from the factory |
| `setLocale` public | `locale: enum(locales)` | `{}` | (none) |

**Tracking claim (finding 9; decided A).** "Accepted" alone is not "active": acceptance
precedes confirmation (`return.ts:264-268`) and a submission stays `accepted` while cancellation holds it
(`submissionCancellation.ts:36`, until `finishCancellation`). The eligible submission is identified, not inferred:
- **Identity:** the order's one submission with `return_method = 'SELF'`, `state = 'accepted'`, `holder IS NULL`, whose
  lines all carry `return_line_item_id` (confirmed), and with `orders.return_submitted_at` set (booked). Resolved by
  `activeSelfSubmission(orderId: VerifiedOrderId): VerifiedSubmission | null`; none → `no-active-self-return`.
- **Serialization with cancellation:** the claim is one transaction: `SELECT … FROM return_submissions WHERE id = $sid
  AND order_id = $oid AND state = 'accepted' AND holder IS NULL FOR UPDATE`, then the existing write-once
  `UPDATE orders … WHERE id = $oid AND locator IS NULL`. `tracking_submission_id` stays what it is: a fresh id **per
  tracking attempt** that ops Confirm/Reject compares (`selfTrackingReview.ts:31`), not the return submission's id.
  `claimForCancellation`'s `UPDATE` on the same row waits for that lock, so
  cancellation either runs first (tracking then sees `holder = 'cancellation'` → `no-active-self-return`) or after the
  claim commits. The Amphora pin stays outside the transaction (no lock across an external call).
- **What A leaves to F4:** a cancel that starts after the claim commits but before `pinSelfTracking` returns can still
  cross the pin. Today that window exists too; F4's `return_shipments` state machine (pin and cancel are transitions of
  one shipment row) closes it. Recorded in the parent plan's F4 section.
`submitReturn` derives the email for Stripe from `orderScope.read()`.

### 5. Module layout
- `actions/*.ts`: the only `"use server"` files, exporting only factory-wrapped actions (plus types).
- `lib/server/` (`import "server-only"` on line 1): `actions.ts`, `identity.ts`, `orderScope.ts`, `handlers/*`, plus
  everything moved out of `actions/` that is not an endpoint: `shipping.ts`, `selfBookedReturn.ts`, `selfReturnSweep.ts`,
  `payments.ts`, `amphoraReturn.ts`, `amphora.ts`, `amphoraStatusSync.ts`, `opsAlert.ts`, `opsAlertOutbox.ts`, `selfReturnEmails.ts`,
  `receiptShortfallSweep.ts`, `exchangeReservation.ts`, and any other non-directive file now in `actions/`.
- `db/repository.ts`: directive removed, `server-only` added, `updateOrderProduct` deleted.
- Deleted: `actions/authentication.ts`, and the inline `"use server"` in `refund.ts`.

### 6. Other entry points (inventory)
| Entry point | Auth | F1 change |
|---|---|---|
| `/api/webhooks/stripe` | Stripe signature | mints `verifiedByStripeSignature` from metadata after verification; calls moved internals (cookie-independent, unchanged) |
| `/api/webhooks/amphora` | existing secret check | **ownership by `payload.name` fallback (`route.ts:67`) is a rule-4 violation; it moves to F4**, where the Amphora return id is persisted per shipment. F1 records it in the plan |
| `/api/auth/[...nextauth]` | next-auth | none |
| `/api/client-error` | portal session optional, telemetry only | none (writes only logs + a deduped alert) |
| `/api/shipping-status` | **admin** (`isAdmin()`), else 401 | new. **Blocker 16:** `export const revalidate = 300` and the `s-maxage=300, stale-while-revalidate=600` header are removed; the route is `export const dynamic = "force-dynamic"` and every response (200, 400, 401) sends `Cache-Control: private, no-store`. Otherwise an admin-warmed 200 is a shared-cache entry an anonymous request receives without running the gate |
| `/api/cron/*` (6) | `verifyCronRequest(req)` (`lib/server/cron.ts`, constant-time, refuses if unset) | new, shared |
| `app/dashboard/**/page.tsx` | `requireAdmin()` → returns the admin email, or `redirect("/login")` | add to `shipping-fees` |

### 7. Client contract (`lib/callAction.ts`)
`callAction(action, input)` returns:
- `{ kind: "result", result }` when the server answered. Only `result.ok` may trigger a success path.
- `{ kind: "unknown" }` when the promise rejected (transport).
Shared handling: `no-session` → `router.replace("/?session=expired")` (terminal); `not-admin` → message, nothing else.
Per caller:
| Caller | ok | refusal | unknown |
|---|---|---|---|
| asyncButton (`submitReturn`) | `window.location.assign(navigate)` | payout-required → payout step; others → inline message | rethrow (error boundary, unchanged until F4) |
| dialogForm (set/clear line) | existing success callbacks | inline message, dialog stays open, nothing voided | message "not saved, try again", dialog stays open, **no** callbacks |
| secondWindowForm (address) | advance wizard | inline message | message, do not advance |
| trackingCapture | `pending` → existing states | `already-submitted` → shows "received" state; others → message | `router.refresh()` + message (the page gates on `trackingSubmittedAt`) |
| returnStatusPanel (cancel) | existing success | message per reason | `router.refresh()` (page recomputes eligibility) + message |
| LanguageSwitcher | existing | (none) | message |
| FeesTable / SelfTrackingReview / ReturnsTable (admin) | existing | message | message, no local status change |
| InputComponent (lookup) | `useFormState(lookupOrder)`, renders `message` via i18n | — | — (native form) |
`app/error.tsx` retry: `startTransition(() => { router.refresh(); reset(); })`.

## Enforcement
`tests/actionBoundary.test.ts` (TypeScript compiler API, resolved symbols, not text):
1. No file outside `actions/` has a `"use server"` directive (module or function level).
2. Every `actions/*.ts` export is a type, or `export const X = <factory>(literal, Identifier, Identifier)` whose handler
   argument is an **imported identifier** resolving to a `lib/server/handlers/**` module. No inline functions.
3. Every `lib/server/**` file's first statement is `import "server-only"`.
4. `VerifiedOrderId`/`VerifiedSubmission` are constructed only inside `identity.ts` (no `as VerifiedOrderId` anywhere else,
   checked by the type checker's symbol references), and **each mint's references are exactly its "only caller" files**
   from the §1 table. A new caller of a mint fails the test, so an unrestricted mint cannot be called from a handler.
5. `publicAction`/`publicFormAction` are used exactly by `lookupOrder` and `setLocale`.
6. **Customer handlers reach the database only through capabilities (finding 7; decided A).**
   Walk the transitive **value**-import graph (type-only imports ignored) from every `lib/server/handlers/customer/**`
   module. Every module in that closure that imports `@/db/drizzle` must be on the capability list
   (`lib/server/orderScope.ts`, `lib/server/submissionScope.ts` (the §1 submission functions), and the moved internals
   listed in §1 whose every export takes a `VerifiedOrderId`, `VerifiedSubmission` or `OrderScope` parameter, checked with
   the type checker). Anything else in the closure that imports the DB client fails the test, naming the path.
   Admin and system handlers are out of this rule; they are already gated by their own credential.
`tests/actionManifest.test.ts` runs after `next build` in CI. It parses the generated action entries (the
`next-flight-action-entry-loader` output in `.next/server/app/**`) into the exact set of (module, export) endpoints and
asserts that set **equals** the approved list from §4, with no `$$ACTION_` names. The implementer confirms the
generated format on 14.2.4 first; if it cannot be parsed reliably, stop and ask.
Revert-and-fail proofs: an inline handler; `"use server"` on `lib/server/shipping.ts`; a `string` passed where
`VerifiedOrderId` is required (tsc); dropping the `expectedOrderId` comparison (unit test); a customer handler importing
`db/submissions.ts`'s raw writer or `@/db/drizzle` (rule 6); calling `verifiedByLookup` from a customer handler (rule 4);
dropping `AND p.order_id` from `recordConfirmation` (unit test below); restoring `s-maxage` on shipping-status (preview check below).

## Verification
- `tsc`, lint, the full single-fork suite, `next build` + manifest test.
- Unit (pg16 test DB): cross-order `setLineSelection` → `not-editable`, 0 rows changed; confirmed row → refused;
  cross-product offered variant → accepted; not-offered or no stock → refused; every customer action: no session → `no-session`,
  other order's `expectedOrderId` → `order-mismatch`; admin actions without admin → `not-admin`; tracking with no SELF
  submission, with one not yet confirmed, and with one held by cancellation → `no-active-self-return`; tracking claim and
  `claimForCancellation` run concurrently on two connections → exactly one wins, never both; `submissionOf(orderA, submissionOfB)`
  → `null`; `recordConfirmation` with a line whose row belongs to another order → 0 rows changed on that order;
  a proposal conflict → `submission-in-progress`; a throwing alert enqueue → still `failed`; lookup: valid credentials on a
  new order → rows saved + session issued; wrong email → nothing saved; every lookup refusal renders its i18n key in es and en.
- Preview (deployed, Neon branch): `GET /api/shipping-status?locator=X` as admin → 200 with `private, no-store`; the same
  URL right after without cookies → **401**, never a cached 200.
- E2E, local `next dev` against a **Neon branch** (never prod), DB checked before and after: lookup; size exchange; cross-product
  exchange; address; free Correos submit; **paid** submit to Stripe test checkout → signature-verified webhook (no cookies) →
  booking; duplicate webhook delivery; paid cancel; self-booked submit + tracking; stale tab (order A open, look up B, act in A
  → `order-mismatch`, nothing written); dashboard settle, fee save, tracking confirm/reject; expired session on each action.
- After deploy: the first real customer flow of each lane is checked end to end; no `[action-error]` alerts.

## 9. Decisions (Santi, 2026-11-25: A, A, A) — Codex cap reached, so these were A/B, not a third review round
| # | Question | A (chosen) | B (rejected) |
|---|---|---|---|
| 7 | How is "customer code can only write through capabilities" enforced? | Import-graph test from customer handlers (§Enforcement 6). Scoped to the customer surface; ~12 internals gain branded params. | Make it global now: only `lib/server/data/**` may import `@/db/drizzle` (29 modules today), every export takes a capability. Strongest, but it moves the whole settlement/cron data layer inside F1. |
| 9 | Tracking vs cancellation | Lock the identified SELF submission `FOR UPDATE` in the claim; the pin-vs-cancel window after commit goes to F4's shipment state machine (§4). | Add a `holder = 'tracking'` ownership value held across the Amphora pin. Closes the window now, but every settlement admission check (`ledger.ts:279`, `admission.ts:52`, `plan.ts:126`) must learn the new holder: a money-path change inside F1. |
| 15 | First lookup has no session yet | `verifiedByLookup` mint, called only in the lookup handler after Shopify credential match (§1). | Issue the session first and let lookup's writes go through `fromSession`. Reorders the flow so a session exists for an order with no DB rows yet; every reader must then handle that. |

## Corrections to rev 2
- Tracking refusals were incomplete; now closed (`missing-url`, `invalid-url`, `not-at-carrier` added).
- `invalid-fee` with `detail` contradicted `ActionResult`; replaced by three closed reasons.
- `publicFormAction(name, handler)` contradicted the three-argument rule; it now takes a schema like the others.
- "Submission ids are minted server-side, so submission-keyed functions are unchanged" was wrong: a server-minted id
  still carried no order binding. They now take `VerifiedSubmission`.
- `/api/shipping-status` kept shared-cache headers behind the new gate; now `private, no-store`.

## Corrections to rev 1
`updateOrderProduct` filters by variant **and** order id (its exposure and any-column write are the problem). The payout
refusal was already a value. The main dashboard page already checks admin; only `shipping-fees` does not. Locale cookie
reads stay where they are (`return.ts` `persistOrderLocale`, `locale.ts`, `error.tsx`).

## 10. Amendments after implementation (Santi, 2026-11-25) — supersede the sections they name
**§4 tracking claim (supersedes "Serialization with cancellation").** Measured on Postgres 16: the claim's `SELECT … FOR
UPDATE` never modifies the submission row, so a cancellation `UPDATE` queued behind the lock re-checks an unchanged row
(`holder IS NULL`) and also wins — both won in 5 of 20 rounds. Fix: `claimForCancellation` becomes one transaction of two
statements: (1) `SELECT … FROM return_submissions WHERE id = $sid AND order_id = $oid FOR UPDATE`; (2) the existing claim
`UPDATE`, plus `AND NOT EXISTS (SELECT 1 FROM orders WHERE id = $oid AND return_method = 'SELF' AND locator IS NOT NULL)`.
Statement (2) takes a fresh snapshot after the lock, so it sees a committed tracking claim. This is the existing
eligibility rule (a self-booked return with tracking is `in-transit`, `cancelEligibility`) enforced at the serialization
point. Settlement admission is unchanged. Verification: the concurrent test asserts **exactly one** of tracking and
cancellation wins in every round (≥50 rounds), and fails with statement (2)'s new condition removed.
**§Enforcement 6 (supersedes the module-level rule).** Checked per function, not per module: from each customer handler,
follow the call graph through the type checker (resolved call expressions, value imports only). Every reached function
that writes (Drizzle `insert`/`update`/`delete`, `db.execute`, `transact`) must take a `VerifiedOrderId`,
`VerifiedSubmission` or `OrderScope` parameter, unless every table it writes is on the **non-customer-data list**:
`ops_alerts`, `lookup_attempts` (named in the test, each with a one-line reason). A function whose written tables cannot be
resolved (raw SQL) must take a capability. Functions this brands now: `releaseHoldForCancellation`, `releaseHoldForRevert`
(`lib/settlement/holdRelease.ts`), `submissionForRow` (`lib/settlement/legacy.ts`) and whatever it reaches that writes,
and the `return_labels` insert (`db/queries.ts:817`). Revert-and-fail: a customer handler calling an unbranded writer of
`orders` fails the test, naming the call chain.
**§4 `saveAddress`:** `zip` is optional (as today); required: `name`, `address1`, `city`.
**Accepted implementation deviations:** `publicFormAction` strips React's `$ACTION_*` fields before the strict parse;
`callAction` is the hook `useCallAction()`; tracking input caps 1000/4000 so the domain refusals (`too-long`,
`invalid-url`) answer instead of `invalid-input`; `saveShippingFee` input `{country, band: number, returnFee, exchangeFee}`;
lookup keys `lookup.notYetShipped`, `lookup.outsideWindow`; `saveAddress` may answer `not-editable`;
`refundOrderPayment` and `pinSelfTracking` unbranded (no DB write, shared with admin).
**§Enforcement 6, raw reads (Santi, 2026-11-25).** Two reached functions are read-only raw SQL shared with settlement
admission and admin approvals: `lib/settlement/ledger.ts#submissionOfRow`, `#standingReconciliations`. Branding them
would change `admit()`; rewriting them would change money-path SQL. Instead, `readQuery(statement)` in `db/drizzle.ts`
runs a statement through the Neon driver's own `transaction([...], { readOnly: true })` (a Postgres `READ ONLY`
transaction, so the database refuses any write). Both functions call `readQuery` instead of `db.execute`; SQL text and
signatures unchanged. Rule 6 counts a call through `readQuery` as a read. Test: a write statement through `readQuery`
is refused by Postgres (pg16 test DB). Revert-and-fail: switch one back to `db.execute` → rule 6 fails naming it.
**§Enforcement 6, final mechanism (after Codex fix-check, 2026-11-25).** Resolving every call and failing closed on
unresolved ones is unworkable (26 unresolvable sites on real code, 0 writes: `any` method calls, typed calls through
data structures). Rule 6 therefore walks **value reachability**, not call resolution: a function is reachable when its
value is referenced from reachable code (references, initializers, class members, and every store into a referenced
variable anywhere in the app's modules, incl. `m.set(k, f)` / `a.push(f)`). Roots: every exported function value under
`handlers/customer/**`, typed or not. A write = a call resolving to drizzle's own insert/update/delete/execute, or any
reference reaching `transact` or the bare db handle. Fails closed when a function is stored where no symbol can find it,
or an exported handler's implementation cannot be found. Limits: flow-insensitive (over-approximates); no `eval` or
computed dynamic `import()`; stores in `tests/` and `scripts/` are out of scope (separate processes). Commit `2e309e0`.

## 11. Rule 6 is a type, not an analysis (Santi, 2026-11-25) — supersedes every §Enforcement 6 text above
Three static-walk versions of rule 6 were each bypassed (Codex: module-level destructuring, `namespace["x"]`, memoised
stores in 2e309e0). Proving "no customer path reaches an unchecked write" by analysing TypeScript cannot be made sound.
The foundation removes the ability instead, and `tsc` enforces it for all code:
- `db/drizzle.ts` no longer exports a writable handle. Its default export is a **read handle** typed without
  `insert`/`update`/`delete`/`execute`/`transaction` (relational `query.*` and `select` stay); raw reads use `readQuery`.
  The raw Neon `sql` function is not exported.
- `writeDb(cap: WriteCapability)` returns the full Drizzle handle plus `transact`. `WriteCapability` =
  `VerifiedOrderId | VerifiedSubmission | AdminTarget | SystemTarget | LookupTarget` — each minted only where §1 says.
  Every write site in the app takes its handle from the capability it already holds (customer handlers: the session's;
  webhooks: the signature's; admin: `adminTarget`; crons and settlement: `systemTarget(job)` minted at the cron entry,
  passed down). No money logic changes; only where the handle comes from.
- The two non-customer tables (`ops_alerts`, `lookup_attempts`) are written only by `db/opsAlerts.ts` and
  `db/lookupAttempts.ts`, which obtain a handle via `tableWriter("ops_alerts" | "lookup_attempts")`. A symbol-reference
  test asserts `tableWriter` is referenced from exactly those two files (direct symbol references are sound: an alias
  must reference the symbol first).
- `tests/actionBoundary.test.ts` rule 6 (the reachability walk) is deleted. Its proofs become type tests:
  `@ts-expect-error` on `db.insert(...)` / `db.execute(...)` from the read handle, on `writeDb("123")` with a plain string,
  and a revert-and-fail where `writeDb` accepts `string` → those type tests fail.
- Rules 1–5, the manifest test, `orderScope`, `submissionScope`, `readQuery` and the race fix are unchanged.

### §11 decisions (Santi, 2026-11-25: G1–G4 all A)
- **G1** `verifiedByAmphoraSecret(order)`: a new order mint, only caller `app/api/webhooks/amphora/route.ts`, after its
  existing `X-Secret` check. (Ownership by `payload.name` is still F4's to replace.)
- **G2** Delete the finished one-offs `scripts/backfill-refund-transactions.ts`, `scripts/seed-shipping-fees.ts`,
  `scripts/seed-shipping-fees-by-country.ts`. `systemTarget` may also be called from `scripts/**`, with a test that no
  module outside `scripts/` and `tests/` imports from `scripts/`. Scripts run with `--conditions=react-server`.
- **G3** Overloads on the existing symbols: `systemTarget(job): SystemTarget` / `systemTarget(id, job): VerifiedOrderId`;
  `adminTarget(ctx): AdminTarget` / `adminTarget(id, ctx): VerifiedOrderId`. Caller rules unchanged.
- **G4** No `LookupTarget`: `WriteCapability = VerifiedOrderId | VerifiedSubmission | AdminTarget | SystemTarget`.

### §11 threat model (Santi, 2026-11-25, after Codex review of f0578ff)
F1 guards against **untrusted clients** and **developer mistakes**. It does not claim to stop deliberately hostile code
inside the server process; the database is the only real boundary for that.
- Fixed in F1 (Codex #2): `tableWriter` is replaced by **table-bound writers**: `db/opsAlerts.ts` and
  `db/lookupAttempts.ts` receive operations bound to their own table only (no table argument, no raw `execute`, no
  transaction/session handle). Negative type test: writing `orders` through either is a type error.
- Fixed in F1 (Codex #4): handlers never mint. `adminAction` mints `AdminTarget` from the authenticated session inside the
  factory and passes it in `ctx`; handlers receive an opaque capability, never a `{ admin }` object they could fabricate.
  Same for the other factories and capabilities. Rule 4's caller list shrinks accordingly.
- Moved to F2 (Codex #1, #3: mutable prepared queries and namespace-indexed mint calls by hostile code): **Postgres
  roles**: a SELECT-only role behind the read handle, a role limited to `ops_alerts`/`lookup_attempts`, and the writer
  role behind `writeDb`, each with its own connection string. Recorded in the parent plan's F2.

### §11 as built (2026-11-25) — supersedes the `tableWriter` wording above
`tableWriter` does not exist. The ops tables are written through `opsAlertsWriter` / `lookupAttemptsWriter`
(`db/drizzle.ts`): `insert`/`update`/`delete` bound to their table, no table argument, no `execute`/transaction; each is
referenced only from its own module. `adminAction` mints `AdminTarget` and passes `AdminContext { target, order(id) }`;
handlers never mint (exception by design: the lookup handler is the credential check and calls `verifiedByLookup`).
`adminTarget(session)` / `adminTarget(id, admin)` callable only from `lib/server/actions.ts`; `systemTarget` only from
`app/api/cron/**` and `scripts/**`. Commits: 3dfc64e, f0578ff, c4ec155, c96c963, 5a17324. Codex: no money-logic change;
#2/#4 resolved; limit-0 regression fixed with a bound `sql.placeholder`.

## 12. Verification log (2026-11-25, local F1 @ bcb9657 against Neon branch `f1-e2e`, senders disabled)
- Crons (all 6): no secret → 401, wrong secret → 401. `/api/shipping-status` anonymous → 401 `private, no-store`.
- Browser, 9/9 PASS: lookup (wrong email → i18n `mismatch`, nothing written); fresh size exchange offers in-stock sizes,
  sold-out disabled; cross-product exchange saved with the new variant; clear restores the row; address saves with empty
  postcode, refuses empty city server-side; stale tab → "Has abierto otro pedido en otra pestaña…", nothing written to
  either order; cleared session → `/?session=expired`, nothing written; dashboard + shipping-fees redirect to /login when
  logged out; fee edit saved and restored; no `[action-error]`/`[client-error]`.
- Pre-existing on main, not F1: lookup inputs' `pattern` attributes are invalid under the `v` flag (no browser-side
  validation); `formSelectSize.tsx` hard-codes English "Select a size"/"This field is required".
- Real free return, #38594 (owner's order, window exemption in the scratch worktree only, never committed; DB = branch,
  Postmark/Correos/Amphora real, Stripe off), 23:19Z: submission accepted (refund, net 2300), Shopify R4 OPEN, Correos
  PQAZXT9800007210128110P, Amphora EXTERNAL pre-registered, label email Delivered. Cancel through the portal: submission
  cancelled, row reset, R4 CANCELED, Amphora cancel ran (no abort), cancel email Delivered. PASS.
- Preview `shameless-returns-2d68n1fph` (anonymous, twice): 401 `private, no-store`, `x-vercel-cache: MISS`. Admin 200 also
  `private, no-store` (local). PASS.
- Side effect: Amphora's webhook for the branch-only return reached PRODUCTION (main) and matched by order id, writing
  locator/carrier/carrier_url/return_status APROVED/last_tracking_* onto prod `orders` #38594 and sending "Tu recogida está
  programada". Pre-run values (Neon point-in-time read at 23:10Z): all NULL, nudge 0. Root fix is F4's "resolve webhook
  events through the persisted Amphora return id → shipment" (prod has no shipment for it → ignored); the same applies to
  F2's per-preview Neon branches.
  Restored with Santi's OK (2026-11-25): one UPDATE by id guarded on the test locator; prod row now equals the 23:10Z read.
- Pre-existing on main, not F1: cancel is not offered for ~5 min after booking (`cancelEligibility` → `carrier-unreadable`
  while Correos has not registered the label yet); the cancel panel promises a refund on a return nothing was paid for.
