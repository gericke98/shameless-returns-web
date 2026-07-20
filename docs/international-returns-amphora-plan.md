# Plan — International Returns & Exchanges via Amphora

Status: **Draft** · Owner: Santiago · Last updated: 2026-07-08

## 1. Goal

Accept **returns and exchanges from international (non-ES) orders** inside the
Shameless returns-web app (the branded customer flow), delegating carrier
selection, customs, and **garment collection** to Amphora (our 3PL), while
Shameless owns the customer confirmation emails.

Spain (incl. Canary Islands / Ceuta / Melilla) continues on the existing
**Correos** flow (the CN23 customs fix shipped in `actions/shipping.ts`).

## 2. Context (from discovery, 2026-07)

- Amphora already fulfills Shameless orders **including international**, and is
  **already running international returns/exchanges** — 27 of 67 returns since
  Jan 2025 are non-ES (IT, AT, FR, SE, US, PT, NL, GB, DE, GR, DK); 18 are
  exchanges. These were created by **Amphora's own Shopify sync**, not by the
  returns-web app (`external_id` is null on all of them).
- We want to move the **initiation** into the returns-web app so international
  customers use Shameless's branded flow and get Shameless's emails.

### API facts

- **Company API**: `https://api.amphoralogistics.com/prod-integrations-api`,
  tenant segment `Shameless` in the path, auth `x-api-key`. Key lives in
  `shameless-agent/.env` (`AMPHORA_API_KEY`, `AMPHORA_TENANT_ID`). This key is
  **Company-API-scoped** — the E-Commerce API returns `403 Forbidden`.
- **Collection model**: Amphora arranges carrier + **pickup of the garment** —
  there is **no printable label** to send. Return objects carry
  `carrier`, `carrier_number`, `carrier_url` (a tracking URL, e.g. UPS/DHL).
- **Create return**: `POST /{tenant}/returns` — body `return_order` with
  `order_id` (Amphora internal id), `items[{sku, quantity}]`, `shop_name`,
  `external_id`, `time`, optional `customer_*`/`shipping_*`, `auto_approve`.
- **Order lookup**: `GET /{tenant}/orders?order_names=%23NNNNN` maps the Shopify
  order number (`#NNNNN`) → Amphora internal `order_id`. `shop_name` =
  `shameless-collective-madrid.myshopify.com`.
- **Exchanges**: no formal exchange-creation endpoint and no order→return link
  field. A **functional exchange = `createReturn` (inbound) + `createOrder`
  (outbound replacement)**, both on the Company API with our key. Formal
  `exchange_order_id` linkage (Amphora's "CHN" change record) is portal-only
  today — see Open Dependency D0.
- **SKU-based**: returns/orders use Amphora SKUs (e.g. `20240802`). Our
  `productsOrder` stores `variant_id`/`variant_title` but **not `sku`** → gap.
- **Status webhooks**: `ReturnPending/Approved/Travelling/Received/Exception`
  are Amphora→us notifications (E-Commerce API schemas); delivery to our
  endpoints uses an `X-Secret` header.

## 3. Routing principle

Dispatch at the return-creation step by `order.shippingCountry`:

- `ES` (incl. 35/38/51/52) → **Correos** flow (unchanged).
- non-`ES` → **Amphora** flow (this plan).

## 4. Open dependencies

- **D0 — Exchange linkage**: ✅ **Moot.** We never create an Amphora exchange
  order — the replacement is a normal Shopify order Amphora auto-fulfills.
- **D1 — Webhooks**: will Amphora POST return-status events to our endpoint?
  What URL + `X-Secret` do we register? (Optional — fills in tracking after the
  carrier is assigned; the return response may not carry it synchronously.)
- **D2 — SKU parity**: ✅ Resolved — Amphora SKU == Shopify `variant.sku`.
- **D3 — Shopify-return interaction**: ✅ Resolved — keep creating the Shopify
  return (Amphora does NOT sync returns from Shopify: verified #310443/#39613
  have Amphora returns but zero Shopify returns), and additionally call
  `createAmphoraReturn`. No duplication.
- **D4 — Amphora↔Shopify order sync**: the exchange replacement + all outbound
  orders reach Amphora via its Shopify order sync (evidenced by 629 synced
  orders). Confirm the replacement Shopify order is picked up for intl the same
  way (it should be — same pipeline as domestic).

## 4b. Verified during Phase 1 (2026-07-08)

- **`order_id` is derivable, no lookup needed**: Amphora order id = `"SHP " + Shopify legacyResourceId`, and our `orders.id` IS that Shopify id → `amphoraOrderIdFromShopifyId(order.id)`. (Verified: #39613→`SHP 12952047911238`, #310443→`SHP 13125264638278`.) `resolveAmphoraOrderId(name)` remains as a fallback but `/orders` has a retention window (older delivered orders age out), so prefer the derivation.
- **D2 resolved — SKU parity holds**: Shopify `variant.sku` == Amphora sku (verified #39613/`20250504`, #39848/`20261303`). Send Shopify variant SKUs to `createReturn`. (Portal-created exchanges show a `20200000` placeholder — irrelevant to API-created returns.)

## 5. Phases (gated)

| # | Phase | Success criteria |
|---|-------|------------------|
| 0 | **Confirm D0, D1, D3 with Amphora** (D2 resolved) | Answers documented; webhook URL/secret agreed |
| 1 | ✅ **Amphora API client + config** — `actions/amphora.ts` (`x-api-key`, tenant in path): `amphoraOrderIdFromShopifyId()`, `resolveAmphoraOrderId()`, `getAmphoraReturnsByOrderName()`, `createAmphoraReturn()`, `createAmphoraOrder()`. Env: `AMPHORA_API_KEY`, `AMPHORA_TENANT_ID`, `AMPHORA_COMPANY_API_URL`, `AMPHORA_SHOP_NAME` | ✅ Read-only calls verified against prod; order_id + SKU parity confirmed |
| 2 | ✅ **SKU sourcing** — `getVariantSkusByIds` in `db/queries.ts` (Shopify variant SKU == Amphora SKU) | Line items resolve to SKUs |
| 3 | ✅ **Routing + schema** — `isInternationalOrder` dispatch in `return.ts` + Stripe webhook, gated by `AMPHORA_INTL_RETURNS_ENABLED`; `carrier`/`carrier_url` columns added to `schema.ts` **and applied to prod DB** | ES flow unchanged (flag off); non-ES routed to Amphora |
| 4 | ✅ **International returns** — `createInternationalReturn(id)` (`actions/amphoraReturn.ts`): derive order_id → SKUs → `createAmphoraReturn(auto_approve)` → persist carrier/tracking. **Write path NOT yet executed against prod** (would create a real collection) | Code + typecheck done; live E2E pending (Phase 8) |
| 5 | ✅ **International exchanges** — **no new Amphora code needed.** Inbound = `createInternationalReturn` (collects the original item). Outbound replacement is already a Shopify order created by `validateReturn`→`createOrder` (uses `new_variant_id`), which **Amphora auto-fulfills** via its order sync. `createAmphoraOrder` in the client is unused (kept for future). D0 (formal exchange linkage) is **moot** — functionally the item is collected and the replacement shipped | Exchange = collection + replacement, both handled |
| 6 | ✅ **Confirmation email (we own)** — intl template in `amphoraReturn.ts`: "courier will collect", tracking + `carrier_url`, no PDF, bilingual, Postmark | Renders; live send pending Phase 8 |
| 7 | **Return-status webhooks (optional)** — host `X-Secret`-auth endpoint for `Travelling/Received/Exception` → update status | Transitions reflected in dashboard |
| 8 | **E2E + rollout** — set env vars, enable flag, run a controlled real intl return, then enable for customers | Verified collection + emails + tracking |

### Before deploy / enable
- **Env vars** (returns-web Vercel): `AMPHORA_API_KEY`, `AMPHORA_TENANT_ID` (`Shameless`), `AMPHORA_COMPANY_API_URL`, `AMPHORA_SHOP_NAME` (`shameless-collective-madrid.myshopify.com`), and `AMPHORA_INTL_RETURNS_ENABLED` (leave **off** until Phase 8).
- Prod DB already has `orders.carrier` / `orders.carrier_url` (applied 2026-07-08).
- Code typechecks clean (0 new errors); flag defaults off → deploying is behavior-neutral.

## 6. Key flows

**International return**
1. `orderId = resolveOrderId(order.name)`  (`GET /orders?order_names=#NNNNN`)
2. `createReturn({ order_id: orderId, items: [{sku, quantity}], shop_name,
   external_id: <our return id>, time, customer_*, shipping_*, auto_approve:true })`
3. Read `carrier`, `carrier_number`, `carrier_url` from the return; persist.
4. Email customer: return registered + courier collection + tracking.

**International exchange**
1–3 as above (inbound return).
4. `createOrder({ id, name, price, currency, shipping_*, items:[{sku:exchangeSku,
   quantity, price}] , metadata:{ exchange_for: <return/order ref> } })`
5. Link per D0; email customer: exchange registered + collection + replacement.

## 7. Risks / notes

- **Idempotency**: dedupe `createReturn` by `external_id` (our return id).
- **Double-return**: resolve D3 before wiring — don't create a conflicting
  Shopify return.
- **Unlinked exchange fallback**: if D0 has no linkage, reconcile return↔order
  by order name/metadata in our own DB; Amphora sees two records.
- **Auth scope**: only the Company API is available with the current key; do
  not design against the E-Commerce API.
