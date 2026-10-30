This plan still permits duplicate payouts and unpaid lines being treated as complete. It needs another design pass before implementation.

Reviewed `feat/settlement-ownership` at `74f267f`, against `87d3337`; only the plan differs. No files, databases, or Shopify state were changed. The 113-line count is the plan’s reported snapshot, not a fresh production measurement.

Below, **plan:L** refers to [2026-10-30-settlement-ownership-plan.md](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/specs/2026-10-30-settlement-ownership-plan.md).

I checked the Shopify and Neon skills, the pinned introspection schema through `gzip -dc | node`, and official LangChain documentation. `.claude/skills/` is absent. Postgres constraints and atomic statements are appropriate primitives here. LangGraph’s Functional API can orchestrate ordinary workflows, so “no graph/no agent” is an incomplete dismissal; its documentation nevertheless requires external effects to be idempotent. Checkpoints, Store, Deep Agents memory/orchestration, LangChain middleware, and LangSmith evaluators do not provide atomic ownership of Shopify money. The plan should state that narrower justification. [LangGraph documentation](https://docs.langchain.com/oss/javascript/langgraph/functional-api#idempotency)

**Mechanism verdicts**

“FOUNDATION” identifies a sound mechanism choice; it does not approve its unfinished contract.

| Mechanism | Verdict | Reason |
|---|---|---|
| **M1** | **FOUNDATION** | A durable settlement identity, unique entitlement claim, and atomic completion/read-model update address the underlying ownership problem. However, plan:59–78 does not yet define group ownership, individual effect records, or safe takeover. |
| **M2** | **FOUNDATION** | Passing a stable row ID and loading authoritative data server-side addresses caller-controlled identity and money routing. Plan:82–88 still needs atomic eligibility validation and explicit rejection of invalid lane combinations. |
| **M3** | **PATCH** | Plan:94–107 substitutes lease expiry and recovery searches for an actual guarantee against duplicate external effects. Processing quantity is not payment evidence; directive replay is time-limited. |
| **M4** | **PATCH** | Removing premature closure is necessary, but plan:111–114 assumes incomplete closure conditions and leaves readers equating closure with settlement. It does not finish the root fix. |
| **M5** | **PATCH** | Plan:118–122 freezes recomputed values too late, omits existing financial rules, and D2 assigns financial consequences by lowest row ID—a positional tie-breaker. |
| **M6** | **FOUNDATION** | One supported version and schema validation address version drift directly. D1 must be resolved, and validation must cover the actual inventory, including REST operations. |

**Findings, ranked by financial harm**

1. **Critical — exchange claims do not establish one owner for one replacement order.**

   **Evidence:** plan:63–68, 92–102 defines unique claims per line and merely says exchange lines share `group_id`. Today the exchange path discovers every pending exchange dynamically, then creates one order: [settleReturn.ts:232](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:232), [settleReturn.ts:255](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:255).

   **Failure:** workers settling sibling lines can independently create groups, or partially acquire the same proposed group. Both can create a replacement order. A shared UUID written onto individual rows is not a group-level uniqueness constraint. After 300 seconds, a second worker can also resume while the original request is still capable of completing.

   **The plan must say:** create a durable exchange operation with immutable membership and a unique business scope before dispatch. Acquire ownership of the entire operation atomically; partial acquisition cannot authorize any effect. Define owner token, generation, takeover, and fenced local writes. For non-idempotent external calls, lease expiry alone cannot authorize another create.

2. **Critical — replacement refunds can pay twice after Shopify’s idempotency window expires.**

   **Evidence:** plan:103 treats replaying `effect_key` as an indefinite recovery read. Shopify documents a **24-hour retention window**; subsequent requests are new operations after expiry. [Shopify idempotency documentation](https://shopify.dev/docs/apps/build/apis/graphql-admin/implementing-idempotency#how-idempotency-protection-is-implemented-on-the-server-side)

   **Failure:** Shopify accepts Monday’s root refund; the process dies before saving its GID. Recovery happens Wednesday and replays the key. Remaining refundable funds on another garment can fund a second refund.

   **The plan must say:** persist the exact request and dispatch timing before sending. Specify recovery inside and outside the retention window. Outside it, require durable evidence identifying the original refund, or keep the operation unresolved without issuing another payment. Freeze root order, parent transaction, gateway, amount, currency, and complete mutation variables—not just euro cents. Recomputing variables also defeats reliable replay.

3. **Critical — the deployment can overlap protected and unprotected financial writers.**

   **Evidence:** plan:166–169 contains migration, no backfill, and deployment, with no writer handover. Existing gift-card and exchange effects precede their completion flags: [settleReturn.ts:155](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:155), [settleReturn.ts:255](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:255).

   **Failure:** an old invocation passes `refunded=false`, then stalls. The new deployment claims that line and pays it. The old invocation resumes and pays again without consulting the ledger.

   **The plan must say:** define a cutover that stops and drains old financial invocations before new ownership becomes authoritative, including dashboard submissions and scheduled work. Define rollback compatibility; rolling back to an implementation that ignores active ledger operations is unsafe. Watching five settlements does not establish ownership during deployment.

4. **Critical — routing callers through `settleLine` does not close the financial mutation boundary.**

   **Evidence:** [db/queries.ts:1](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:1) marks the module `"use server"`. Its exported `createGiftCard`, `createOrder`, and `refundOnOrder` accept financial inputs without checking a settlement owner: [queries.ts:1229](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:1229), [queries.ts:829](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:829), [queries.ts:506](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:506). The authenticated wrapper is separate: [refund.ts:22](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/refund.ts:22).

   **Failure:** a directly invoked mutation action, or another internal caller, bypasses both the authenticated wrapper and ledger ownership. Module-level `"use server"` marks exports as Server Actions. [Next.js documentation](https://nextjs.org/docs/14/app/building-your-application/data-fetching/server-actions-and-mutations#convention)

   **The plan must say:** financial transport helpers are server-only internal functions, with one authorized dispatch boundary that requires the persisted operation and current ownership. Inventory and remove every bypass. Changing two intended callers is insufficient.

5. **Critical — `processedQuantity` can mark an unpaid refund complete.**

   **Evidence:** plan:100 says `processedQuantity = quantity` means the refund happened. The pinned schema separately exposes `processedQuantity`, `refundedQuantity`, refunds, and transaction statuses. Its `Refund.description` explicitly says that a Refund object does **not** guarantee money was returned; associated transaction status must be checked.

   **Failure:** goods are processed without a financial transfer, or a refund transaction remains pending or fails. Recovery sees the target processed quantity and marks `done/refunded=true` although the customer has not received the promised money.

   **The plan must say:** financial completion requires identified financial evidence with the required successful transaction amount, currency, and recipient/source relationship. Pending financial processing remains explicit state. Goods processing and payment completion are separate facts.

   **On re-processing:** neither the pinned `returnProcess` description/input contract nor the reviewed guide establishes an exactly-once financial guarantee for repeating the request. The schema’s quantity fields are not proof of that runtime behavior. The plan must supply evidence of the claimed rejection/atomicity semantics or avoid relying on them.

6. **High — searches are supported, but their recovery guarantees are overstated.**

   **Evidence:** plan:35–37, 101–102. The pinned schema confirms:

   - `giftCards(query:)` documents full-code searches.
   - `orders(query:)` supports `tag` and `source_identifier`.
   - `sourceIdentifier` is an originating-platform identifier, not a documented uniqueness constraint.

   **Failure:** an exchange order is created but its response is lost. A search returns no match while the original request is unresolved; another `orderCreate` produces another order. Conversely, selecting an arbitrary search match can mark the wrong operation complete.

   **The plan must say:** define zero, one, multiple, unreadable, and mismatching-result outcomes. Verify returned explicit identifiers and operation contents. A negative search is not proof that another non-idempotent create is safe.

   The credit lane has a stronger primitive: preserve the same caller-chosen code and handle Shopify’s `TAKEN` result without generating another code. Specify its encoding—the schema allows **8–20 alphanumeric characters**, so a raw UUID is invalid. Full-code search support should remain; the false claim is that search alone supplies the whole recovery contract.

7. **High — “no backfill” leaves both previously paid and previously unpaid lines misclassified.**

   **Evidence:** plan:23–26 and 167. Existing credit creation saves `gift_card_id` before final completion: [queries.ts:1213](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:1213). Existing replacement settlement writes `refunded=true` **before payment**: [settleReturn.ts:374](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:374).

   **Failure:** a pending legacy credit line already has a gift card, but its new ledger operation generates another code and pays again. A legacy replacement claim crashed before payment; M2 rejects it forever because `refunded=true`. Historical/manual payments also cannot be discovered by newly generated effect keys.

   **The plan must say:** reconcile the reported 113 pending lines and audit ambiguous legacy completion flags. Classify existing evidence into paid, unpaid, accounting incomplete, and unresolved; import explicit effect references where available. Also decide how already-closed returns with unpaid siblings are handled. Do not infer these classifications from notes or amounts.

8. **High — recovery can become permanently unreachable.**

   **Evidence:** plan:69 defines `effect_done`, but plan:92–95 provides no resumption outcome for it or `failed`. The cron rejects every pending return whose Shopify status is not OPEN: [autoApproveGate.ts:100](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/autoApproveGate.ts:100). The shortfall sweep resolves cases from closure alone: [receiptObservation.ts:44](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/receiptObservation.ts:44), [receiptShortfallSweep.ts:105](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/receiptShortfallSweep.ts:105).

   **Failure:** the final Shopify processing succeeds and closes the return; the worker dies before the completion CTE. The next cron refuses to enter settlement, while the shortfall sweep resolves the outstanding case.

   **The plan must say:** ledger recovery is scheduled independently of admission rules for new settlements. Specify every state’s transitions, including `effect_done`, failed attempts, and partial multi-effect completion. Closure cannot resolve an outstanding financial obligation. Dashboard and cron outcomes must distinguish paid, accounting incomplete, uncertain, and unpaid; today the cron’s generic refusal text says “NO money moved” ([route.ts:244](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/api/cron/auto-approve/route.ts:244)).

9. **High — M5 changes the customer’s financial contract.**

   **Evidence:** plan:118 omits the credit bonus shown by [summary.tsx:127](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/[id]/components/summary/summary.tsx:127). Stripe charges the **net basket**, already offsetting returned value against replacement value: [payments.ts:75](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/payments.ts:75), [basket.ts:128](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/basket.ts:128).

   **Failure:** a €100 credit return with a €5 fee promises €109.25; M5 pays €95. For a mixed submission, a €30 return can already offset an €80 exchange upgrade in Stripe checkout. Paying that return again at settlement gives the customer value twice.

   **The plan must say:** persist the submission’s financial agreement: returned value, replacement value, credit bonus, fees, Stripe payment/offset allocations, and remaining obligations by tender. Settlement executes those obligations. A line-price-minus-fee function cannot represent this contract. Portal totals cannot remain categorically out of scope if quantity or financial rules change.

10. **High — fees and quantities are frozen at the wrong boundary and with undefined rounding.**

   **Evidence:** plan:66, 119–139. Fees are mutable ([fees.ts:16](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/fees.ts:16)); basket valuation excludes confirmed lines ([basket.ts:88](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/basket.ts:88)). Exchange creation still ships quantity 1 ([queries.ts:949](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:949)).

   **Failure:** fees change between customer acceptance and settlement. Reusing `loadBasket` after confirmation yields an empty active basket and zero parcel weight. A quantity-two exchange is recorded processed but ships one item. Rounding a discounted unit into integer cents before multiplication can also lose the original line total; [basket.ts:92](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/basket.ts:92) documents precisely that problem.

   **The plan must say:** freeze accepted fee amounts, parcel scope/weight, collection method, currency, and exact line totals at submission/payment. Define allocation and rounding so totals reconcile exactly. Apply quantities consistently to processing, reservation, shipment, valuation, and displays.

   D2’s “lowest line ID” is expressly a tie-breaker. Across cash and credit lanes it even changes the total bonus depending on row ordering. Replace it with an explicit financial allocation rule recorded in the accepted agreement.

11. **High — M4 omits dispositions and the exchange fulfillment decision.**

   **Evidence:** plan:34, 111–114, 140–145. Shopify’s closure guide requires all items processed **and disposition decisions made**. [Shopify return-management guide](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/build-return-management#step-10-optional-close-a-return) The pinned disposition input requires reverse-fulfillment line identity and, for restocking, a location. `returnCalculate` has no disposition input, so the proposed dry run cannot establish disposition behavior.

   **Failure:** replacement orders are created but returns remain OPEN because dispositions are absent. If native exchange items exist, omitting their processing can also prevent completion; processing them can create Shopify fulfillment work alongside the separately created replacement order. Native exchange creation already exists at [updateOrder.ts:501](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/updateOrder.ts:501).

   **The plan must say:** choose the stock/disposition policy before implementation, identify its inventory owner, and define exactly one exchange fulfillment route. Persist replacement-order/line relationships explicitly; new orders must not depend on reconstructing ownership from `Change`/`Order #…` tags ([replacementOrder.ts:20](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/replacementOrder.ts:20)).

   Removing `returnClose` does **not directly break tracking emails** in the inspected code: domestic tracking selects by locator, milestones, and unsettled flags ([queries.ts:233](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:233)); international received emails follow Amphora status ([amphoraWebhook.ts:133](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/amphoraWebhook.ts:133)). The plan should preserve and test those contracts separately from Shopify closure.

12. **High — atomicity is feasible with neon-http, but the plan has not specified enough to obtain it.**

   **Evidence:** plan:74–77 promises a completion CTE; group acquisition and takeover have no equivalent algorithm. The app uses neon-http ([drizzle.ts:2](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/drizzle.ts:2)); its installed interactive transaction implementation throws ([session.js:107](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/node_modules/drizzle-orm/neon-http/session.js:107)). HTTP supports single statements and non-interactive transactions. [Neon documentation](https://neon.com/docs/serverless/serverless-driver)

   **Failure:** an implementer reads eligibility, inserts individual claims, then updates membership across separate requests. Cancellation or editing changes the source rows between those operations. Existing reset clears confirmation and return IDs without consulting ownership ([queries.ts:1777](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:1777)).

   **The plan must say:** specify atomic eligibility/freeze/claim, all-or-none group acquisition, takeover, completion, and uncertainty/outbox writes. Make cancellation/editing obey the same persisted ownership. A single-statement CTE is valid; `db.transaction(async …)` is not. PGlite tests alone do not establish the multi-connection races—require PostgreSQL concurrency tests and adapter coverage.

**Decisions still missing from the plan**

These should be settled in the document, rather than left to implementation:

- The complete per-operation/per-effect schema, constraints, stable external entitlement mapping, and immutable exchange membership.
- Whether one product row is always settled in full; how partial quantities and later submissions are represented.
- Exact state transitions and recovery ownership, including the meaning of `effect_done`, `failed`, and financial transactions still pending.
- Permanent handling of unresolved non-idempotent calls and expired directive keys.
- One canonical order recovery key: plan:68 names `effect_key`, while plan:102 uses `group_id`.
- Search result validation/cardinality rules and gift-card code representation/storage.
- The accepted financial agreement, bonus, fee allocation, Stripe offsets/top-ups, currency conversion, and rounding.
- D1’s actual version choice and complete inventory. The two REST sites at [queries.ts:278](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:278) and [queries.ts:296](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:296) cannot be validated by a GraphQL schema validator.
- D3’s disposition/inventory policy, reservation-release recovery, and exchange fulfillment ownership. Current reservation release can return false, which settlement ignores ([settleReturn.ts:253](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settleReturn.ts:253)).
- Reconciliation, deployment handover, rollback, and tests covering the actual failure scenarios above—not mocks that assume the recovery guarantees being questioned.

NOT AGREE