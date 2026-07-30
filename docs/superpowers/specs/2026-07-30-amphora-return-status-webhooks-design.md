# Amphora return-status webhooks (Phase 7)

**Date:** 2026-07-30
**Status:** Approved design — pending implementation plan
**Author:** Santiago Gericke (with Claude)

## Context & driver

Order **#310972** (Portugal, exchange S→M, €15 paid) exposed the gap this closes.
The customer paid, the Shopify return and the Amphora collection were both
created — and then nothing. The confirmation email, when it was finally sent
manually, used the tracking-pending copy:

> "We will email you the tracking details as soon as the collection is scheduled."

**Nothing in the system can send that follow-up.** Amphora assigns the carrier
asynchronously, well after our request/response cycle has ended, and we never
look again. Both #310972 and #310761 sat at `APROVED` with `carrier: null` for
hours after approval with no mechanism to notice a carrier ever appearing.

Amphora already publishes the missing half: six return-status webhooks
(`return_to_pending` / `_approved` / `_travelling` / `_received` / `_finished` /
`_exception`), authenticated with an `X-Secret` header we define. This was
listed as Phase 7 in `docs/international-returns-amphora-plan.md` and never
built.

## Goals

- Send the customer their tracking as soon as Amphora assigns a carrier — the
  promise we already make in the collection confirmation email.
- Tell the customer when their return reaches the warehouse.
- Record where each international return actually is, so the dashboard reflects
  reality instead of going silent after creation.
- Never double-email a customer when a webhook is redelivered.

## Non-goals

- Real-time alerting. Exceptions are logged; the repo has no paging channel and
  adding one is separate work.
- Replacing the read-back in `createInternationalReturn`. That stays as the
  synchronous best-effort path; webhooks are the asynchronous catch-up.
- Acting on `PENDING` or `FINISHED`. Recorded as status only.

## Source of truth

Company API v1.3.0 — `https://api-docs.amphoralogistics.com/specs/company-api.yaml`
(public, no auth). Webhook payloads are `{ "fulfillment_return": ModelFulfillmentReturn }`.

Relevant payload fields, verified against the schema:

| Field | Use |
|---|---|
| `id` | `"SHP 13194624794950"` — our order id with an `SHP ` prefix |
| `name` | `"#310972"` — matches `orders.orderNumber` |
| `internal_status` | `PENDING`/`APROVED`/`TRAVELLING`/`PROCESSING_WAREHOUSE`/`RECEIVED`/`FINISHED`/`FINISHED_REJECTED`/`EXCEPTION`/`EXCEPTION_WAREHOUSE` |
| `carrier`, `carrier_number`, `carrier_url` | the tracking we owe the customer |

**There is no `external_id` on the webhook payload.** Every other part of this
codebase matches Amphora records by `external_id`; this one cannot. Note
`APROVED` is spelled with one `P` on the wire.

## Design

### Endpoint

`app/api/webhooks/amphora/route.ts` — a single `POST` handler for all six
events, dispatching on `internal_status` from the body. Amphora is given this
one URL for every event; if their console requires a URL per event, the same URL
is registered six times.

This is a new **unauthenticated public route**. `middleware.ts` matches only
`/dashboard` and `/login`, so it does not interfere — the shared secret is the
only thing in front of this endpoint.

### Authentication

`X-Secret` request header compared against `AMPHORA_WEBHOOK_SECRET` using
`crypto.timingSafeEqual`, after a length check (`timingSafeEqual` throws on
length mismatch). No parsing, no database access, no logging of the payload
before the check passes.

If `AMPHORA_WEBHOOK_SECRET` is unset the endpoint rejects everything: an
unconfigured deployment must be closed, not open.

### Matching to an order

1. If `id` starts with `SHP `, use the remainder as `orders.id`.
2. Otherwise match `name` against `orders.orderNumber`.
3. No match → log and return **200**.

Step 3 matters: returns created through Amphora's own Shopify channel fire these
webhooks too, and they are not ours. A non-200 would make Amphora retry an
unmatchable event indefinitely.

### Processing

```
if (order.returnStatus === payload.internal_status)  → 200, no-op        // redelivery
persist carrier/tracking + returnStatus                                  // FIRST
then send any triggered email                                            // best-effort
```

Status is persisted **before** the email is sent, so a redelivery can never
double-send. The trade-off is explicit: a failed email is not retried, so it is
logged at error level for manual follow-up. Losing an email loudly beats sending
it twice silently.

This mirrors the rule established in `createInternationalReturn` and
`createShippingLabel` after the #310972 incident: once external state exists,
failures are recorded, never propagated as "nothing happened".

### Email triggers

| Email | Condition |
|---|---|
| Collection scheduled (tracking) | `carrier_number` present **and** `orders.locator` was empty before this write |
| Return received | transition into `RECEIVED` |

The tracking trigger keys off the `locator` transition rather than a specific
status, because the carrier may first appear on `APROVED` or on `TRAVELLING` —
the marker is the tracking arriving, not which status carried it.

`EXCEPTION` / `EXCEPTION_WAREHOUSE` → `console.error`, no customer email.

### Emails

Two new pure builders in `lib/emails.ts`, following the existing pattern
(bilingual, single-language output, exchange-aware via `ExchangeInfo`):

- `buildCollectionScheduledEmail(name, locale, tracking, exchange)`
- `buildReturnReceivedEmail(name, locale, exchange)`

Reusing `buildAmphoraEmail` is wrong: it is titled "Your return was successfully
created", which the customer has already received.

### Schema

```sql
ALTER TABLE orders ADD COLUMN return_status text;
```

`returnStatus: text("return_status")` on `orders` in `db/schema.ts`. Nullable —
every existing row predates the column, and null simply means "no webhook seen
yet".

### Decomposition

The decision logic is a **pure** function:

```ts
decideWebhookActions(order, payload) -> {
  persist: { locator?, carrier?, carrierUrl?, returnStatus },
  emails: Array<"collectionScheduled" | "returnReceived">,
  noop: boolean,
}
```

No I/O, so the whole matrix — redelivery, first carrier, carrier already known,
received, exception, unmatched — is unit-testable without constructing an HTTP
request. The route handler stays thin: authenticate, parse, look up the order,
call the decider, execute its output.

## Testing

- `decideWebhookActions` — the full matrix, including that a redelivery emits no
  emails and that a second carrier update does not re-send tracking.
- Email builders — subject, single-language purity, exchange vs plain return,
  matching the existing `tests/emails.test.ts` conventions.
- Route handler — rejects a wrong/absent `X-Secret`, rejects when the env var is
  unset, returns 200 for an unmatched order, returns 200 and does no work on a
  redelivery.

## Deploy order (load-bearing)

1. Apply the migration to the production database.
2. Deploy the code that reads `return_status`.
3. Give Amphora the endpoint URL and the generated secret.

Reversing 1 and 2 makes every international return 500 on a missing column.
Step 3 last means the endpoint ships dormant: until Amphora is configured,
nothing calls it and it cannot affect live traffic.

## Open dependency

Amphora must register the URL and secret on their side. Until they do, no
webhook fires and both the tracking and received emails remain manual. This is
the one part of the work not in our control.
