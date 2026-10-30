# Settlement ownership: one line, one owner, one effect

Status: DRAFT v1. Tier: **HEAVY** (money, Shopify returns/orders, migration). Base sha: `87d3337`.
Codex plan review: round 0 of 2. Unblocks: the short-receipt Phase 2 redraft (its withdrawal
becomes one more ledger state).

## Rules (verbatim, Santi)

1. Fix the root cause. Never a heuristic, tie-breaker, special case, flag, retry, regex over words,
   "until phase N" stopgap, or workaround for an existing weakness. If the root fix is bigger than the
   ask, say so and do the root fix (or stop and ask) — never ship the patch silently.
2. Before designing anything, read the official skills and docs for what already exists, and reuse
   it instead of rebuilding: Deep Agents (deep-agents-core/-memory/-orchestration), LangGraph
   (persistence, Store, checkpoints, human-in-the-loop, fundamentals), LangChain (middleware,
   fundamentals), LangSmith (evaluator, dataset, trace, code-eval, online-eval). Locations:
   `.claude/skills/` in the repo, the docs-langchain MCP. State in the design which official
   primitive you use, or why none fits.

**Reviewer: judge FOUNDATION vs PATCH per mechanism (M1–M6). Not done while any is PATCH.**

## Facts (read-only checks, 30 Oct)

- 113 pending (confirmed, unsettled) lines: 62 refund, 17 credit, 34 exchange. 10 Shopify returns
  hold >1 pending line, 6 returns mix lanes, 0 pending lines have quantity > 1.
- **#311208-R1 is the live shape.** It is OPEN with line 981 (SKU 20250504) processed and refunded,
  and line 982 (SKU 20250501, the short one) unprocessed.
- Shopify facts:
  - Source: the Admin 2026-04 schema bundled with the Shopify skill, plus the guide
    `shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-return-management`.
  - Of our mutations, **only `refundCreate`** accepts `@idempotent(key:)`. The key is optional from
    2026-01 and required from 2026-04; a replayed key returns the original result.
  - `returnRefund` is deprecated in favour of **`returnProcess`**.
  - `giftCardCreate`, `orderCreate`, `returnProcess` and `returnClose` take no key.
  - **"A Return will automatically close when all items have been processed."**
  - `giftCardCreate` accepts a caller-chosen `code`, and `giftCards(query:)` finds a card by its
    full code.
  - `orderCreate` accepts `sourceIdentifier` and `tags`.
- The repo pins `2025-01` (17 sites) and `2024-04` (2 sites). Both are unsupported, so Shopify
  serves the oldest supported version and we test against a schema nobody runs.

## Root causes

- **R1 No identity.** `settleReturnLine(product, order)` finds the row by (order, variant). It never
  checks `confirmed`. It takes the lane (`product.action`) and the refund-lane gate
  (`product.return_id`) from the caller's object.
- **R2 No ownership.** `refunded` is written *after* the money moves, and nothing records that an
  effect is in flight. A crash or an overlap pays twice: a second gift card, a second exchange
  order, or a second refund. Only the replacement lane claims first.
- **R3 We assert completion instead of following Shopify.** `returnClose` is called after the
  first settled line, so Shopify's own per-line processing never gets to close the return. A
  closed return hides its unprocessed siblings: the sweep reads `closed-in-shopify` and resolves
  them.
- **R4 The amount is recomputed per lane at settlement.** The credit lane deducts the whole
  parcel fee on every line. The refund lane deducts a hardcoded €5 on every line. Neither
  multiplies by quantity.

## Mechanisms

**M1 Settlement ledger** (migration 0006, additive). New table `line_settlements`:

- Identity:
  - `id uuid`;
  - `productsorder_id int UNIQUE`, so a line is settled at most once, ever;
  - `group_id uuid`, shared by the exchange lines that one order ships;
  - `lane` (`credit|exchange|refund|replacement_refund`).
- Frozen at claim: `shopify_return_id`, `return_line_item_id`, `quantity`, `unit_price_cents`,
  `fee_cents`, `amount_cents`.
- `effect_key uuid`: the idempotency key, the gift-card code seed and the order `sourceIdentifier`.
- `state`: `claimed → effect_done → done`, or `failed` (provably nothing happened), or `uncertain`
  (it may have happened).
- `effect_ref`: the gift card, refund or order gid.
- Also `actor` (`cron` | `dashboard:<user>`), `error`, `claimed_at`, `updated_at`.
- `productsorder.refunded` remains the read model that every existing reader uses. It is written
  in the **same SQL statement** that sets `state='done'` (a CTE). It is no longer written anywhere
  else in settlement.
- Primitive: Postgres unique constraint + `INSERT … ON CONFLICT DO NOTHING RETURNING`, the same
  claim pattern as `ops_alerts`. LangGraph checkpoints and Store don't fit: there is no graph and
  no agent, and the state must live beside the rows it guards.

**M2 Settle by line id.**

- `settleLine(lineId, actor)` replaces `settleReturnLine(product, order)`. The dashboard
  (`validateReturn`) and auto-approve pass the row id, and nothing else.
- It re-reads the row and requires `confirmed=true`, `refunded` not true, and `return_id` plus
  `return_line_item_id` present.
- The lane comes from the row and the order: `credit` → credit; `action='CAMBIO'` → exchange;
  `orders.exchange_of` set → replacement_refund; otherwise refund.
- The return-leg fee comes from `orders`, never from the caller.

**M3 Claim → effect → record, with a keyed recovery read for each effect.** The steps:

1. Claim (M1). The loser gets one of three outcomes:
   - `done` → `already-settled`;
   - `claimed` or `uncertain` older than the lease (300 s) → it resumes through the recovery read;
   - otherwise → `in-flight`.
2. Recovery read **before** any money is sent, every time, keyed on explicit ids only:

   | Lane | Effect (2026-04) | Recovery read |
   |---|---|---|
   | refund | `returnProcess` on this `return_line_item_id` + quantity, `financialTransfer` from the row's `transaction_id` | `ReturnLineItem.processedQuantity = quantity` means it already happened |
   | credit | `giftCardCreate(code)`; the code is generated at claim and stored before the call. Then `returnProcess` the line with no transfer (this replaces the zero-transaction `returnRefund`) | `giftCards(query: code)`, then `processedQuantity` |
   | exchange (group) | `orderCreate`, `sourceIdentifier=group_id`, tag `settlement:<group_id>`. Then `returnProcess` the group's lines with no transfer | `orders(query: "tag:'settlement:<group_id>'")`, then `processedQuantity` |
   | replacement_refund | `refundCreate … @idempotent(key: effect_key)` on the root order (an official key; replaces the note-marker check). Then `returnProcess` on the replacement order | the replayed key returns the original refund |

3. A throw, timeout or 5xx after the request was sent sets `uncertain` and queues the outbox alert
   `settlement-uncertain:<id>`. The next attempt starts at step 2. A userError returned before any
   effect sets `failed`, and the line can be claimed again only through a fresh claim.

**M4 Shopify closes returns.**

- **We never call `returnClose`.** Each line is processed on its own, and Shopify closes the
  return when its last line is processed.
- The sibling of a short line keeps the return OPEN, which is exactly what the Phase 1 sweep needs.
- Phase 2's withdrawal uses `removeFromReturn`, which completes the same way.

**M5 The amount is explicit data, frozen at claim.**

- `amount_cents = unit_price_cents × quantity − fee_cents`.
- `fee_cents` follows D2. It is computed from the fee table and the `orders` row (zone, weight
  band, `returnMethod`).
- The `- 5` literal and the per-lane formulas are deleted. One function, `settlementAmount(row,
  order, feeTable)`, feeds every lane, and the frozen value is what gets paid.

**M6 One Shopify API version.** Per D1, a single `SHOPIFY_API_VERSION` constant. Every operation
we send is validated with the Shopify skill's `validate.mjs` against that schema. This is a
mechanical inventory: 19 sites, listed in the build.

## Decisions for Santi (my recommendation first)

- **D1 API version.**
  - A: one constant, `2026-04`, for the whole app now. Every query is re-validated, and the
    non-settlement queries are a mechanical diff.
  - B: settlement only now, the rest later. This leaves the unsupported pin in place.
- **D2 Return-leg fee per Shopify return.**
  - A: one fee per parcel, charged against that return's lowest line id. If that line cannot
    absorb it, the remainder goes to the next line by id. Explicit and deterministic.
  - B: per line, today's credit-lane behaviour. It double-charges multi-line returns.
  - Either way, **before building I check `createStripeUrl` and both portal totals** to confirm
    what the customer was shown, and the rule must equal that.
- **D3 Exchange inventory.** We need to keep today's stock effect: what `returnClose` does today
  versus `returnProcess` with a disposition.
  - A: first build step is a `returnCalculate` dry run plus a read of one already-closed exchange
    return's inventory history. Pick the disposition that reproduces today's effect, and record the
    evidence in the PR.
  - B: restock on process.

## Tests

- PGlite (real migration), at the Shopify boundary only:
  - claim race (second claim refused);
  - crash after claim, after the effect and after the record, each resuming through the recovery
    read with **no second effect**;
  - `uncertain` → recovery finds the effect → `done`;
  - mixed-lane return (#311208 shape): settling 981 leaves the return open and 982 pending;
  - exchange group of 2 → one order;
  - `confirmed=false` refused;
  - caller object ignored;
  - quantity 2 pays 2 units;
  - fee per D2.
- Each new test gets a revert-it-and-watch-it-fail proof.
- Every operation's query text is validated against the 2026-04 schema.
- `returnCalculate` dry run on a live pending return before the first deploy.

## Rollout

1. Santi applies migration 0006 (prod DDL via `!`) before the merge.
2. No backfill: lines already `refunded=true` are refused by the M2 guard.
3. Deploy with the `AUTO_APPROVE_MAX_PER_RUN=5` cap unchanged. Watch the first 07:00 run, plus one
   settlement per lane from the dashboard, end to end in Shopify.

## Out of scope

- Phase 2's customer answer and withdrawal: redrafted next, on this ledger.
- Portal display totals. They are only read for D2.
- The webhook's order-number fallback.
