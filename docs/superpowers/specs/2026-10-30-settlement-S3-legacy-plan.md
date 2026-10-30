# Settlement foundation S3: legacy reconciliation and cutover

Status: PLAN v1 — APPROVED, decisions D1=A, D2=A, D3=A (Santi, 30 Oct). Tier: **HEAVY** (money, historical payouts). Base: `main` at `c830d3e`
(S2 deployed 2026-10-30; migrations 0006–0008 applied; auto-approve armed).

Parent: `2026-10-30-settlement-ownership-plan.md`. Its post-r2 decisions are binding: no Codex plan round,
ONE Codex code review on the diff. S3 answers Codex r2 **#1** (the writer drain) and **#8** (the legacy
population), and S2's leftovers:

- the 6 null-action lines;
- historical native exchanges;
- the past cheaper swaps (parent: "audited in S3").

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

Reviewer: judge FOUNDATION vs PATCH per mechanism (R1–R5).

## Primitives

- **The S2 ledger** is the only way money moves; S3 adds **no** new writer.
  - Every payment S3 decides is owed becomes a `provenance='legacy'` submission and is admitted through
    `settleSubmission`.
  - Every payment S3 finds already made becomes a `done` operation, with its Shopify id as `effect_ref`
    and its evidence frozen.
- **Shopify reads** (2026-04, each validated with `validate.mjs`):
  - `Return.refunds{transactions, refundLineItems}`;
  - `giftCards(query)`, matched on customer, initial value and note;
  - `orders(query:"tag:…")` for pre-S2 exchange orders;
  - `Return.exchangeLineItems` for native exchanges.
- **Stripe** `checkout.sessions.list(status:'open')` for the drain.
- **LangGraph and friends**: n/a, as in S1/S2. This is a one-shot, operator-approved data reconciliation,
  not an agent workflow.

## Population (read-only, prod, 2026-10-30)

**Pending** — 111 confirmed, unsettled lines on 93 orders:

- by lane: 72 refund, 33 exchange, 6 with `action` NULL;
- 16 multi-line orders, 17 credit lines, 0 with quantity > 1, 0 without a `return_id`;
- 1 on a replacement order.

S2's D1 = A already pays every pending line that has an action, through a legacy agreement at admission.
**Not covered:** the 6 null-action lines (#35468, #36157, #35969, #36644, #36719, #38190).
`lib/settlement/legacy.ts` skips them, so they never settle.

**Settled** — 603 lines with `refunded=true`:

| Lane | Lines | Notes |
|---|---|---|
| Refund | 241 | |
| Exchange | 260 | |
| Credit | 69 | 55 carry a `gift_card_id`. NULL is valid: the id was write-only; see memory "gift card stamp". |
| `action` NULL | 33 | |

Also among the settled lines: 15 are on replacement orders, and 1 has no `return_id`.

`refunded=true` has been written before payment in at least two known ways, which is r2 #8:

- the replacement lane's claim, followed by a failed root refund that left the claim stuck;
- the dashboard marking rows from admin-side settlements (memory "refunded flag drifts").

So `refunded` is **not** evidence of payment.

## R1 — Reconciliation script (dry-run by default, CSV, then `--write` after Santi approves)

`scripts/reconcile-legacy.ts` walks every confirmed line that has no S2 operation. It groups lines by
`return_id`, the Shopify return, which is explicit identity: one return is one historical submission. For
each line it reads the Shopify evidence for its lane:

- **Refund lane:**
  - Look for a refund on its return whose `refundLineItems` names this order line, with a `SUCCESS` refund
    transaction.
  - For lines on a replacement order, look on the root order for a refund carrying the marker
    `[<return_line_item_id>]`.
- **Credit lane:**
  - Use the gift card in `gift_card_id` if it is set; its customer must match the order's customer.
  - Otherwise, search the customer's gift cards for one with `initialValue = (price − fee) × 1.15` and a
    note naming the order.
  - Exactly one match counts as evidence. Zero or two do not.
- **Exchange lane:**
  - Exactly one Shopify order tagged `Order <orderNumber>` + `Change` whose lines contain `new_variant_id`.
  - Or, for a native exchange, `Return.exchangeLineItems` naming it.

Each line is assigned one class:

| Class | Meaning | `--write` effect |
|---|---|---|
| **paid** | Evidence found, recipient and currency verified | `done` legacy operation (`effect_ref`, evidence); `refunded=true` |
| **unpaid** | Settled or pending, return processed or open, and no evidence after a complete read | goes on the approval CSV, see D2 |
| **ambiguous** | Several matches, unreadable, or recipient mismatch | `unresolved` operation + alert; a human runs `resolve-operation.ts` |
| **null-action** | No lane can be derived | listed with its Shopify return's state; a human decides (D3) |

Rules for the script:

- Nothing is inferred from notes text, amounts alone, or row order. An amount is checked only after
  identity has already matched.
- It is idempotent: re-running it skips lines that already have operations.

## R2 — Past cheaper swaps (parent: "owed, paid in tender; past ones audited in S3")

For each settled exchange line, the script computes:

- `returned` = line price × quantity, as the customer paid it;
- `replacement` = the variant price on the created exchange order, read from Shopify;
- `fee` = the return fee **from the fee table in force on the line's confirmation date**.
  - Fees are row-versioned since 2026-07-28. Before that date the flat-rate rows apply, and those are
    recorded in git (`db/fees` seeds).
- `owed = returned − replacement − fee`. It is listed only when greater than 0 and when no matching refund
  or gift card exists.

What happens to that list → **D1**.

## R3 — The drain: delete the pre-S1 Stripe path (r2 #1)

The webhook branch for sessions without a `submission_id` is deleted, together with `acceptLegacySession`
and `recordLegacySubmission`. Precondition, checked by the script and recorded in the PR: Stripe lists
**zero** open checkout sessions without `metadata.submission_id`. Sessions last at most 24 h, and S1
deployed on 2026-10-30.

A paid event for such a session arriving after deletion is a `payment-unbound:<session>` ops alert with
nothing confirmed. That is the same behaviour as S1's superseded-payment rule.

## R4 — Retire the fallbacks S2 kept for pre-S2 data

Once R1 has run `--write`, every confirmed line has an operation or a human decision. Then:

- `replacementOrigin.ts` tag/variant pricing for pre-S2 replacement orders is replaced by `replacement_lines`
  rows backfilled from the exchange-lane evidence: the order line id, the source productsorder, and
  funding = the Stripe top-up recorded on the original order's session, where one exists.
- The tag reconstruction is then deleted.
- `productsorder.gift_card_id` is dropped from reads; the column stays for history.

## R5 — The null-action lines (6 pending, 33 settled)

The script prints each one with its Shopify return state, refunds and exchange orders. Their handling →
**D3**. The source of the gap is already closed: S2 refuses row edits on lines in an accepted submission.

## Decisions (Santi, 30 Oct: D1 = A, D2 = A, D3 = A)

- **D1 — past cheaper swaps found owed.**
  - **A (rec.):** list them for you to approve line by line in the CSV. Approved lines are paid through
    the ledger in the customer's original tender.
  - **B:** pay every listed one automatically.
  - **C:** don't pay retroactively; only fix it going forward, which S2 already does.
- **D2 — "unpaid" lines found among those already marked `refunded=true`.**
  - **A (rec.):** the same approval CSV, then paid through the ledger.
  - **B:** pay automatically.
- **D3 — null-action lines.**
  - **A (rec.):** a human sets the action, from the customer's emails or Shopify. The pending ones then
    settle through the ledger, and the settled ones go through R1 like any other line.
  - **B:** treat them all as refunds.

## Tests

- **R1 classifier, pure:** each lane × {evidence 0/1/2, recipient mismatch, wrong currency, unreadable,
  pagination}, plus grouping by `return_id`.
- **R1 `--write`, on PGlite with real migrations:** `paid` → `done` operation, idempotent on re-run;
  `ambiguous` → `unresolved` + alert; `unpaid` → nothing without approval.
- **R2:** fee by confirmation date, using fixtures from both fee regimes; quantity; no evidence vs found
  evidence.
- **R3:** the webhook without `submission_id` → alert, nothing confirmed.
- **R4:** pricing reads `replacement_lines` only; a missing row refuses rather than falls back.
- Revert-it-and-watch-it-fail for each.

## Rollout

1. Deploy the R3/R4 code only after R1 `--write` has run, so the R4 refusal never meets an un-backfilled
   order.
2. Run R1 dry-run. Santi reviews the CSV, then R1 `--write`.
3. Pay the approved D1/D2 lines through the dashboard, which runs the ledger.
4. Deploy R3/R4. Verify the Stripe open-session check first.
