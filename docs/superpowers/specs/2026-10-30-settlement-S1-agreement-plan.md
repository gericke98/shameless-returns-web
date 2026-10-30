# Settlement foundation S1: the agreement is saved before checkout

Status: PLAN v1. Tier: **HEAVY** (money, checkout, migration). Base: `feat/settlement-ownership`.

Parent: `2026-10-30-settlement-ownership-plan.md`, whose "Santi's decisions after Codex r2" are
binding. Per Santi, there is no Codex plan round; ONE Codex code review on the diff.

S1 answers Codex r2 #4, #6, #7 and #11. **Settlement does not change in S1.** It keeps paying by
today's formula until S2 switches it to execute these obligations, so the live over- and
under-payments remain until S2 ships. S1 only makes the agreement exist, and makes it right.

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

Reviewer: judge FOUNDATION vs PATCH per mechanism.

## Primitives

- **Stripe Checkout:**
  - `client_reference_id` and `metadata.submission_id` bind a session to our record.
  - The `checkout.session.completed` fields `id`, `amount_total`, `currency` and `payment_status`
    are the payment evidence.
- **Postgres:**
  - a partial unique index (one awaiting submission per order);
  - conditional `UPDATE … WHERE state = … RETURNING` as the state transition;
  - neon-http `sql.transaction([...])` for the multi-statement writes. It is non-interactive, with
    no reads between statements.
- **LangGraph and friends:** n/a, for the parent plan's reason.

## Today (the defect)

- `returnFunction` → `createStripeUrl` prices the basket from the live rows. The session carries
  only `{id, isCredit}`.
- The webhook then confirms **whatever the rows say at payment time**, through
  `updateFinalOrder(id)`.
- Nothing ties what was paid to what was confirmed:
  - an edit in another tab, a fee-table change or a second session all slip through;
  - duplicate webhooks rely on the `return_id` guard alone.
- `matchReturnLineItems` and the confirm write key rows by `variant_id`.
- `valueBasket` counts one unit per line, while Shopify gets `quantity`.

## M1 — `return_submissions` + `submission_lines` (migration 0006, additive)

`return_submissions` columns:

- Identity and lifecycle:
  - `id uuid`;
  - `order_id`;
  - `state`: `awaiting_payment | accepted | superseded | abandoned`;
  - `created_at`, `accepted_at`.
- Choices:
  - `tender` (`refund|credit`);
  - `return_method`;
  - `currency` ('EUR', the shop currency; presentment is unchanged and out of scope).
- Fee and money, all in integer **cents**:
  - `return_leg_cents`, `outbound_leg_cents`, `charged_fee_cents` (the SELF subtraction already
    applied);
  - `returned_value_cents`, `replacement_value_cents`;
  - `net_cents` = returned − replacement − charged_fee;
  - `stripe_charge_cents`: `−net` when that is at least 50, else 0;
  - `waived_cents`: `−net` when 0 < −net < 50, the existing Stripe-minimum rule;
  - `owed_cents`: what we owe, in tender units. Zero unless `net_cents > 0`; then
    `creditTotal(net)` for credit, or `net` for refund.
  - `residual_cents`.
- Stripe: `stripe_session_id UNIQUE`, `stripe_payment_intent`.
- **`UNIQUE (order_id) WHERE state = 'awaiting_payment'`.**

`submission_lines` (one row per productsorder line in the submission):

- `submission_id`, `productsorder_id`, unique together;
- `shopify_line_item_id` (`productsorder.line_item`), `fulfillment_line_item_id`, `quantity`;
- `action` (`DEVOLUCIÓN|CAMBIO`), `new_variant_id` (CAMBIO only);
- `returned_cents` (line total), `replacement_cents` (line total, CAMBIO only);
- `pay_cents` (this line's share of `owed_cents`);
- `stripe_funded_cents` (this line's share of `stripe_charge_cents`, CAMBIO lines only);
- `return_line_item_id`, set at confirm.

Rules:

- All money is copied from one pure function, `buildAgreement(rows, catalogue, legs, method,
  tender)`. **`lastWindow.tsx`, `summary.tsx` and `createStripeUrl` call the same function.**
  The three copies of the arithmetic become one [r2 #11].
- **Line totals, not unit prices** [r2 #11]:
  - `returned_cents = round(price × quantity × 100)`, using the unrounded per-unit price stored
    today (`basket.ts:92-104`).
  - `replacement_cents` = the existing `replacementPriceForVariant` unit price × quantity, rounded
    once.
  - `valueBasket` sums line totals.
  - The display therefore changes for quantity > 1 lines (0 pending today) and for nothing else.
    Existing portal-total fixtures with quantity 1 must be byte-identical.
- **Credit rounding:** `creditTotal(net) = round_half_up(net × 115 / 100)` in integer arithmetic.
  The display shows that same number; today it shows `totalPrice * 1.15` formatted to 2
  decimals, the same value except at half-cent ties.
- **Allocation** [Santi: proportional, submission residual, no row ordering]:
  - `pay_cents = floor(owed_cents × returned_cents / returned_value_cents)` across **every** line
    in the submission, exchanged lines included. That is how a cheaper swap owes money (Santi:
    owed, paid in tender) [r2 #6].
  - `residual_cents = owed_cents − Σ pay_cents`, kept on the submission.
  - `stripe_funded_cents` is the same floor-proportional split of `stripe_charge_cents` over
    CAMBIO lines by `replacement_cents`. Its residual stays on the submission as part of
    `stripe_charge_cents`.
  - Conservation equations are asserted in `buildAgreement` and in a DB `CHECK`-equivalent test:
    - `Σ pay + residual = owed`;
    - `returned − replacement − fee = net`.

## M2 — Lifecycle

**a. Propose.** `returnFunction`, after locale and method are persisted:

- Builds the agreement from the rows **as they are now**.
- One `sql.transaction`:
  1. `UPDATE return_submissions SET state='superseded' WHERE order_id=$o AND
     state='awaiting_payment'`;
  2. `INSERT` the submission;
  3. `INSERT` its lines.
- If `stripe_charge_cents > 0`:
  - create the session with `client_reference_id = submission.id`, `metadata = {id, isCredit,
    submission_id}` and `unit_amount`s summing to `stripe_charge_cents`;
  - then `UPDATE … SET stripe_session_id` where `state='awaiting_payment'`;
  - then redirect.
- Otherwise, conditional `awaiting_payment → accepted`, then confirm (step c).

**b. Pay (webhook)** [r2 #4]:

- Find the submission by `metadata.submission_id`.
- Require all of:
  - `session.id = stripe_session_id`;
  - `amount_total = stripe_charge_cents`;
  - `currency = 'eur'`;
  - `payment_status = 'paid'`.
- Then `UPDATE … SET state='accepted', accepted_at=now(), stripe_payment_intent=$pi WHERE id=$s
  AND state='awaiting_payment' RETURNING`.
- **Zero rows** has two meanings:
  - already `accepted` by this same session: a duplicate delivery, so 200 and do nothing;
  - `superseded` or `abandoned`: the customer paid an old tab. Ops alert
    `paid-superseded:<session id>` (outbox) with the payment intent, and nothing is confirmed. A
    human refunds or honours it; no money moves automatically.
- Mismatched evidence → ops alert `payment-mismatch:<session id>`, and nothing is confirmed.
- Sessions without `submission_id` (created before deploy, valid up to 24 h) go through today's
  path unchanged, behind no flag: their metadata *is* the discriminator. That path is deleted in
  S3, once `stripe.checkout.sessions` lists none open.

**c. Confirm.** `updateFinalOrder(submissionId)` replaces `updateFinalOrder(orderId)`:

- It builds the Shopify return from `submission_lines` (by `fulfillment_line_item_id`), **not**
  from the live rows. It declares `return_leg_cents` as the return shipping fee, the value
  already computed.
- `matchReturnLineItems` keys by `fulfillment_line_item_id` [r2 #7].
- One `sql.transaction`:
  1. each `submission_lines.return_line_item_id`;
  2. each `productsorder` row **by id**: `confirmed, return_id, return_line_item_id,
     transaction_*, credit`, plus `action`/`new_variant_id` **copied from the submission**, so
     the rows equal what was paid for.
- The existing `return_id` idempotency guard becomes "the submission already has
  `return_line_item_id`s".
- The revert path stays as is. It refuses rows with a return, and the submission stays
  `accepted`. The free and paid paths keep their alerts.
- `reserveExchangeStock` reserves `new_variant_id × quantity` from the submission lines.

**d. Abandon.** An `awaiting_payment` submission whose Stripe session has expired is set to
`abandoned` by the existing 15-minute `amphora-sync` cron: a conditional UPDATE where
`created_at < now() − interval '25 hours'`. Stripe's session lifetime is 24 h, so that is a fact,
not a guess.

## Out of S1 (S2 / S3)

- Settlement reading `pay_cents`; operations; cancellation ownership (S2).
- Backfilling submissions for the 113 pending lines; deleting the legacy webhook path (S3).
- Presentment-currency refunds (unchanged).

## Tests

- `buildAgreement`, as pure tests:
  - every existing `lastWindow`/`summary`/`payments` fixture gives the identical total;
  - cheaper swap (€100 → €60, fee €5 → owed €35 on the exchanged line);
  - mixed upgrade offset;
  - credit at half-cent ties;
  - quantity 2;
  - SELF;
  - Stripe < €0.50 waived;
  - conservation over 10k random baskets.
- PGlite with migration 0006:
  - propose supersedes the old awaiting submission;
  - two parallel proposes leave one awaiting;
  - the webhook accepts once, the duplicate is a no-op, a superseded payment alerts, an amount
    mismatch alerts;
  - confirm writes rows by id from the submission even after the rows were edited after checkout;
  - abandon after 25 h only.
- Route: webhook with and without `submission_id`.
- Revert-it-and-watch-it-fail for the bind check and for confirming from the snapshot.

## Rollout

1. Santi applies 0006 via `!`.
2. Deploy. No backfill.
3. Verify the first real paid exchange and the first free return end to end, against the
   submission row, the Stripe session and the Shopify return.
