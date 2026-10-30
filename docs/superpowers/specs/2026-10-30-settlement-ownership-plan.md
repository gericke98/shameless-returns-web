# Settlement ownership: obligations fixed at submit, executed exactly once

Status: DRAFT v2. Tier: **HEAVY** (money, Shopify returns/orders, migration). Base sha: `87d3337`.

History:
- Codex r1 (1 of 2): NOT AGREE, 12 findings, in `…-codex-r1.md`.
- Santi, 30 Oct, chose **A: obligations at submit**.
- v2 answers every r1 finding; the finding numbers appear in brackets, for example [F3].

Unblocks: the short-receipt Phase 2 redraft, where withdrawal cancels an obligation.

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

**Reviewer: judge FOUNDATION vs PATCH per mechanism (M1–M8). Not done while any is PATCH.**

## Primitives (rule 2)

- **Postgres** provides the ownership:
  - unique constraints;
  - single-statement CTEs;
  - neon-http's non-interactive `sql.transaction([...])`. Interactive `db.transaction(async)`
    throws on neon-http, so it is never used [F12].
- **Shopify** provides the effects:
  - `refundCreate @idempotent(key:)`. The key is retained for **24 h**, then a replay is a new
    request [F2].
  - `returnProcess`, whose dispositions and auto-close are Shopify's own completion: "a Return will
    automatically close when all items have been processed and a disposition decision is made".
  - `giftCardCreate(code)`, where the code must be 8–20 alphanumeric characters, and the
    `ReturnErrorCode.TAKEN` error.
  - `Refund.transactions.status`.
- **LangGraph** Functional API: its own docs require that external effects be idempotent and
  supply no cross-process ownership of a Shopify mutation. So it adds nothing here beyond
  Postgres, and its orchestration doesn't fit this cron + server-action app. Checkpoints, Store,
  Deep Agents, middleware and LangSmith don't fit for the same reason.

## Root causes (unchanged from v1, plus R5)

- **R1** No identity: settlement finds a line by variant, ignores `confirmed`, and trusts the
  caller's object.
- **R2** No ownership: money moves before anything durable says "in flight".
- **R3** We call `returnClose` instead of letting Shopify close the return.
- **R4** The amount is recomputed at settlement.
- **R5** The customer's agreement is never stored. It lives only in the portal render and the
  Stripe session, so settlement cannot honour it:
  - the fee is shown once per basket (`lastWindow.tsx:72`, `payments.ts:61-73`) but deducted per
    line;
  - credit is shown ×1.15;
  - a refund line in a mixed basket already offset the exchange upgrade at checkout
    (`basket.ts:128`), and settlement refunds it again [F9];
  - the confirm write itself keys rows by `variant_id` (`updateOrder.ts:573`).

## Mechanisms

**M1 Submission agreement, written at submit** [F9, F10] (migration 0006, additive).

- `updateFinalOrder` is the single place a submission becomes final; both the free path and the
  Stripe webhook call it. Before it writes `confirmed`, it computes the agreement **with the same
  functions that produced the shown total**: `valueBasket`, `resolveFee`, and the SELF subtraction.
- It persists that agreement:
  - `return_submissions`:
    - `id uuid`;
    - `order_id`;
    - `shopify_return_id UNIQUE`;
    - `tender` (`refund|credit`);
    - `credit_rate` (1.15 or 1);
    - `return_value_cents`, `replacement_value_cents`, `fee_cents`, `net_cents`;
    - `stripe_payment_intent` (null when nothing was charged);
    - `currency`, `fee_table_version`, `parcel_grams`, `return_method`, `created_at`.
  - `line_obligations`:
    - `productsorder_id UNIQUE`;
    - `submission_id`;
    - `kind` (`pay|replace`);
    - `line_total_cents`;
    - `quantity`;
    - `amount_cents` (what this line pays, in tender units);
    - `state` (`open|settled|withdrawn`).
- The amounts are written as **explicit integer cents**:
  - `line_total_cents = round(price × quantity × 100)`, computed once, so quantity counts
    [latent qty bug].
  - **Allocation rule (recorded, not inferred):**
    - The submission's money is `net_cents` when it is above 0, and zero otherwise; in the zero
      case Stripe was paid and no `pay` line gets money.
    - That total is split across `pay` lines **in proportion to `line_total_cents`**, using
      largest-remainder cents. The sum equals `net_cents × credit_rate` exactly.
    - The rare remainder tie is broken by `productsorder.id`, a stable explicit id, so the
      allocation is reproducible.
    - The allocation is stored once and never recomputed. That is what makes it data, not a
      tie-breaker applied at payment time.
  - `replace` lines carry `amount_cents = 0` plus the `new_variant_id` and quantity to ship.
- The confirm write in the same statement batch now keys rows by `productsorder.id`, not
  `variant_id`.
- `reset`/`anular` (`queries.ts:1777`, `updateOrder.ts:170`) refuse a line whose obligation is not
  `open` or that has a non-terminal operation [F12].

**M2 Operations ledger** [F1, F8, F12]. Table `settlement_operations`, one row per external effect:

- Columns:
  - `id uuid`, which is also the effect key;
  - `kind` (`refund|gift_card|exchange_order|replacement_refund|process_lines`);
  - `scope_key UNIQUE`: `pay:<productsorder_id>`, or `exchange:<submission_id>`, or
    `process:<productsorder_id>`;
  - `members int[]` (immutable, copied from the obligations);
  - `request jsonb`: the exact frozen mutation variables [F2];
  - `owner uuid`, `generation int`, `lease_until`;
  - `dispatched_at`;
  - `state`:
    - `claimed → dispatched → effect_confirmed → done`;
    - or `rejected`: Shopify returned a userError, the effect provably did not happen, and the
      operation is re-claimable;
    - or `unresolved`: it may have happened and nobody may resend;
  - `effect_ref`, `error`, timestamps.
- Exchange membership comes from the submission's `replace` obligations, so it is immutable and
  one order is the scope [F1].
- **Claim** is one statement: `INSERT … ON CONFLICT (scope_key) DO NOTHING RETURNING`, carrying
  `owner` and `generation = 1`.
- **Takeover** is allowed only for `claimed` operations, which were never dispatched, after
  `lease_until`. It is one `UPDATE … WHERE state='claimed' AND lease_until < now() RETURNING`
  that bumps `generation`. Every later write is fenced on `(id, owner, generation)`.
- **A `dispatched` non-idempotent operation is never re-sent by anyone** [F1, F6]. Recovery may
  only *find* it.
- Completion is one CTE. It sets the operation `done`, the obligations `settled`, and
  `productsorder.refunded = true`; that last column stays the read model for every existing
  reader.

**M3 Per-effect contract** [F2, F5, F6, F11]. Each row lists the effect, then what counts as done,
then how recovery works after `dispatched` without a recorded result.

- **refund** (`pay`, tender refund):
  - Effect: `refundCreate @idempotent(key: op.id)` on the order, using the frozen transaction,
    gateway, amount and currency.
  - Done when: a `Refund` whose transactions include one with `status = SUCCESS` for exactly the
    frozen amount. `PENDING` / `AWAITING_RESPONSE` → stays `dispatched`, re-read next run. A
    `FAILURE` / `ERROR` transaction → `unresolved` [F5].
  - Recovery: inside 23 h of `dispatched_at`, replay the frozen request (Shopify returns the
    original). After that → `unresolved` + ops alert, and no resend.
- **gift_card** (`pay`, tender credit):
  - Effect: `giftCardCreate(code)`. The code is 16 alphanumeric characters from
    `crypto.randomBytes`, stored in `request` at claim.
  - Done when: a card exists with that code and the frozen value.
  - Recovery: replay with the same code. `TAKEN` → `giftCards(query: code)` must return exactly
    one card with the frozen value, and then it is done. Zero, several, or a mismatch →
    `unresolved`.
- **exchange_order**:
  - Effect: `orderCreate`, with `sourceIdentifier = op.id` and the frozen lines and quantities.
    Today it ships quantity 1 (`queries.ts:949`); v2 ships the obligation's quantity [F10].
  - Done when: the order id is returned.
  - Recovery: `orders(query: "source_identifier:<op.id>")` must return exactly one order whose
    line variants and quantities equal the frozen ones. Anything else → `unresolved`. **A negative
    search never authorises a resend.**
- **replacement_refund**:
  - Effect: as the refund row, on the root order.
  - Done when: as the refund row.
  - Recovery: as the refund row (the 24 h window).
- **process_lines** (goods):
  - Effect: `returnProcess`, with this line's `return_line_item_id`, its quantity, and a
    `NOT_RESTOCKED` disposition. **No financial transfer.**
  - Done when: `processedQuantity = quantity`. This is goods evidence only, never payment evidence
    [F5].
  - Recovery: re-read `processedQuantity`. If unchanged, it is safe to resend, because the
    operation moves no money.

Further rules for M3:

- **Money and goods are separate operations.** A line is `settled` only when its pay or exchange
  operation is `done` AND its `process_lines` is `done`.
- `NOT_RESTOCKED` reproduces today's inventory effect, which is a fact: `returnRefund` is sent
  without restock, and `returnClose` restocks nothing. Amphora owns the physical stock. The first
  live settlement of each lane is checked in Shopify's inventory history [F11].
- The native-exchange route (`NATIVE_EXCHANGES`, off) stays out. With it off, `orderCreate` is the
  only exchange fulfilment.

**M4 Shopify closes returns** [R3, F8, F11].

- `returnClose` is deleted. A return closes when its last line is processed with a disposition.
- `receiptObservation` and the auto-approve gate stop treating a CLOSED return as settled: they
  read obligations instead.

**M5 Settle by obligation id** [R1, F4].

- Entry point: `settleObligation(productsorderId, actor)`.
- Re-read and require: the obligation is `open`, the line is `confirmed`, and both `return_id` and
  `return_line_item_id` are present.
- The lane comes from the obligation and the submission:
  - `replace` → exchange (the whole submission scope);
  - `pay` + credit → gift card;
  - `pay` + refund → refund on the order, or on the root when `orders.exchange_of` is set.
- Nothing is read from the caller's object.

**M6 One money boundary** [F4].

- These helpers move into `lib/shopify/settlementEffects.ts` (`import "server-only"`, NOT
  `"use server"`): `createGiftCard`, `processGiftCardReturn`, `createOrder`, `createRefund`,
  `refundOnOrder`, `createStoreCreditRefund`, `closeReturn`.
- Its single export is `runOperation(op)`, which refuses an operation the caller doesn't own at the
  current generation.
- The build inventories every export of each `"use server"` module that moves money or mutates
  Shopify. It removes them, or proves each one is admin-guarded, with a grep listing in the PR.

**M7 Recovery is its own job** [F8].

- `/api/cron/settlement-recovery` runs every 15 minutes, gated only by `CRON_SECRET`.
- It drives every non-terminal operation (`claimed` past its lease, `dispatched`,
  `effect_confirmed`) to its next state, with no admission rules: Shopify status, cap and
  `AUTO_APPROVE_ENABLED` don't apply.
- An `unresolved` operation goes to the outbox once: `settlement-unresolved:<op id>`.
- Auto-approve only *admits* new obligations. The dashboard and the cron report `paid`,
  `goods-pending`, `in-flight`, `unresolved` or `refused`. The cron's "NO money moved" text is
  used only for `refused`.

**M8 One Shopify API version** [F6 inventory].

- `SHOPIFY_API_VERSION = "2026-04"` for every GraphQL call (19 sites), each validated with the
  Shopify skill's `validate.mjs`.
- The 2 REST sites (`queries.ts:278,296`) move to the same version and are checked against the
  REST reference by hand. They are listed in the PR.

## Legacy and cutover [F3, F7]

- **Backfill (one-time script, dry-run first, output reviewed by Santi before `--write`).** For
  each of the 113 pending lines, one submission and its obligations are recomputed with today's
  fee table and **marked `provenance='legacy'`**. A CSV lists, for each line:
  - today's formula amount;
  - the new obligation;
  - existing evidence: `gift_card_id`, Shopify refunds on that return line, and the replacement
    lane's `refunded=true` without a root refund.
- Lines with evidence of payment become `settled`, with the effect imported. Ambiguous lines become
  `unresolved` for Santi. Nothing is inferred from notes or amounts.
- **Cutover:**
  1. Migration 0006.
  2. Set `AUTO_APPROVE_ENABLED=false`.
  3. Deploy outside 06:30–07:30 UTC.
  4. Wait out the old deployment's `maxDuration` (300 s), so no old settlement invocation is still
     running.
  5. Run the backfill with `--write`.
  6. Arm.

  The dashboard settle button and the old code path are removed in the same deploy.
- **Rollback** is allowed only with `AUTO_APPROVE_ENABLED=false` and zero non-terminal operations,
  because the old code ignores the ledger.

## Decisions for Santi (my recommendation first)

- **D1 Allocation of the net across pay lines.**
  - A: proportional to line value, largest-remainder cents. The fee and any upgrade offset are
    shared fairly, and a withdrawn line takes its own share with it.
  - B: the whole fee and offset sit on the highest-value pay line.
- **D2 A legacy line whose new obligation is lower than today's formula** (for example a
  multi-line return that was over-deducted, or over-paid).
  - A: pay the obligation, which is what the customer was shown.
  - B: pay the greater of the two.

## Tests

- **Real Postgres 16** (local, TCP 55432) for the concurrency tests [F12]:
  - two parallel claims → one owner;
  - expired-lease takeover fences the old owner's write;
  - parallel exchange claims for one submission → one order;
  - `reset` during a claim refused.
- **PGlite** for state machines, at the Shopify boundary:
  - each state × each failure, including a crash after `dispatched`;
  - the 24 h window: replay before it, `unresolved` after;
  - `TAKEN` code;
  - search cardinality 0/1/2/mismatch;
  - transaction `PENDING`/`FAILURE`;
  - `process_lines` without money is not settled;
  - recovery runs when the return is CLOSED and auto-approve is disabled.
- **Agreement:** the obligations' sum equals the shown total for every fixture in the existing
  portal-total tests (`lastWindow`/`summary`), including credit ×1.15, SELF, mixed baskets with
  an upgrade, and quantity 2.
- Revert-it-and-watch-it-fail proof for each pinning test.
- `validate.mjs` for every operation.

## Out of scope

- Phase 2's customer answer: redrafted next, on obligations.
- Native exchanges.
- The webhook's order-number fallback.
