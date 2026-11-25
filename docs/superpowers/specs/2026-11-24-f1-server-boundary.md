# F1: The server boundary is structural (spec, rev 3)

Base: `main` @ `cbbf980`. Branch: `feat/f1-server-boundary`. Parent plan: `docs/superpowers/plans/2026-11-24-foundation-plan.md`.
Tier: HEAVY (it fronts the submit, cancel and payment entry points). Rev 1: Codex CHANGES-REQUIRED (14 findings).
Rev 2: Codex CHANGES-REQUIRED (10 of 14 resolved; #7, #9, #12 open, #11 accepted as F4; new blockers 15, 16).
The 2-round Codex cap is reached. Rev 3 fixes #12 and 16 directly and writes the recommended option for #7, #9 and 15,
each marked **DECISION PENDING (Santi)** in §9 until chosen. No code before those three are decided.

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
| `verifiedByLookup(order)` (DECISION PENDING, option A) | order number + contact email matched against Shopify by `validateOrderDetails`, rate limit passed | `lib/server/handlers/lookup.ts`, after validation, **before** `saveOrderToDatabase` and `issueOrderAccess` (blocker 15) |
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

**Tracking claim (finding 9; DECISION PENDING, option A written).** "Accepted" alone is not "active": acceptance
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
6. **Customer handlers reach the database only through capabilities (finding 7; DECISION PENDING, option A written).**
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

## 9. Decisions pending (Santi) — Codex cap reached, so these are A/B, not a third review round
| # | Question | A (written in this rev, recommended) | B |
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
