Reviewed branch HEAD `caa0d397f0c935aaf4798d6d6ca41cebe0cc6d3d`. No files, database state, or Shopify state were changed. The 113 pending lines are the plan’s snapshot, not a fresh production count.

Below, **P:L** refers to line L of [the v2 plan](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/specs/2026-10-30-settlement-ownership-plan.md).

**Round-one findings**

| Finding | Status | Assessment |
|---|---|---|
| F1 — exchange ownership | PARTLY | Unique submission scope fixes sibling group creation; atomic eligibility, membership freezing, and dispatch authorization remain unspecified. P:110–128. |
| F2 — expired refund keys | RESOLVED | Frozen requests and bounded replay address the original duplicate-payment scenario; after the window, replay is prohibited. P:113–145. |
| F3 — deployment overlap | NOT | Removing the button at deployment and waiting 300 seconds does not stop new invocations of old actions or drain external requests. P:238–249. |
| F4 — mutation boundary | PARTLY | Internal transport is appropriate, but the alternative “admin-guarded” still permits financial writers outside ownership. P:201–207. |
| F5 — processed ≠ paid | PARTLY | Financial evidence is now separate, but the completion CTE contradicts that separation and transaction matching remains incomplete. P:131–143, 174–175. |
| F6 — recovery searches | PARTLY | Search support, cardinality, and negative-search refusal are addressed; gift-card ownership and complete result validation remain undefined. P:146–159. |
| F7 — legacy reconciliation | NOT | Today’s fees cannot reconstruct accepted agreements; the pending-only population still excludes falsely completed legacy lines. P:229–237. |
| F8 — reachable recovery | PARTLY | Independent scheduling is correct; missing dependent operations, rejected operations, and recovery ownership remain undecided. P:209–218. |
| F9 — customer agreement | PARTLY | The agreement is persisted after payment, and the model cannot pay a positive balance on exchange-only submissions or represent replacement funding correctly. P:66–99. |
| F10 — fees and quantities | PARTLY | Line-total and shipment quantities improve, but basket/replacement valuation still omits quantity; rounding remains incomplete and the prohibited tie-breaker remains. P:88–98, 155. |
| F11 — dispositions/exchanges | PARTLY | Inventory policy and external fulfillment route are selected; disposition identities, reservation handover, existing native exchanges, and replacement-line ownership remain incomplete. P:164–180. |
| F12 — Neon atomicity | PARTLY | Driver constraints and real PostgreSQL tests are acknowledged; the required eligibility, cancellation, completion, and dispatch algorithms are still absent. P:28–32, 124–133, 264–268. |

I checked the Shopify and Neon skills and official LangChain documentation; `.claude/skills/` is absent. **Postgres constraints, conditional statements, and non-interactive transactions are the appropriate ownership primitives.** LangGraph tasks/checkpoints can orchestrate this workflow, but unfinished tasks can execute again and still require idempotent external effects. Store, Deep Agents orchestration/memory, LangChain middleware, and LangSmith traces/evaluators do not supply Shopify financial ownership. The plan’s narrower reason for declining those primitives is acceptable. [LangGraph idempotency documentation](https://docs.langchain.com/oss/javascript/langgraph/functional-api#idempotency)

**Mechanism verdicts**

These verdicts assess the mechanisms as specified, including their stated guarantees.

| Mechanism | Verdict | Reason |
|---|---|---|
| **M1 — submission agreement** | **PATCH** | It freezes a recomputation after checkout, omits exchange-related cash obligations, and explicitly retains a row-ID tie-breaker. P:66–99. |
| **M2 — operations ledger** | **PATCH** | Durable identity and unique scopes are sound primitives, but the specified claim omits atomic eligibility and the completion CTE can settle an obligation after only one effect. P:124–133. |
| **M3 — effect contracts** | **PATCH** | “Moves no money” is used to justify replay without proving goods/disposition idempotency; recovery evidence is not fully bound to the financial recipient and source. P:141–170. |
| **M4 — Shopify closure** | **FOUNDATION** | Separating Shopify lifecycle completion from financial obligations addresses the underlying status conflation. P:182–186. The operational gaps below still block implementation. |
| **M5 — settle by stable row identity** | **FOUNDATION** | Loading authoritative obligations and deriving the lane server-side fixes caller-controlled routing. P:188–197. External entitlement identity still needs completion upstream. |
| **M6 — money boundary** | **PATCH** | “Admin-guarded” is accepted as an alternative to ownership, leaving multiple authorized financial writers possible. P:204–207. |
| **M7 — independent recovery** | **FOUNDATION** | Recovery independent of new-settlement admission directly fixes stranded work after closure. P:209–218. Its state transitions remain incomplete. |
| **M8 — API version** | **FOUNDATION** | One explicit version with GraphQL validation and separate REST verification addresses version drift. P:220–225. |

**Findings, ranked by financial harm**

1. **Critical — the cutover can still run old and new financial writers concurrently.**

   **Evidence:** P:238–247 disables only auto-approve, deploys, then waits. Dashboard settlement is independently authorized by the admin session in [refund.ts:22](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/refund.ts:22). Old credit creation moves value before the completion flag, at [settleReturn.ts:155](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:155).

   **Failure:** an old dashboard action starts during deployment or the drain interval, creates a gift card, and has not recorded completion when backfill/new settlement runs. The new operation issues another card. A function timeout also does not establish that Shopify has stopped processing its request.

   **The plan must say instead:** close admission to **every old financial entry point before the drain begins**, including callable Server Actions and scheduled invocations. Establish that old writers cannot start again; account for dispatched requests with unknown outcomes before backfill authorizes payment. Define the corresponding handover for incoming submissions and paid Stripe sessions.

   Rollback also needs stronger conditions: zero non-terminal operations is insufficient if `unresolved` is treated as terminal or obligations lack their dependent operations. The independent recovery job must be included in rollback coordination.

2. **Critical — cancellation can reverse money and stock before discovering a settlement claim.**

   **Evidence:** P:102–103 places the refusal at `reset`/`anular`. The actual cancellation path cancels Amphora first, cancels Shopify, releases stock, refunds Stripe, and only then resets rows: [cancelReturn.ts:64](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/cancelReturn.ts:64), [cancelReturn.ts:128](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/cancelReturn.ts:128), [cancelReturn.ts:155](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/cancelReturn.ts:155).

   **Failure:** cancellation passes its initial read; settlement claims the exchange; cancellation returns the Stripe upgrade payment while settlement creates the replacement. The eventual reset refusal cannot undo either effect.

   **The plan must say instead:** cancellation and settlement acquire mutually exclusive persisted ownership **before their first external effect**. Define one atomic eligibility/claim protocol used by cancellation, settlement, editing, and reset. Claiming an operation with `INSERT … ON CONFLICT` alone does not synchronize it with source-row edits.

   Also define cancellation/resubmission history. `productsorder_id UNIQUE` plus permanent `pay:<productsorder_id>` scopes cannot represent a cancelled submission followed by a fresh submission without an explicit lifecycle rule.

3. **Critical — M6 still permits ownership bypasses by authenticated financial writers.**

   **Evidence:** P:206–207 allows mutation exports to remain if “admin-guarded.” Current financial exports reside in a `"use server"` module, including [queries.ts:506](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:506), [queries.ts:829](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:829), and [queries.ts:1229](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:1229).

   **Failure:** an authenticated alternate action issues a refund while the cron issues the same obligation’s refund through the ledger. Authentication authorizes both; it does not deduplicate them.

   **The plan must say instead:** every application financial dispatch requires the persisted operation and successful current-state dispatch transition. Admin authentication is an additional requirement for applicable entry points. It cannot replace ownership. Inventory the resulting reachable action exports and their call paths; a grep listing alone is not the boundary.

4. **Critical — the “accepted agreement” is still recomputed after the customer pays.**

   **Evidence:** P:66–68 freezes values in `updateFinalOrder`. Stripe checkout is created earlier using current basket/catalogue/fees; its metadata contains only order ID and credit choice: [payments.ts:49](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/payments.ts:49), [payments.ts:171](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/payments.ts:171). The webhook subsequently calls confirmation with that mutable order ID: [route.ts:160](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/api/webhooks/stripe/route.ts:160), [route.ts:180](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/api/webhooks/stripe/route.ts:180).

   **Failure:** a customer opens checkout, then changes their selection in another tab, or fees/catalogue pricing change before payment completes. Confirmation creates obligations for different goods or amounts. Two checkout sessions can also collect twice while confirmation creates only one return.

   **The plan must say instead:** persist an immutable submission/agreement identity before creating checkout. Bind the session, payment, membership, prices, fees, addresses, method, and tender to it. Confirmation consumes that agreement and validates payment amount/currency/status. Define duplicate sessions, duplicate webhook delivery, free submissions, and mismatched or superseded payments.

   Reusing the same calculation functions is necessary, but does not preserve the inputs the customer accepted.

5. **Critical — the completion contract can mark an unpaid obligation settled.**

   **Evidence:** P:131–133 says completing an individual effect sets its obligations `settled` and `refunded=true`. P:174–175 requires both financial/exchange and goods effects to complete. These are incompatible instructions.

   **Failure:** `process_lines` completes first; its completion CTE settles the obligation. The financial operation is absent or pending, and M5 subsequently refuses the non-open obligation. The customer receives nothing while existing readers report completion.

   **The plan must say instead:** an effect’s completion records only that effect. Obligation finalization atomically verifies **all explicitly recorded required effects**, including the correct financial or offset satisfaction, before changing the obligation/read model.

   Define shared-row serialization and concurrent finalization semantics. Two effects completing simultaneously must neither finalize early nor both miss finalization. PostgreSQL data-modifying CTE siblings share a snapshot; later CTE text does not automatically see earlier changes through the base table. [PostgreSQL CTE documentation](https://www.postgresql.org/docs/16/queries-with.html#QUERIES-WITH-MODIFYING)

6. **Critical — exchange-only submissions can owe money with nowhere to record or pay it.**

   **Evidence:** P:82 defines mutually exclusive `pay|replace`; P:93 distributes money only to `pay` lines; P:99 gives every replacement line zero money. Existing portal totals include cheaper-replacement balances: [basket.ts:128](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/basket.ts:128), [lastWindow.tsx:72](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/[id]/windows/lastWindow.tsx:72).

   **Failure:** exchange a €100 item for a €60 replacement with a €5 return fee. The portal promises €35. There are no `pay` lines, so the allocation has no recipients. Creating the replacement and processing the goods satisfies the plan’s completion rule without paying €35.

   Conversely, a `pay` line fully consumed by an upgrade offset has amount zero, but M3 still requires a refund/gift-card operation to complete.

   **The plan must say instead:** replacement delivery and money obligations are independent; one returned line/submission may require both. Represent offset satisfaction explicitly, including its funding relationship. Define zero-money obligations without manufacturing a payment.

   P:91–92 must also stop asserting that every nonpositive balance means Stripe was paid. Zero balances and sub-€0.50 shortfalls currently create no charge: [payments.ts:123](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/payments.ts:123).

7. **High — stable local row IDs do not yet establish stable external entitlement or replacement funding.**

   **Evidence:** P:100 fixes the final update predicate, but fulfillment resolution still selects by variant at [updateOrder.ts:308](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/updateOrder.ts:308), and return matching still returns a map keyed by variant at [returnPayload.ts:277](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/returnPayload.ts:277). The proposed schemas contain no replacement-order-line/source-obligation relationship. Existing replacement valuation reconstructs it from tags and variants: [replacementOrder.ts:20](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/replacementOrder.ts:20), [replacementOrigin.ts:74](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/replacementOrigin.ts:74).

   **Failure:** duplicate-variant lines remain ambiguous upstream even though the final write uses row IDs. Separate local payment scopes can refer to an incorrectly shared external entitlement. Returning a replacement also retains only the original price; a Stripe upgrade payment has no allocated refund obligation.

   **The plan must say instead:** persist explicit mappings among Shopify order line, fulfillment line and quantity, return line, obligation, and created replacement line. Enforce ownership at that external entitlement scope. Preserve the replacement’s funding allocations across original Shopify payment, Stripe top-up, offsets, and earlier refunds.

   P:196’s order-level `exchange_of` link alone cannot answer which line owns which funds.

8. **High — the legacy migration neither reconstructs agreements nor covers the known false-completion population.**

   **Evidence:** P:229–237 recomputes today’s fees for each pending line. Existing code writes `refunded=true` before root payment at [settleReturn.ts:374](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:374). Gift-card references have also been written by variant rather than row: [queries.ts:1213](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:1213).

   **Failure:** a falsely completed replacement is outside the 113 pending lines and remains unpaid. A copied gift-card ID can mark another line paid. Recomputing a mixed submission per line loses its shared fee and checkout offsets; creating one submission per line also conflicts with `shopify_return_id UNIQUE` when those lines share one return.

   **The plan must say instead:** reconcile a refreshed, quiescent population that includes pending lines, suspicious completed lines, closed returns with outstanding obligations, paid/unconfirmed submissions, and shared effect references. Recover submission membership from explicit evidence. Validate each effect’s recipient, currency, amount, and ownership before importing it.

   Unrecoverable historical agreements need an explicit operator-approved financial decision. `provenance='legacy'` cannot make today’s formula the historical agreement. P:259’s claim that this is “what the customer was shown” is unsupported.

9. **High — financial recovery reads are supported, but their success predicates remain insufficient.**

   I verified these claims using **`gzip -dc | node` against the requested 2026-04 introspection schema**:

   - `giftCards(query:)` documents searching with a full code.
   - `orders(query:)` documents both `source_identifier` and `tag`.
   - `GiftCardUserError.code` uses **`GiftCardErrorCode.TAKEN`**, not the `ReturnErrorCode` named at P:39.
   - Gift-card reads expose masked code/last characters, initial value/currency, and customer.
   - Refund transactions expose kind, status, amount/currency, parent transaction, and order.

   **Evidence:** P:141–152 accepts a successful transaction for the numeric amount, or a card with the code/value. P:157–158 validates only replacement variants and quantities.

   **Failure:** a gift-card collision/search match belongs to another customer; a validator compares EUR obligation cents with another currency’s numeric amount; or an order search result is accepted without verifying its returned source identifier and customer. Matching value does not establish ownership.

   **The plan must say instead:** specify the exact evidence predicate for each effect: operation/result identity, order/customer, parent transaction/gateway, transaction kind, currency, and complete amount. For gift cards, use initial value rather than remaining balance and define how code correspondence is established given masked reads. Handle pagination and GraphQL errors before asserting cardinality. Full-code search is supported; it is not a documented exact-ID lookup. [Gift-card search reference](https://shopify.dev/docs/api/admin-graphql/2026-04/queries/giftCards)

   Keep the no-resend rule for missing exchange results. For known refund GIDs, continue status reads after the replay window; expiration limits mutation replay, not observation. Shopify’s documented retention is 24 hours from the original request. [Idempotency documentation](https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency)

10. **High — the recovery state machine and HTTP transaction algorithms remain incomplete.**

    **Evidence:** P:118–119 calls `rejected` re-claimable, but claim only inserts and takeover handles only `claimed`. P:212–213 lists no recovery transition for `rejected`. No durable dependency creation connects money completion to creation of `process_lines`.

    **Failure:** money completes, then the worker dies before creating the goods operation. Recovery scans operations, finds the money operation done, and never discovers the missing goods work. Another operation remains `rejected` indefinitely because every insert conflicts.

    **The plan must say instead:** define the complete transition table, dependency creation, recovery authority, and atomic unresolved/outbox write. Specify a conditional `claimed → dispatched` transition whose successful `RETURNING` is required before sending. A current owner check alone must not authorize a second non-idempotent dispatch. Define recovery ownership when the original worker is gone and when a late result arrives.

    **Neon itself is not the blocker.** The installed interactive transaction implementation throws at [session.js:107](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/node_modules/drizzle-orm/neon-http/session.js:107), while single statements and non-interactive transaction batches are supported. The plan must select actual statement boundaries, locks, predicates, and result dependencies; naming those primitives does not establish atomicity. [Neon driver documentation](https://neon.com/docs/serverless/serverless-driver)

    Extend PostgreSQL tests to simultaneous final effects, cancellation before external reversal, concurrent submission creation, and dispatch/takeover races. Include the actual neon-http adapter.

11. **High — quantity and cent allocation still disagree with the displayed and charged contract.**

    **Evidence:** P:88 multiplies original price by quantity, but [basket.ts:105](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/basket.ts:105) and its replacement sum count one unit. Replacement pricing returns a unit amount at [replacementPricing.ts:167](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/replacementPricing.ts:167). P:94 requires integer cents to equal `net_cents × 1.15` exactly; P:95 explicitly breaks ties by row ID.

    **Failure:** a quantity-two return is displayed/charged using one unit while obligations use two. A one-cent positive net produces 1.15 credit cents, which cannot be allocated as integer cents. Equal remainders assign a cent according to insertion identity, affecting what a later withdrawn line takes away.

    **The plan must say instead:** define original and replacement **line totals**, discount allocation, currency conversion, bonus rounding, and conservation equations once, then use them in display, checkout, agreement, reservation, shipment, and settlement. Define fee-table versioning; the existing fee table has mutable rows rather than an immutable version.

    The row-ID tie-breaker remains prohibited even when its result is stored. Resolve indivisible residual cents through an approved financial rule—for example a submission-level residual obligation—without deriving entitlement from row ordering. D1/D2 must be decided before implementation.

12. **High — goods processing and exchange reservation handover still lack complete recovery contracts.**

    **Evidence:** P:169–170 permits replay because no money moves, contradicting P:129’s blanket non-idempotent no-resend rule. The pinned schema requires `reverseFulfillmentOrderLineItemId` and quantity for each disposition; P:165 names only the return-line ID. Current exchange settlement ignores reservation-release failure: [settleReturn.ts:253](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:253). Release is a separate Shopify delete followed by a local pointer clear: [exchangeReservation.ts:151](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/exchangeReservation.ts:151).

    **Failure:** processing completes but the response is lost; a quantity read alone cannot establish the required disposition. Separately, reservation deletion succeeds but its local write fails, or release fails and `orderCreate` encounters stock still reserved for that customer.

    **The plan must say instead:** persist exact reverse-fulfillment/disposition identities and verify disposition completion as well as processed quantity. The schema does **not** establish that repeating `returnProcess` is harmless or refused atomically. Require documented/tested semantics or retain uncertainty without replay.

    Define reservation release, missing-draft recovery, pointer updates, and the release-to-order inventory handover under the same exchange ownership. Confirm existing native exchange items and already-closed returns explicitly; saying the flag is off does not classify historical returns.

    Removing `returnClose` does **not directly break the inspected tracking emails**: domestic tracking uses locator, milestones, and unsettled flags at [queries.ts:233](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:233); international received email follows Amphora status at [amphoraWebhook.ts:133](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/amphoraWebhook.ts:133). Preserve those contracts with tests. Shopify documents automatic closure after processing and dispositions, which supports M4’s direction. [Return-management guide](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-return-management#step-10-optional-close-a-return)

**Decisions that must be in the plan**

Beyond correcting the findings above, implementation must not decide these implicitly:

- The immutable agreement/submission lifecycle, including checkout creation, confirmation, cancellation, resubmission, and partial quantities.
- The obligation schema supporting both replacement delivery and money, explicit offset satisfaction, and funding relationships.
- Exact atomic algorithms for admission, dispatch, takeover, cancellation, dependency creation, finalization, and unresolved alerts.
- Recovery and operator-resolution transitions for every state, including how evidence can resolve uncertainty without creating another payment.
- The legacy reconciliation population, grouping rules, evidence requirements, and approved treatment of missing historical agreements.
- Bonus/FX/residual rounding and withdrawal economics, with D1 and D2 resolved.
- Explicit replacement-line ownership, reservation handover, disposition identities, and treatment of historical native exchanges.
- The complete writer shutdown, drain, activation, rollback, and recovery-job coordination procedure.

NOT AGREE