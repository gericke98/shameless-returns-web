# Settlement foundation S2: an operations ledger, and settlement executes the agreement

Status: PLAN v1 — APPROVED decisions D1=A, D2=A. Tier: **HEAVY** (money, Shopify returns/orders/gift cards, migration). Base: `main` at `354963c`
(S1 deployed 2026-10-30, migration 0006 applied).

Parent: `2026-10-30-settlement-ownership-plan.md`. Its "Santi's decisions after Codex r2" bind this plan: no
Codex plan round, ONE Codex code review on the diff. S2 answers Codex r2 #2, #3, #5, #9, #10, #12 and the
open part of #7 (replacement funding). Legacy reconciliation (r2 #1, #8) stays S3.

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

Reviewer: judge FOUNDATION vs PATCH per mechanism (L1–L8).

## Primitives (rule 2), verified 2026-10-30 against shopify.dev 2026-04/2026-10

- **Shopify `returnProcess`** (replaces the deprecated `returnRefund` and our `returnClose`):
  - It processes return line items with `dispositions` (`NOT_RESTOCKED`, keyed by
    `reverseFulfillmentOrderLineItemId` + quantity).
  - It optionally carries the money in the same mutation: `financialTransfer.issueRefund.orderTransactions`.
  - Shopify closes the return itself once every line is processed.
  - It has **no** `@idempotent`. Its guard is Shopify's own: a line cannot be processed beyond its
    unprocessed quantity. Money attached to that same mutation inherits that bound.
- **`refundCreate @idempotent(key:)`**:
  - Optional from 2026-01, **required from 2026-04**.
  - Keys are kept 24 h.
  - Reusing a key with different input → `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`; a request already in
    flight → `IDEMPOTENCY_CONCURRENT_REQUEST`.
  - Of the mutations we use, it is the only one with the directive.
- **`giftCardCreate(code:)`**: the code is unique per shop (`GiftCardErrorCode.TAKEN`). A code we choose is
  therefore the idempotency key: a replay either creates the card or returns TAKEN.
- **`orderCreate`** has no idempotency. `sourceIdentifier` is searchable (`orders(query:"source_identifier:…")`),
  which gives evidence only and never authorises a resend.
- **`draftOrderDelete`**: deleting an absent draft is verifiable, because `draftOrder(id)` returns null.
- **Stripe refunds** take an `Idempotency-Key` header, kept 24 h.
- **Postgres**:
  - unique `scope_key`;
  - conditional `UPDATE … WHERE state=… RETURNING` as every transition;
  - a single-statement CTE for admission;
  - neon-http `sql.transaction([...])`, which is non-interactive and READ COMMITTED with a fresh snapshot
    per statement, for finalization, serialized on the submission row lock.
  - Interactive `db.transaction` is never used.
- **LangGraph and friends**: none fits, for the parent plan's reason, which Codex r2 accepted. Its tasks
  re-execute on resume and require idempotent effects; ownership of a Shopify mutation is ours either way.

## Today (the defect, `lib/settleReturn.ts` at `354963c`)

- **Recomputed, not agreed:** settlement recomputes the amount. Price minus €5 is hardcoded in the refund
  lane, and the fee table is re-read in the credit lane. Both ignore `submission_lines.pay_cents`.
- **Found by variant:** the line is found by `variant_id`.
- **Money first, flag last:** money moves before anything durable says "in flight"; `refunded=true` is
  written last. A crash between the two pays twice (the auto-approve comment admits it).
- **Exchange stock gap:** `releaseExchangeReservation` runs before `orderCreate`, which leaves a window
  where the held unit is free.
- **Cheaper swaps unpaid:** a cheaper swap's money is never paid.
- **Callable money functions:** every Shopify money function is exported from `db/queries.ts`, a
  `"use server"` module. That makes each one a callable endpoint (`createGiftCard(customerId, amount)` among
  them).
- **Cancellation can race settlement:** cancellation reverses Amphora, Shopify, the hold and Stripe before
  anything stops a concurrent settlement.

## L1 — Migration 0007 (additive)

**`return_submissions`** gains three columns:

- `holder text NULL CHECK (holder IN ('settlement','cancellation'))` — the ownership claim.
- `provenance text NOT NULL DEFAULT 'agreed' CHECK (… IN ('agreed','legacy'))`.
- `admission_seq int NOT NULL DEFAULT 0`.

`state` adds `cancelled`.

**`settlement_operations`** has one row per external effect:

- Identity:
  - `id uuid` PK. It is the effect key: the idempotency key `<id>:<attempt>`, `sourceIdentifier`, and the
    gift-card note.
  - `submission_id` FK.
  - `kind`: `process_refund | root_refund | gift_card | exchange_order | release_hold | process_goods`.
  - `scope_key text UNIQUE`:
    - `money:<submission>:<productsorder_id>`;
    - `goods:<submission>:<productsorder_id>`;
    - `exchange:<submission>`;
    - `hold:<submission>`;
    - `residual:<submission>`.
  - `members int[]` (productsorder ids, immutable).
  - `after uuid NULL`: a dependency, for example `release_hold` after `exchange_order`.
- Payload:
  - `request jsonb`: the exact frozen mutation variables. Amounts come from `submission_lines` and are
    never recomputed.
  - `amount_cents`, `currency`.
- Lifecycle:
  - `state`: `pending | claimed | dispatched | done | rejected | unresolved`.
  - `attempt int`, `owner uuid`, `lease_until`, `dispatched_at`.
  - `effect_ref` (the refund, gift card or order gid), `evidence jsonb`, `error`.
  - `resolved_by` (operator), timestamps.

**`submission_lines`** gains:

- `settled_at`.
- `reverse_fulfillment_line_item_id` (r2 #12). It is read once at admission from the return and frozen
  in the goods request.

**`replacement_lines`** (r2 #7): one row per line of a created exchange order:

- `exchange_operation_id`;
- `source_submission_id` + `source_productsorder_id` (the returned garment it replaces);
- `order_id`, `line_item_id`, `variant_id`, `quantity`;
- `stripe_funded_cents`, copied from the source submission line.

Written from the `orderCreate` response in the same statement that marks the operation `done`. A later
return of that replacement reads its funding from here: `buildAgreement` values a replacement line at
`original line price + stripe_funded_cents`. That retires `alertPossibleTopUp` and the tag/variant
reconstruction in `replacementOrigin.ts` for orders created from S2 on.

## L2 — Ownership: one claim per submission, shared by settlement and cancellation (r2 #2)

The submission row is the single serialization point. Two conditional updates are the only ways in:

- **Settlement admission:**
  `holder='settlement' WHERE id=$s AND state='accepted' AND holder IS DISTINCT FROM 'cancellation'`.
- **Cancellation:**
  `holder='cancellation' WHERE id=$s AND state='accepted' AND holder IS NULL AND NOT EXISTS (operation)`.
  - It runs **before** the Amphora cancel, its first external effect.
  - Amphora refuses → `holder=NULL` (nothing moved).
  - Otherwise cancellation runs to the end. It finishes with one `sql.transaction`: `state='cancelled'`,
    then `resetOrderReturn`'s writes.
  - The Stripe refund carries `Idempotency-Key: cancel:<submission>`.
  - A crash mid-cancel leaves `holder='cancellation'`, which settlement can never take. It is surfaced by
    recovery (L6).

Further ownership rules:

- **Resubmission** after a cancel is a new submission id, so every scope key is new. That gives history,
  not a collision.
- **Row edits:** `updateOrder`/`anularOrder`/`resetOrderReturn` refuse rows that belong to an accepted
  submission whose `holder` is not `cancellation`. Settlement reads the submission, never the rows, so an
  edit cannot redirect money. The refusal only keeps the portal honest.

## L3 — Admission: one statement creates every required effect (r2 #10 dependency creation)

`admit(submissionId, productsorderIds[])` reads the submission, its lines and the existing operations,
then builds the operation set:

- **Per line, goods:**
  - `process_goods`: `returnProcess` without money, one `NOT_RESTOCKED` disposition, frozen quantity.
  - **Except** a refund-tender line on a non-replacement order. That line gets one `process_refund`
    instead: the same `returnProcess` carrying `issueRefund` for `pay_cents`. Goods and money are then one
    Shopify mutation, bounded by the line's quantity. This lane replaces `createRefund`, `closeReturn` and
    the €5.
- **Per line, money** (when `pay_cents > 0` and it was not folded into `process_refund`):
  - `gift_card` when the tender is credit. `pay_cents` is already ×1.15 from S1.
  - `root_refund` when `orders.exchange_of` is set: `refundCreate @idempotent` on the root order, with
    the transaction resolved by `refundSourceFor` at admission and frozen.
- **Per submission with CAMBIO lines:**
  - `exchange_order`: all CAMBIO lines, the submission quantities, frozen addresses.
  - Then `release_hold`, which depends on it (`after`).
- **Residual:**
  - **Condition:** `residual_cents > 0` and this admission leaves no pay line unadmitted. Both are facts
    of the admission set, not row order.
  - **Effect:** `residual:<s>` in the submission's tender, refund or gift card, as its own operation.

The write is ONE statement:

```sql
WITH s AS (UPDATE return_submissions SET admission_seq = admission_seq + 1, holder = 'settlement'
           WHERE id = $s AND admission_seq = $seen AND state = 'accepted'
             AND holder IS DISTINCT FROM 'cancellation' RETURNING id)
INSERT INTO settlement_operations (…) SELECT … FROM s, jsonb_to_recordset($ops) … ON CONFLICT (scope_key) DO NOTHING
```

Zero rows from `s` means a concurrent admission or a cancellation got there first. The caller re-reads
and retries once on `admission_seq`, or reports `held:cancelling`.

**Admission is the only thing gated** by the auto-approve gate, unchanged, including its Shopify `OPEN`
check, which is what catches admin-side settlement. It is also the only thing the cap and
`AUTO_APPROVE_ENABLED` govern.

## L4 — Execution: claim → dispatch → evidence (r2 #10)

The algorithm is `run(op)`:

1. **Claim:**
   `UPDATE … SET state='claimed', owner=$me, attempt=attempt+1, lease_until=now()+'10 min'`.
   - It applies `WHERE id=$op AND (state IN ('pending','rejected') OR (state='claimed' AND lease_until<now()))`.
   - It also requires `after` to be null or `done`.
   - It must return a row.
2. **Dispatch:**
   `UPDATE … SET state='dispatched', dispatched_at=now() WHERE id=$op AND owner=$me AND attempt=$a AND
   state='claimed' AND lease_until>now() RETURNING`.
   - **Only a returned row authorises the send.** The owner check alone never does.
3. **Send** through `lib/settlement/effects.ts` (L7).
4. **Record** with one of three conditional updates, each fenced on `(id, owner, attempt, state='dispatched')`:
   - Shopify answered with the effect → `done`, with `effect_ref`/`evidence`.
   - Shopify answered with a userError, so the effect provably did not happen → `rejected`, with
     `error`. The next admission or recovery run may claim it again.
   - No answer (timeout or crash) → stays `dispatched`; recovery decides (L5).

Finalization runs after each `done`. It is one `sql.transaction`:

1. `SELECT … FROM return_submissions WHERE id=$s FOR UPDATE`, which serializes finalizers.
2. The op's `done` write.
3. `UPDATE submission_lines SET settled_at=now()` for every line whose every required operation is
   `done`. The required set is the operations whose `members` contain the line, plus `exchange`/`hold`
   for CAMBIO lines.
4. `UPDATE productsorder SET refunded=true WHERE id IN (those lines)`.

READ COMMITTED gives each statement a fresh snapshot after the lock, so two operations completing
together cannot both miss finalization, and neither can finalize early (r2 #5). `refunded` stays the
read model every existing reader uses. It now means "every effect done", never "one effect done".

## L5 — Evidence and recovery per kind (r2 #9, #12)

**Contract per kind** — what may be re-sent, and what counts as done:

| kind | Re-send after `dispatched` with no answer? | `done` evidence (all must hold; GraphQL errors or a page with more results → no verdict, re-read later) |
|---|---|---|
| process_refund | Yes. Shopify refuses quantity above unprocessed, so the money cannot apply twice. | Return line `processedQuantity ≥ frozen qty` AND `return.refunds` has one refund whose transactions include kind `REFUND`, status `SUCCESS`, `parentTransaction.id` = frozen parent, amount+currency = frozen. Status `PENDING`/`AWAITING_RESPONSE` → stay `dispatched`. `FAILURE`/`ERROR` → `unresolved`. |
| process_goods | Yes, same bound. | `processedQuantity ≥ frozen qty` AND the frozen reverse-fulfillment line has a `NOT_RESTOCKED` disposition of that quantity. |
| root_refund | Only with the same key `<id>:<attempt>` within 23 h of `dispatched_at`. After that, never. | `refund.id = effect_ref`, or the root order's refunds include note marker `[<op id>]`, with the transaction predicate as for `process_refund` on the root order. After 23 h with no match → `unresolved`. A known refund gid is re-read indefinitely; the expiry limits replay, not observation. |
| gift_card | Yes, with the same frozen code. TAKEN means it exists. | `giftCards(query:"code:<code>", first:2)` returns exactly one card AND its `customer.id` = frozen, its `initialValue` amount+currency = frozen (initial value, not balance), its `lastCharacters` = the last 4 of the frozen code, its `note` contains the op id. Zero, two, or any mismatch → `unresolved`. |
| exchange_order | **Never.** | `orders(query:"source_identifier:<op id>", first:2)` returns exactly one order AND its `sourceIdentifier` = op id, its customer = frozen, its line variants+quantities = frozen. Zero → `unresolved` (a negative search never authorises a resend). |
| release_hold | Yes. | `draftOrder(frozen id)` is null. |

**`/api/cron/settlement-recovery`** runs every 15 min, gated by `CRON_SECRET` only. Gate, cap and
`AUTO_APPROVE_ENABLED` do not apply. It:

- runs every op that is `pending` with its dependency met, `claimed` past its lease, or `dispatched` for
  more than 10 min (re-read evidence, then the table above);
- re-runs finalization for every submission with a `done` operation and an unsettled line;
- alerts on every `holder='cancellation'` submission older than 1 h that is not `cancelled`.

The transition to `unresolved` and its alert `settlement-unresolved:<op id>` are ONE CTE inserting into
`ops_alerts`, so the alert is durable with the state.

**Operators** resolve `unresolved` only through `scripts/resolve-operation.ts --op <id> --done|--rejected
--evidence "<gid/notes>"`:

- dry-run by default;
- `--write` makes one conditional update `WHERE state='unresolved'`, recording `resolved_by` and the
  evidence.

`unresolved` is never claimable.

## L6 — Exchange stock handover (r2 #12)

- `exchange_order` uses `inventoryBehaviour: DECREMENT_IGNORING_POLICY` exactly when the frozen request
  carries a held draft id that existed at admission (`draftOrder(id)` read then). It uses
  `DECREMENT_OBEYING_POLICY` otherwise.
- The unit is already held for this customer, so the order is created **before** the hold is released.
  No window exists in which the unit is free.
- `release_hold` then deletes the draft (`after` = the order operation), and on `done` clears
  `orders.exchange_reservation_id` in the same statement.
- Quantities are the submission's, replacing today's hardcoded `quantity: 1`.
- Historical native exchanges: `NATIVE_EXCHANGES` stays off. Lines of a return that already contains
  Shopify exchange line items are refused at admission (`held:native-exchange`) and listed for S3.

## L7 — One money boundary, no alternative (r2 #3)

- **`lib/settlement/effects.ts`:**
  - `import "server-only"`, NOT `"use server"`.
  - It holds the only copies of `returnProcess`, `refundCreate`, `giftCardCreate`, `orderCreate` and
    `draftOrderDelete`, all on `SHOPIFY_API_VERSION = "2026-04"` and each validated with `validate.mjs`.
  - Its single export is `send(op, dispatchToken)`. The token is the row returned by L4 step 2, so a
    caller without a dispatched row cannot send.
- **Deleted from `db/queries.ts`:** `createRefund`, `refundOnOrder`, `createStoreCreditRefund`,
  `noteStoreCreditOnOrder`, `createOrder`, `closeReturn`, `processGiftCardReturn`, `createGiftCard`.
  `lib/settleReturn.ts` is deleted.
- **Moved out of `"use server"`:** `cancelShopifyReturn` and `resetOrderReturn`, into
  `lib/submissionCancellation.ts`.
- **Settlement entry points:**
  - `validateReturn` keeps `isAdmin()` **and** goes through `admit` + `run`, so the admin check is in
    addition to ownership, never instead of it.
  - Auto-approve calls `admit` + `run`.
  - Recovery calls `run`.
  - Nothing else can reach `send`.
- **Proof in the PR:**
  - a test that walks every `"use server"` module's exports and fails if any imports `effects.ts` or a
    Shopify mutation string;
  - an import-graph test that only `lib/settlement/*` imports `effects.ts`;
  - the call-path table.

## L8 — Settlement executes the agreement, and reports truthfully

- `settleSubmission(submissionId, lines, actor)` = `admit` then `run` each admitted op in dependency
  order, within the caller's budget. It returns one status per line: `paid | goods-pending | in-flight |
  unresolved | held:<reason>`.
- Auto-approve reports those statuses. "NO money moved" is said only for `held` and `rejected`.
- The dashboard groups by submission. One click admits the clicked line, plus the whole exchange
  submission for CAMBIO lines, which keeps today's one-parcel behaviour.
- **Lines confirmed before S1** have no accepted submission. → **D1.**

## Decisions (Santi, 30 Oct: D1 = A, D2 = A)

- **D1 — lines confirmed before S1** (the pending backlog) in the S2→S3 window.
  - **A (rec.):** at admission, record a `provenance='legacy'` submission from the current rows with
    `buildAgreement`. This is the same path S1 already uses for pre-deploy Stripe sessions. The ledger
    then pays it, so there is one writer and customers keep getting paid. The amount is what the
    portal showed them (fee once per basket, ×1.15), not today's per-line €5. S3 reconciles every
    `legacy` submission against payment evidence.
  - **B:** hold them (`held:no-agreement`) until S3 backfills. This is cleaner for S3, but nobody from
    the backlog is paid until then.
- **D2 — credit tender.**
  - **A (rec.):** keep gift cards (`giftCardCreate`, with a code we generate) plus `process_goods`. There
    is no customer-visible change.
  - **B:** native Shopify store credit (`refundMethods.storeCreditRefund` inside `returnProcess`). Goods
    and credit would become one mutation, like the refund lane. But customers then get account credit
    instead of a code, which needs customer accounts and new email copy. That is a product change, so
    it is not mine to make.

## Tests

- **Real Postgres 16** (TCP) and the real neon-http adapter path:
  - two admissions racing → one op set;
  - admission vs cancellation → exactly one holder;
  - claim/takeover after lease, where the old owner's dispatch and record are fenced;
  - two ops `done` together → the line is finalized exactly once, never early;
  - a crash after `dispatched` → recovery never resends `exchange_order`.
- **PGlite, at the Shopify boundary**, one test per row of the L5 table × {answered, userError, no
  answer, evidence 0/1/2/mismatch, PENDING, FAILURE, after 23 h}, plus:
  - `process_goods` done without money → not settled;
  - recovery runs with `AUTO_APPROVE_ENABLED=false` and a CLOSED return;
  - residual admitted exactly once.
- **Agreement:**
  - the amounts sent equal `pay_cents` (and the residual) for every S1 `buildAgreement` fixture;
  - a cheaper swap pays €35 in tender;
  - a quantity-2 exchange ships 2.
- `validate.mjs` for every operation.
- Revert-it-and-watch-it-fail for each pinning test.

## Rollout

1. Santi applies 0007 via `!`. I verify it read-only.
2. Set `AUTO_APPROVE_ENABLED=false` **before** deploy.
3. Push to main. The deploy removes the old writers outright: there is no flag, and old server-action
   IDs stop resolving with the new build.
4. Wait for the old deployment's in-flight invocations (`maxDuration` 300 s), then read Shopify for any
   refund or gift card created by the old code in that window. Each one is reconciled by hand before
   arming.
5. Run recovery once by hand, arm auto-approve, and watch the first refund, gift card and exchange end
   to end.
6. Rollback is permitted only while there are zero operations in `claimed`/`dispatched`/`unresolved` and
   auto-approve is disarmed.

## Out of S2

- S3: backfill and reconciliation of legacy and falsely-completed lines, the writer drain for the
  pre-S1 Stripe path, and auditing past cheaper swaps.
- Presentment-currency conversion keeps today's `refundTransactionAmount`, frozen into the request at
  admission.
- Short-receipt Phase 2, which is redrafted on L3 (a withdrawn line is never admitted).
