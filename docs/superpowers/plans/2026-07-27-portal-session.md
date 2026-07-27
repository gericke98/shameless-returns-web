# Portal Session for `/[id]` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a visitor to `/[id]` prove they own that order, so a client-supplied order id stops being sufficient to read a customer's PII or alter their return.

**Architecture:** A signed, stateless cookie issued at the point `getOrder` already proves ownership (order number + matching contact email), verified by the page and by each customer-facing server action. Pure crypto in one module, the `next/headers` layer in another, so the crypto is unit-testable without a request or a database.

**Tech Stack:** Next.js 14.2.4 App Router, React 18.3.1, Node `crypto`, Drizzle/Neon, vitest.

Spec: `docs/superpowers/specs/2026-07-27-portal-session-design.md`

## Global Constraints

- **Never gate `updateFinalOrder`, `createShippingLabel`, `createInternationalReturn`, `createSendcloudReturn`.** Each is called by both `returnFunction` (cookie present) and the Stripe webhook (no cookie, authenticated by signature). Gating any of them breaks every paid return. Each gets a comment saying so.
- Signing uses the existing `NEXTAUTH_SECRET`. No new env var, no schema change, no migration.
- Session lifetime is **2 hours, absolute** from issue. Not sliding.
- Rejection is **silent** on actions, and a **redirect to `/?session=expired`** on the page. Never reveal whether an order id is real.
- `redirect()` throws by design — it must stay outside any `try` that would swallow it, and any code that must run before a redirect must precede it.
- `crypto.timingSafeEqual` **throws** on a length mismatch. Length-check first. Reference implementation: `app/api/return-label/[parcelId]/route.ts:22`.
- Do not change the ownership proof in `validateOrderDetails`, return routing, admin auth, or `/dashboard`.
- Conventional-commit prefixes. Verify with `npx tsc --noEmit`, `npx next lint`, and `DATABASE_URL="postgres://u:p@localhost:5432/d" npm test`. `npm run build` is impossible here (no `DATABASE_URL`; `db/drizzle.ts` calls `neon()` at module scope).

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `lib/orderSession.ts` | Pure sign/verify. No `db`, no `next/headers`, no `Date.now()` — `now` is a parameter. Unit-testable in isolation. |
| `lib/orderAccess.ts` | Server-only `next/headers` layer: set the cookie, read the cookie. Thin by design. |
| `tests/orderSession.test.ts` | Full coverage of the crypto and the rejection cases. |

**Modified**

| Path | Change |
|---|---|
| `actions/order.ts` | Issue the session before **both** redirects |
| `app/[id]/page.tsx` | Verify, else redirect to lookup |
| `app/page.tsx` | Render the expired-session message |
| `lib/i18n/{es,en}.ts` | `lookup.sessionExpired` |
| `actions/return.ts` | Verify in `returnFunction`; exemption comment on `createReturnShipment`'s callees |
| `actions/updateOrder.ts` | Verify in `updateOrder`, `updateData`, `anularOrder`; `anularOrder` gains `orderId`; exemption comment on `updateFinalOrder` |
| `app/[id]/components/dialogForm.tsx` | Pass `orderId` to `anularOrder` |
| `actions/shipping.ts`, `actions/amphoraReturn.ts`, `actions/sendcloudReturn.ts` | Exemption comments only |

---

### Task 1: Pure session crypto

**Files:** Create `lib/orderSession.ts`, `tests/orderSession.test.ts`

**Produces:**
- `ORDER_SESSION_COOKIE = "return_session"`
- `ORDER_SESSION_TTL_MS = 2 * 60 * 60 * 1000`
- `signOrderSession(orderId: string, expiresAt: number): string`
- `verifyOrderSession(value: string | undefined, orderId: string, now: number): boolean`

- [ ] **Step 1: Write the failing tests**

Cover, at minimum: round-trip succeeds for its own order id; fails for a different order id; fails one millisecond past `exp`; succeeds one millisecond before; tampered payload fails; tampered signature fails; **wrong-length signature returns false rather than throwing**; empty string, `undefined`, and a value with no separator all fail; a session signed under a different secret fails; the payload is readable (asserting it is encoding, not encryption, so nobody later puts a secret in it).

- [ ] **Step 2: Run and confirm RED**

`DATABASE_URL="postgres://u:p@localhost:5432/d" npx vitest run tests/orderSession.test.ts` — expect `Failed to load url @/lib/orderSession`.

- [ ] **Step 3: Implement**

Payload `{ orderId, exp }` → JSON → base64url. Signature = HMAC-SHA256 of that exact encoded string, hex. Value = `` `${payload}.${sig}` ``.

Verify order matters: split on the **last** `.`; reject if either part is missing; recompute the HMAC; length-check then `timingSafeEqual`; **only then** parse the payload; reject if `exp <= now`; reject if `payload.orderId !== orderId`.

Read `process.env.NEXTAUTH_SECRET` inside the functions, not at module scope, so importing the module never throws. Throw a clear error if it is unset when actually signing.

- [ ] **Step 4: GREEN, then `npx tsc --noEmit`**

- [ ] **Step 5: Commit** — `feat: signed portal session tokens`

---

### Task 2: Cookie layer and issuance

**Files:** Create `lib/orderAccess.ts`; modify `actions/order.ts`

**Consumes:** Task 1. **Produces:** `issueOrderAccess(orderId)`, `hasOrderAccess(orderId)`

- [ ] **Step 1: Create `lib/orderAccess.ts`**

`issueOrderAccess` sets `ORDER_SESSION_COOKIE` with `httpOnly: true`, `sameSite: "lax"`, `secure: process.env.NODE_ENV === "production"`, `path: "/"`, `maxAge: ORDER_SESSION_TTL_MS / 1000`.

Comment why `"lax"` and not `"strict"`: the customer returns from Stripe Checkout by top-level cross-site navigation, and `"strict"` would withhold the cookie on that hop.

`hasOrderAccess` reads the cookie and delegates to `verifyOrderSession(value, orderId, Date.now())`.

- [ ] **Step 2: Issue it in `actions/order.ts`**

`getOrder` has **two** `redirect` calls — the order-exists path and the newly-saved path. Add `await issueOrderAccess(order.id);` immediately before **each**, after `validateOrderDetails` has passed. `redirect()` throws, so issuance must precede it.

- [ ] **Step 3: `npx tsc --noEmit`, `npx next lint`, full suite**

- [ ] **Step 4: Commit** — `feat: issue a portal session when a lookup succeeds`

---

### Task 3: Enforce on the page

**Files:** `app/[id]/page.tsx`, `app/page.tsx`, `lib/i18n/es.ts`, `lib/i18n/en.ts`

- [ ] **Step 1: Add `lookup.sessionExpired` to both dictionaries**

ES: `"Vuelve a buscar tu pedido para continuar."` EN: `"Please look up your order to continue."` Adding to one only is a build error — that guard is working as intended.

- [ ] **Step 2: Gate the page**

In `app/[id]/page.tsx`, before any fetch:

```ts
if (!(await hasOrderAccess(params.id))) redirect("/?session=expired");
```

Identical treatment whether the cookie is absent, expired, or names another order — the response must not distinguish a real id from a fabricated one.

- [ ] **Step 3: Show the message**

`app/page.tsx` reads `searchParams.session === "expired"` and renders `t.lookup.sessionExpired` above the form. Note this page already reads `cookies()`, so it is already dynamic.

- [ ] **Step 4: Typecheck, lint, full suite. Commit** — `feat: require a portal session to view an order`

---

### Task 4: Enforce on the customer actions

**Files:** `actions/return.ts`, `actions/updateOrder.ts`, `app/[id]/components/dialogForm.tsx`

- [ ] **Step 1: `returnFunction`**

Verify `id` at the top; return early if invalid. **The existing `redirect(url)` must stay outside the `try`** — check the current structure before editing and preserve it.

- [ ] **Step 2: `updateData` and `updateOrder`**

Verify `data.orderId`; return `prevState` / return early. Place the check before any DB access.

- [ ] **Step 3: `anularOrder` gains an order id**

```ts
export async function anularOrder(productOrderId: number, orderId: string)
```

Verify `orderId`, then scope by **both** columns:

```ts
.where(and(eq(productsOrder.id, productOrderId), eq(productsOrder.orderId, orderId)))
```

Update `dialogForm.tsx` to pass both — it has both in scope. Update `tests/anularOrder.test.ts`: the existing SQL assertions now expect both predicates, and the session check needs mocking.

- [ ] **Step 4: Exemption comments — do not skip this**

On `updateFinalOrder` (`actions/updateOrder.ts`), `createShippingLabel` (`actions/shipping.ts`), `createInternationalReturn` (`actions/amphoraReturn.ts`), `createSendcloudReturn` (`actions/sendcloudReturn.ts`): state that the function is reached from both `returnFunction` and the signature-verified Stripe webhook, that the webhook carries no cookie, and that adding a session check here would break every paid return.

- [ ] **Step 5: Typecheck, lint, full suite**

Then grep every customer-facing action and confirm each either verifies a session or carries an exemption comment. Report the list.

- [ ] **Step 6: Commit** — `feat: require a portal session for customer-facing writes`

---

### Task 5: Documentation

**Files:** `README.md`, the spec

- [ ] **Step 1: README** — a short section: what the portal session is, that it lasts 2 hours, that it is signed with `NEXTAUTH_SECRET`, and — most importantly — **which functions are deliberately exempt and why**, so nobody "fixes" the omission into an outage.

- [ ] **Step 2:** Mark the spec `Implemented — 2026-07-27`.

- [ ] **Step 3:** Full verification. Commit — `docs: document the portal session`

---

## Manual verification (owner — cannot be done here)

No database and no browser are available in this environment.

1. Look up a real order; confirm the flow still completes end to end.
2. Open `/{that id}` in a private window; expect a redirect to the lookup with the message, **not** the order page.
3. Complete a **paid** exchange through Stripe and back — this is the regression the exemption list exists to prevent. If the webhook path is gated by mistake, the payment succeeds and the return is never created.
4. Confirm the message renders in both languages.

## Self-Review Notes

Spec coverage: §1 → Task 1; §2 → Task 2; §3 → Task 2 Step 2; §4 → Task 3; §5 → Task 4 Steps 1-2; §6 → Task 4 Step 3; §7 → Task 4 Step 4; Verification → Task 1 Step 1.

Signature changes: `anularOrder` (1 arg → 2). One call site, `dialogForm.tsx`, plus `tests/anularOrder.test.ts`.

The highest-risk step is **Task 4 Step 4**. Everything else fails loudly; gating an exempt function fails only in production, only on paid returns, after the customer has been charged.
