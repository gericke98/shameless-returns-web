# Settlement foundation S3: legacy reconciliation and cutover

Status: PLAN v1 — APPROVED, decisions D1=A, D2=A, D3=A (Santi, 30 Oct), plus D4–D7 (Santi, 30 Oct, below). Tier: **HEAVY** (money, historical payouts). Base: `main` at `c830d3e`
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

`scripts/reconcile-legacy.ts` walks every **settled** confirmed line (`refunded = true`) that has no S2
operation (D5: pending lines are not R1's; they settle through S2 admission). It groups lines by
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
| **unpaid** | Settled, return processed or open, and no evidence after a complete read | goes on the approval CSV, see D2 |
| **ambiguous** | Several matches, unreadable, or recipient mismatch | `unresolved` operation + alert; a human runs `resolve-operation.ts` |
| **null-action** | No lane can be derived | listed with its Shopify return's state; a human decides (D3) |
| **needs-human** | No `return_id` / return line on the row: no identity to read evidence by (D7) | listed only; no write path takes it |

Rules for the script:

- Nothing is inferred from notes text, amounts alone, or row order. An amount is checked only after
  identity has already matched.
- It is idempotent: re-running it skips lines that already have operations.

## R2 — Past cheaper swaps (parent: "owed, paid in tender; past ones audited in S3")

**Superseded by D4 (Santi, 30 Oct: "You set each amount").** The fee in force on a line's confirmation
date is not recoverable, so nothing computes what is owed. For each settled exchange line (including the
ones R1 already recorded as paid by an exchange order) the CSV lists:

- `returned_cents` = line price × quantity, as the customer paid it;
- `replacement_cents` = the variant price on the created exchange order, read from Shopify;
- `fee_today_reference_cents` = today's fee for that return, labelled a **reference only**;
- the evidence status (`class`, `reason`, `effect_ref`);
- `approval_basis` and `approval_cap_cents` = `returned − replacement` (`swap`), or `returned` (`unpaid`).

Santi writes an approval file `productsorder_id,amount_cents,approved_by` and runs
`--approve-file <csv> --write`. Each amount must be an integer > 0 and ≤ its cap, re-checked on that run's
fresh reads; one bad row refuses the whole file. Per Shopify return, the approved lines become one accepted
`legacy` submission whose `pay_cents` is exactly the stated amount, and each approval is a
`settlement_approvals` row (migration 0010: line, submission, basis, amount, cap, approved_by, approved_at)
written in the same statement. The same input serves D2 (`unpaid`, no default amount).

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

- **D4 — R2 amount source (Santi, 30 Oct: "You set each amount").** The approver states each amount;
  nothing computes owed. See R2.
- **D5 — R1 scope (Santi, 30 Oct: "Reconcile settled lines only").** R1 classifies only `refunded = true`
  lines. Pending lines are untouched by R1 and keep settling through S2 admission.
- **D6 — an approved payment on a closed return (Santi, 30 Oct).** A `settlement_approvals` row is the
  explicit human finding, after a complete read, that nothing was settled outside the ledger. It replaces
  the OPEN gate for that line only; a line without one is still held `return-not-open`. Its money is never
  folded into a `returnProcess`: a `root_refund` on the paying order, or a gift card for credit. A
  `process_goods` operation is created only when the return is OPEN and the line is not processed at all
  (`processedQuantity = 0`); a processed line or a non-OPEN return gets none (Shopify would refuse it
  forever), and a partly processed line is held `approval-partly-processed`. An approved CAMBIO is money
  only: never a second replacement order. A `swap` approval may pass a `done` reconciled exchange_order
  record; nothing else passes a standing record.
- **D7 — a line with no `return_id` (Santi, 30 Oct).** Listed in the CSV as `needs-human`. No write path
  takes it: R1 records nothing for it, an approval and the legacy recorder refuse it (`not-confirmed`), D3
  refuses it, and admission holds `no-return`.

## Tests

- **R1 classifier, pure:** each lane × {evidence 0/1/2, recipient mismatch, wrong currency, unreadable,
  pagination}, plus grouping by `return_id`.
- **R1 `--write`, on PGlite with real migrations:** `paid` → `done` operation, idempotent on re-run;
  `ambiguous` → `unresolved` + alert; `unpaid` → nothing without approval.
- **R2 (D4):** the approval basis and cap per class (`unpaid` → returned; cheaper exchange → returned −
  replacement; anything else none); the approval file parsed strictly; amount > 0, ≤ cap, approver
  required, enforced in code and by 0010; `pay_cents` equals the stated amount; approval row written with
  its submission.
- **D5:** the R1 population is `refunded = true` lines only.
- **D6:** approved line on a CLOSED/CANCELED/DECLINED return → money only; OPEN + unprocessed → goods +
  money outside them; OPEN + processed → money only; partly processed → held; amount mismatch → held;
  approved CAMBIO → no exchange order; unapproved line beside it → `return-not-open`.
- **D7:** needs-human classification; no record, approval, legacy submission or D3 decision for it.
- **R3:** the webhook without `submission_id` → alert, nothing confirmed.
- **R4:** pricing reads `replacement_lines` only; a missing row refuses rather than falls back.
- Revert-it-and-watch-it-fail for each.

## Rollout

1. Deploy the R3/R4 code only after R1 `--write` has run, so the R4 refusal never meets an un-backfilled
   order.
2. Run R1 dry-run. Santi reviews the CSV, then R1 `--write`.
3. Apply migration 0010 (DDL before deploy). Santi writes the approval file; run
   `--approve-file <csv>` dry, then with `--write`: it records and admits the approved lines, and the
   ledger's recovery cron sends the payments.
4. Deploy R3/R4. Verify the Stripe open-session check first.
