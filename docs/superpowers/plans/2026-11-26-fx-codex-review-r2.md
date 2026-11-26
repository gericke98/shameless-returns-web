Reviewed `09384b1` read-only. No files changed or tests run. The owner’s scope decisions and accepted allocation residual remain accepted.

1. **[blocker] Fresh exchange sends can bypass Amphora after admission.**  
   [Rev2:98](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:98) checks stock only when creating an operation; [rev2:152](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:152) makes a rejected exchange claimable after release without another check. Recovery directly calls `run` at [recovery.ts:75](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:75), which proceeds through claim and dispatch at [run.ts:65](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:65).

   **Failure:** admission passes, then the process stops before dispatch; recovery sends much later when Amphora reports zero. The same happens after releasing a rejected exchange. A positive Shopify mirror can permit creation even though Amphora already reports zero throughout this new attempt.

   **Fix:** define stock authorization for **every fresh exchange send**, including recovered pending operations and rejected operations after release. Bind the check to the operation’s frozen demand and worker fence; define atomic hold/outbox behavior for existing operations when short. Preserve evidence-only recovery for unknown outcomes. Add recovery and release tests with Amphora zero and Shopify positive.

2. **[blocker] Manual resolution does not exclude cancellation.**  
   [Rev2:131](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:131) completes manual resolution by bumping the sequence, voiding operations and marking rows refunded. [Rev2:139](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:139) explicitly leaves cancellation unchanged.

   **Failure:** a stock-short hold has no operations and can retain `holder=NULL`. A cancellation request reads eligible rows before manual completion. Manual completion commits; cancellation then acquires the submission lock and still satisfies [submissionScope.ts:325](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/submissionScope.ts:325): accepted, null holder, no operations. That claim checks neither the manual hold nor refunded rows. It can cancel the return and issue its Stripe refund after the operator has already settled the submission. Cancellation can also win between the by-hand effect and its recording command.

   Sharing a row lock orders these writes; the later write still needs a predicate that excludes the completed transition. [Postgres READ COMMITTED documentation](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED) supports that distinction.

   **Fix:** specify durable manual ownership acquired **before** by-hand effects, excluding cancellation and automated sends. Completion must preserve terminal exclusion. Extend cancellation’s claim predicate under its existing lock and define interrupted-manual recovery. Test both claim orders and cancellation using an eligibility snapshot taken before manual completion. This requires no F4 conversion-money design.

3. **[blocker] P0 does not protect the live cutover.**  
   [Rev2:112](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:112) relies on finding no live operations, but [rev2:172](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:172) drains old functions only after deploying FX.

   **Failure:** P0 passes; an old dashboard request or cron then admits operations containing `IGNORING_POLICY` and independent siblings. New recovery can execute those frozen operations after deployment. Waiting before draft deletion does not prevent that execution.

   **Fix:** specify an enforceable cutover: prevent new old-version invocations, drain admission/confirmation/settlement workers, then run P0 while quiescence remains enforced through deployment and migration. Identify every entry point and the condition for resuming traffic. Alternatively, fully specify safe handling of old operations; the current plan explicitly supplies none.

The implementer still needs decisions for fresh-send authorization, manual ownership/recovery, and cutover enforcement. Decisions 1–5 otherwise provide the requested policy choices.

| Round-1 finding | Disposition | Evidence |
|---|---|---|
| **#1 — implementation inventory and F1 integration** | **RESOLVED** | Rev2:71–82, 182–212 identify the actual DAL, refusal propagation, persisted-agreement validation, deletions and historical compatibility. |
| **#2 — stock identity and aggregate demand** | **RESOLVED** | Rev2:38–66, 254–259 define warehouse `10`, ITEM rows, unique SKU mapping, quantity aggregation and unreadable cases. The owner accepted the stated races. |
| **#4 — execution/recovery lifecycle** | **NOT RESOLVED** | Rev2:86–110 fixes exchange-first dependencies and unknown outcomes; finding 1 leaves fresh recovery sends unguarded. Finding 3 leaves old requests executable. |
| **#7 — detection/decision/admission serialization** | **NOT RESOLVED** | Rev2:124–146 supplies CAS and atomic outbox writes, but manual resolution does not exclude cancellation; finding 2. |
| **#8 — migration authority and ordering** | **NOT RESOLVED** | Rev2:157–170 resolves authority, explicit ownership, per-draft outcomes and read-back. Cutover ordering remains unsafe; finding 3. |

The existing ledger is the appropriate foundation. Official [LangGraph durability guidance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance#retry-boundaries-and-idempotency) leaves external-effect idempotency to the application; introducing an agent runtime would not close these gaps.

| Mechanism | Judgment | File:line evidence / implication |
|---|---|---|
| Amphora reader, explicit warehouse/product identity, aggregate quantities | **FOUNDATION** | Rev2:38–56 |
| F1 DAL refusals and validation of the persisted agreement | **FOUNDATION** | Rev2:71–82 |
| D2 timestamp priority and explicit demand accounting | **FOUNDATION** | Rev2:57–66; accepted concurrency residual retained |
| Exchange dependency on every sibling; expanded admission | **FOUNDATION** | Rev2:86–97 |
| Always `DECREMENT_OBEYING_POLICY` | **FOUNDATION** | Rev2:90; matches [Shopify’s inventory-policy primitive](https://shopify.dev/docs/api/admin-graphql/2026-04/enums/OrderCreateInputsInventoryBehavior) |
| Admission-only stock authorization reused for later fresh sends | **PATCH** | Rev2:98, 152–154; finding 1 |
| Rejection hold and evidence-only unknown-outcome recovery | **FOUNDATION** | Rev2:102–110 |
| Hold/admission CAS, constrained hold rows, atomic outbox | **FOUNDATION** | Rev2:118–146 |
| Post-effect manual marker with unchanged cancellation ownership | **PATCH** | Rev2:131–155; finding 2 |
| Removal of draft creation | **FOUNDATION** | Rev2:185–188 |
| Migration authority, persisted pointers, read-back and audit | **FOUNDATION** | Rev2:157–170 |
| P0 snapshot followed by deployment before draining old workers | **PATCH** | Rev2:112–115, 172–176; finding 3 |
| Historical request/evidence compatibility | **FOUNDATION** | Rev2:177–180, 198–199 |
| Shopify quantity as display hint only | **FOUNDATION** | Rev2:72–73, 256; zero must not disable selection |

CHANGES-REQUIRED