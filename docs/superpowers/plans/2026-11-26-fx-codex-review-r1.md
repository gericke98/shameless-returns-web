Reviewed `69e8014` on `feat/f1-server-boundary`, read-only. The Amphora v1.15.0 spec is present. No files changed or tests run.

1. **[blocker] The plan lacks a complete implementation inventory for this tree.**

   [FX:22](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:22) names `saveLine`, but the endpoint is [actions/lines.ts:11](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/actions/lines.ts:11), calling `setLineSelectionHandler` and `orderScope.setLineSelection`. The latter still makes Shopify stock authoritative through [orderScope.ts:87](/Users/santiagogickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/orderScope.ts:87).

   The missing dispositions are:

   - **Creation:** explicitly remove the pure builder/tag module [lib/exchangeReservation.ts:46](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/exchangeReservation.ts:46), alongside the already identified server module and confirmation call.
   - **Reading:** change or explicitly retain the predicate in [replacementCatalogue.ts:23](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/replacementCatalogue.ts:23), its server consumer above, and the variant-reader contract at [db/queries.ts:564](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:564). The display reads at `db/queries.ts:497` and [dialogForm.tsx:24](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/[id]/components/dialogForm.tsx:24) can remain, but the picker **disables selection**, rather than merely displaying a number (`dialogForm.tsx:552,598`). A stale zero can prevent customers choosing an Amphora-available alternative.
   - **Release/readers:** specify the nullable column’s retention at [db/schema.ts:74](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/schema.ts:74), cancellation/revert helpers at [holdRelease.ts:37](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/holdRelease.ts:37), and their callers at [cancelReturn.ts:136](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/handlers/customer/cancelReturn.ts:136) and [submissionConfirmation.ts:96](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/submissionConfirmation.ts:96). Remove obsolete operator guidance at [Stripe route:135](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/api/webhooks/stripe/route.ts:135).
   - **Settlement planning:** remove the reservation input and handover construction in [plan.ts:53](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/plan.ts:53), `:338` and `:365`, and the admission-only reader [facts.ts:111](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/facts.ts:111).
   - **Historical execution, recovery and tooling:** explicitly retain the necessary `release_hold` contracts in [types.ts:95](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/types.ts:95), [effects.ts:122](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/effects.ts:122), [evidence.ts:306](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/evidence.ts:306), [run.ts:118](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:118) (`:167`, `:180` also), [ledger.ts:493](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:493) (`:525`, `:613` also), [operator.ts:93](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/operator.ts:93), and [resolve-operation.ts:17](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/scripts/resolve-operation.ts:17). “Stays readable” does not specify this execution/evidence compatibility.
   - **Passive inventory sites:** explicitly leave the pricing-audit reads at [audit-exchange-overcharges.ts:165](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/scripts/audit-exchange-overcharges.ts:165) (`:203` also) and [verify-311749-fix.ts:84](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/scripts/verify-311749-fix.ts:84) outside stock authorization.
   - **Tests:** retire/adapt `exchangeReservation.test.ts`, `exchangeReservationAction.test.ts` and the reservation portion of `exchangeReservationGid.test.ts`; update [confirmFromSnapshot.test.ts:145](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/confirmFromSnapshot.test.ts:145), [exchangeOrderBatching.test.ts:74](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/exchangeOrderBatching.test.ts:74), [exchangeOrderAddress.test.ts:39](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/exchangeOrderAddress.test.ts:39), [orderScopeDb.test.ts:80](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/orderScopeDb.test.ts:80), [cancelReturn.test.ts:252](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/cancelReturn.test.ts:252), and [revertKeepsLiveReturnIntact.test.ts:102](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/revertKeepsLiveReturnIntact.test.ts:102). Historical release tests currently generate fixtures through the planner that FX removes: [settlementEvidenceMatrix.test.ts:82](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementEvidenceMatrix.test.ts:82), [settlementLedgerDb.test.ts:165](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementLedgerDb.test.ts:165), and [settlementHoldRelease.test.ts:55](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHoldRelease.test.ts:55). Stale reservation mocks also remain in `noReturnableLinesLeft.test.ts:85`, `replacementReturnTransactionGuard.test.ts:120`, `returnRevertGuard.test.ts:105`, and `selfBookedSettlement.test.ts:133`.

   **Failure:** following the stated deletion changes breaks existing imports, assertions and historical fixtures; retaining the existing predicate preserves a second stock authority.

   **Fix:** add an exhaustive edit/retain/delete map. Extend the existing F1 handler/DAL refusal unions and both client mappings, preserving factory declarations and capability-scoped writes. Bind submit validation to the exact agreement being persisted.

2. **[blocker] The stock-reader contract leaves quantity and stock identity undecided.**

   [FX:18](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:18) collapses inventory to `Map<sku, number>`. However, the supplied API defines inventory by `product_id` and `location_id`, and returns all warehouses unless filtered: `company-api-live.yaml:316` and `:5232`. Neither SKU uniqueness nor warehouse eligibility is established by this contract.

   The plan also does not specify summing demand across lines sharing a SKU, quantity greater than one, missing SKU mappings, missing inventory rows, or duplicate inventory identities. An existing batched variant→SKU reader already exists at [db/queries.ts:651](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/queries.ts:651).

   **Failure:** two lines each needing one unit independently pass against availability one; alternatively, a SKU map selects or combines warehouse rows that cannot supply the shipment.

   **Fix:** define the exact stock pool using stable product/location IDs, validated variant mapping, aggregate demand and explicit unreadable cases. Reuse the existing SKU reader. Decide D2’s demand accounting before implementation; a read-and-subtract calculation alone does not serialize competing promises.

3. **[blocker] The plan explicitly permits the stockless order it promises to prevent.**

   [FX:25](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:25) promises creation only against real stock, but [FX:46](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:46) accepts a stale Shopify mirror and Amphora stock exception after creation. The parent’s [research answer:94](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-24-foundation-plan.md:94) establishes that even an imported `NEW` order allocates nothing.

   **Failure:** two settlements read Amphora availability one. Both can create orders while Shopify remains positive; Amphora later cannot pick one. Even sequential settlements can repeat this while the first order remains `NEW`.

   `DECREMENT_OBEYING_POLICY` applies Shopify’s policy; it does not atomically allocate Amphora stock. That is also the limit of the [official Shopify primitive](https://shopify.dev/docs/api/admin-graphql/2026-04/enums/OrderCreateInputsInventoryBehavior).

   **Fix:** resolve authoritative allocation and its persisted evidence with Amphora before claiming this guarantee. If the available API cannot provide it, the root fix exceeds this plan and is blocked on that contract. No Shopify-side hold is required or proposed.

4. **[blocker] Admission-only gating cannot prevent half-settlement or protect recovery.**

   [FX:33](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:33) blocks new planning while a shortfall exists. Existing execution bypasses admission: [recovery.ts:70](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:70) calls `run`, and [run.ts:71](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:71) dispatches frozen requests without stock validation.

   Goods, refund and exchange operations are independently runnable: [plan.ts:275](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/plan.ts:275), `:289`, `:342` all use `after: null`. Admission can also cover only a refund sibling; [expandAdmission:40](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/admission.ts:40) expands only when a requested line is CAMBIO.

   **Failure:** stock passes admission, goods processing closes the return, and `orderCreate` rejects. Recovery repeatedly sends the rejected exchange; no shortfall decision is created. Another case pays a refund sibling before a later exchange admission discovers shortage. A crash after admission can delay the purported “seconds” interval until recovery.

   **Fix:** specify one durable delivery-resolution lifecycle across planning, claim/dispatch, recovery and operator resolution. Define dependencies and permitted transitions for shortage, definite rejection and unknown outcomes. Preserve evidence recovery for potentially completed effects; never convert an unknown order creation into a fresh order or refund. Cover already admitted requests during rollout, including frozen `IGNORING_POLICY` requests.

5. **[blocker] “Convert to refund” does not define the money obligation and can duplicate payments.**

   [FX:38](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:38) changes the lane without defining amended amounts or payment ownership. Agreement money is basket-wide: [agreement.ts:80](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/agreement.ts:80) computes fees/net, then apportions owed money and Stripe funding across lines.

   Settlement’s money kinds have no Stripe-refund operation: [types.ts:4](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/types.ts:4). The existing Stripe helper refunds the **whole** PaymentIntent under a cancellation-specific key: [refundPayment.ts:100](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/refundPayment.ts:100).

   **Failure:** a cheaper exchange already paid €35, then its refund revision pays the original €100 again rather than the remaining obligation. For a mixed submission, calling the cancellation helper to return one exchange’s fee refunds payment funding other lines. Merely changing `action` can also retain a credit tender when the intended decision was cash.

   **Fix:** decide D1 and specify integer-cent amended totals, prior-payment deductions, tender, fee allocation, residuals, Stripe amount and PaymentIntent ownership. Record each resulting financial obligation once, with durable dispatch/evidence and shared exclusion against cancellation. Define cheaper/dearer alternative-variant pricing too. Conversion must never rerun settlement of already processed goods.

6. **[blocker] The proposed agreement revision path does not exist, and revision identity is missing.**

   [FX:36](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:36) requires a new agreement revision, but [submissionScope.ts:53](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/submissionScope.ts:53) only proposes a new submission, superseding `awaiting_payment` rows. The schema has no revision model: [schema.ts:314](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/db/schema.ts:314). Settlement loads every line of a submission at [ledger.ts:109](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:109).

   Scope keys identify money and exchange obligations by submission, not revision: [plan.ts:67](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/plan.ts:67).

   **Failure:** revising within the same submission leaves the old frozen operation selected by its existing scope. Creating another accepted submission can duplicate return-line ownership or create fresh money scopes. The operator/reconciliation paths still judge the previous frozen variant, not the new decision.

   **Fix:** design the revision entity and transition now: stable revision IDs, active-revision selection, preserved Shopify return/line identity, explicit supersession and obligation ownership across revisions. Define treatment of every existing operation state without mutating frozen requests. Update admission, finalization, `submissionOfRow`, operator tooling and reconciliation coverage consistently with L3/L6.

7. **[blocker] The shortfall index does not serialize detection, decisions and admission.**

   [FX:30](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:30) supplies an undecided-row uniqueness constraint, but no shared transaction/CAS protocol. Existing admission serializes only on `admission_seq`: [ledger.ts:274](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:274).

   **Failure:** worker A reads enough stock; worker B records shortage; A still inserts operations because B’s shortfall did not change A’s admission fence. Two operators can also race different decisions, or a decision can clear the hold before its agreement revision commits.

   There is another crash boundary: `alertOps` is **not** the outbox ([opsAlert.ts:31](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/opsAlert.ts:31)). “Write once, alert once” can persist a hold without an alert.

   **Fix:** serialize detection, decision application, cancellation and admission on the same submission/revision fence. Commit decision, revision activation and outbox entry atomically. Use composite foreign keys to the exact submission line/revision, decision-field checks, stable actor/consent evidence, and conditional one-time application. Reuse Postgres row locking/CAS and the ledger’s atomic outbox pattern. Add real concurrent-connection tests; [settlementConcurrency.test.ts:9](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementConcurrency.test.ts:9) explains why single-connection tests cannot prove this.

8. **[blocker] Releasing the 44 drafts is not executable through the stated authority, and its reader contract is incomplete.**

   [FX:41](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:41) calls for a script using `releaseHoldDraft`. Its opaque authority permits only cancellation/revert ([effects.ts:75](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/effects.ts:75)); the existing mints deliberately refuse live returns ([holdRelease.ts:64](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/holdRelease.ts:64)). Scripts also cannot import effects directly under [settlementImportGraph.test.ts:67](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementImportGraph.test.ts:67).

   **Failure:** the release script cannot obtain valid authority for live accepted exchanges without a new contract or a cast bypass. Aggregate before/after counts cannot establish which draft deletion or pointer clear failed.

   **Fix:** define an authorized migration operation using persisted draft IDs and explicit order ownership, with per-draft outcomes, read-back and conditional pointer clearing. Specify deployment ordering against old creators/workers.

   Reader dispositions must be explicit: cancellation/revert may treat a null pointer as no hold while retaining live-return protections; Stripe guidance must change; historical `release_hold` evidence must preserve its **frozen draft ID** and accept an already deleted draft. Clearing the order pointer does not itself break historical evidence—deleting those request/evidence contracts would.

9. **[blocker] Open decisions and the temporary operator path violate “plan once, then build.”**

   [FX:52](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth.md:52) leaves D1–D3 open. They determine money, promise accounting and the only customer-resolution interface. D3 explicitly introduces an “until then” process, contrary to the owner’s rule.

   **Failure:** the implementer must invent payout policy, consent recording, alternative pricing and recovery behavior. The stated “next cron settles” is also conditional: ordinary recovery only admits legacy approvals ([recovery.ts:46](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:46)), while auto-approval may reject a now-closed return.

   **Fix:** record final decisions before implementation. Make the chosen operator/customer decision interface complete, with consent evidence, durable pending/applied outcomes and an identified resume mechanism. Add verification for mixed submissions, prior payouts, closed returns, stock changes after admission, unknown order creation, concurrent decisions and interrupted draft migration.

The existing Postgres ledger, capability boundary, conditional transitions and outbox are the appropriate foundations. I checked official Shopify/Postgres primitives and [LangGraph durability guidance](https://docs.langchain.com/oss/javascript/langgraph/graph-api#re-execution-and-idempotency); agent checkpoints do not supply atomic warehouse allocation or exactly-once external payment effects for this deterministic flow.

| Mechanism | Judgment | Evidence / implication |
|---|---|---|
| Amphora as stock authority; unreadable distinct from zero | FOUNDATION | FX:18; complete identity/quantity contract still required. |
| Server validation through existing F1 actions/DAL | FOUNDATION | `actions/lines.ts:11`, `orderScope.ts:75`; use existing capabilities and closed unions. |
| Admission snapshot plus stale Shopify mirror/warehouse exception as guarantee | PATCH | FX:46; still permits an unbacked order. |
| `DECREMENT_OBEYING_POLICY` | FOUNDATION | Valid Shopify inventory primitive; cannot enforce Amphora allocation. |
| Admission-only shortfall gate | PATCH | `recovery.ts:70`, `run.ts:71`; execution bypasses it. |
| Stable shortfall IDs and recorded customer decisions | FOUNDATION | FX:30; needs revision binding, constraints and atomic transitions. |
| Partial unique index as the concurrency mechanism | PATCH | FX:32; does not fence admission or decision application. |
| Immutable agreement revisions | FOUNDATION | FX:36; required model/path is currently unspecified. |
| Lane-only refund conversion | PATCH | FX:38; lacks amended financial obligations and prior-effect accounting. |
| Local promise netting by subtracting open exchanges | PATCH | FX:55 as written; no serialized ownership or allocation accounting. |
| Removing Shopify draft creation | FOUNDATION | FX:39; removes the incorrect reservation mechanism. |
| Draft drain through cancellation/revert authority | PATCH | `effects.ts:75`, `holdRelease.ts:64`; migration authority is absent. |
| Preserving historical requests/evidence and non-dispatchable reconciliation records | FOUNDATION | `types.ts:100`, `ledger.ts:61`, `operator.ts:93`. |
| Script “until” a later customer page | PATCH | FX:58; resolution workflow remains provisional. |

CHANGES-REQUIRED