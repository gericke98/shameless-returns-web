Reviewed `ff38737` against `8077734`, read-only. No files changed. TypeScript and diff whitespace checks pass. I reproduced findings 1–4 using in-memory PostgreSQL probes, with production ledger code for the execution paths. I did not rerun the full suite or pg16 races.

1. **[blocker] Recovery sends legacy siblings before their exchange is done, including while held.**

   [recovery.ts:79](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:79) routes previously dispatched operations around `claim`. [run.ts:295](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:295) then permits a resend, and [ledger.ts:644](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:644) checks neither legacy shape nor exchange dependency.

   **Failure:** an old dispatched `process_refund` has `after=NULL`, its exchange remains pending, and evidence shows neither goods nor money happened. Recovery takes it over and sends `returnProcess`. My probe produced `SettlementReturnEvidence → SettlementReturnProcess` while the submission retained an open hold. This can pay/process a sibling while leaving the replacement unresolved.

   **Fix:** enforce A3 on the recovery resend authorization. Legacy operations may be observed and completed from evidence; absence must not authorize their replay. Preserve ordinary evidence recovery. As-built #10’s “evidence-only” claim is false.

2. **[blocker] A hold committed after claim does not revoke fresh dispatch authorization.**

   Hold predicates exist in [ledger.ts:595](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:595), but [ledger.ts:670](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:670) dispatches solely from the operation’s lease/state.

   **Failure:** worker A claims a valid refund sibling after the exchange completes. Worker B encounters a historical `release_hold` and records an A3 hold. A then dispatches its fresh refund. The production SQL probe returned a dispatch token despite the committed `legacy-plan` hold.

   **Fix:** make fresh claim/dispatch authorization participate in the submission’s serialization protocol. A hold transition must invalidate outstanding undispatched authorization, with blocking state checked at the serialized dispatch transition. Another earlier SELECT does not close this window under [READ COMMITTED](https://www.postgresql.org/docs/16/transaction-iso.html).

3. **[blocker] D2 timestamp precision loss lets later submissions bypass earlier or equal promises.**

   [ledger.ts:204](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:204) converts `accepted_at` into JavaScript `Date`; [ledger.ts:537](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:537) sends its millisecond-rounded value back as the comparison boundary. Acceptance uses PostgreSQL `now()` at [submissionScope.ts:182](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/submissionScope.ts:182).

   **Failure:** two submissions accepted at `10:00:00.000900Z` both load as `.000Z`. Each query excludes the other. My probe through `loadSubmission` and `openExchangeDemand` returned **zero earlier demand** for equal stored timestamps.

   **Fix:** compare against the submission’s actual PostgreSQL timestamp inside the demand query, using its stable ID. Add microsecond timestamp cases; the current equal-time test uses whole seconds.

4. **[should-fix] Migration 0014 does not enforce complete resolution/taker metadata.**

   [0014_settlement_holds.sql:46](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/drizzle/0014_settlement_holds.sql:46) and [:52](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/drizzle/0014_settlement_holds.sql:52) rely on `length(trim(nullable_column)) > 0`. PostgreSQL accepts a CHECK result of NULL. [Official constraint semantics](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)

   **Failure:** the actual migration accepted a resolved manual hold with `resolved_by=NULL`, `evidence=NULL`, and `taken_by=NULL`, provided its timestamps were set. Ownership and resolution evidence are therefore not database invariants.

   **Fix:** explicitly require each populated branch’s actor/evidence fields `IS NOT NULL`, then validate nonblank text. Add tests for individually omitted fields, not only blank strings.

5. **[should-fix] The picker still makes Shopify stock an eligibility gate.**

   [dialogForm.tsx:30](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/[id]/components/dialogForm.tsx:30) includes `inventoryQuantity > 0`; [:607](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/[id]/components/dialogForm.tsx:607) refuses selection when that predicate fails.

   **Failure:** Amphora has stock while Shopify’s mirror says zero. The server would accept the variant, but the customer cannot select it. Calling this a “display hint” does not implement binding Decision 2.

   **Fix:** retain Shopify quantities as display information and let ACTIVE variants reach the server’s Amphora check. This follows the existing decision; it requires no new stock source.

6. **[should-fix] Repeated A1 unreadability never reaches the promised cron digest.**

   [run.ts:107](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:107) returns `wait` and clears the claim. [recovery.ts:81](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:81) only appends that result to the HTTP report. Its alerts cover approvals, cancellations and taken holds.

   **Failure:** persistent unreadability leaves the exchange pending indefinitely without an operator alert. The reason is also lost from the recovery result. The cron simply returns that report at [route.ts:27](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/app/api/cron/settlement-recovery/route.ts:27).

   **Fix:** carry the unreadable reason into recovery reporting and include the condition in the specified digest, without creating transient stock holds.

7. **[should-fix] The race/proof coverage misses the execution failures above.**

   [settlementHoldsConcurrency.test.ts:83](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHoldsConcurrency.test.ts:83) starts with an existing blocking hold, so admission already cannot win independently of `--take`. At [:114](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHoldsConcurrency.test.ts:114), the dependent cannot run because its exchange is never done. Neither exercises a fresh claim crossing hold creation. The A3 cases at [settlementHolds.test.ts:294](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHolds.test.ts:294) cover pending operations, not legacy recovery resends.

   **Fix:** add controlled interleavings for claim → hold → dispatch, legacy dispatched siblings with absent evidence, and the relevant hold writers against admission/dispatch. The cancellation test’s 15 rounds contain only five simultaneous races at [:148](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHoldsConcurrency.test.ts:148).

   The harness **does use separate connections**: [pg16.ts:36](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/support/pg16.ts:36) supplies a real pool, and transactions acquire clients at [:48](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/support/pg16.ts:48).

The supplied revert proofs pin policy generation, planned dependencies, admission coverage, `insertHold`’s sequence bump, claim’s hold filter, rejected-exchange hold creation, A1 authorization, pending-shape A3 refusal, and save/submit refusals. Their mocks preserve those mechanisms. They do **not** establish recovery/dispatch safety. The initial A2 race mutant passed; the corrected [final proof:1](/private/tmp/claude-501/-Users-santiagogerickeparga-Proyectos-1-Shameless-shameless-returns-web/61e67b9b-5fbf-4668-bb24-418aaaacbab2/scratchpad/revert_proofs_a2b.txt:1) fails as intended.

For the fence audit: admission, `insertHold`, short-stock claim return, and take/done/release compare the observed sequence. Rejection and A3 instead increment it after their operation/hold writes; claim and dispatch do not share that submission fence. Atomic outbox writes are present, but finding 2 prevents the overall protocol from providing the requested exclusion.

Migration 0014 is additive apart from replacing/widening CHECKs. Existing valid holder values remain valid; free, paid and legacy acceptance writers populate `accepted_at`. Live-data compliance was not verified. P1 before deployment, old-function drain before P3, and P4 only after clearing every pointer remain appropriate. Finding 1 leaves A3’s code cutover incomplete.

No additional regression was found in non-exchange free/paid returns, refund, credit, cancellation or self-booked paths. Fresh exchange authorization and generated OBEYING requests are present. Manual ownership excludes cancellation through [submissionScope.ts:330](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/submissionScope.ts:330). The accepted Amphora allocation residual remains outside these findings.

| As-built item / mechanism | Judgment | Evidence and disposition |
|---|---|---|
| **1. Warehouse code constant** | FOUNDATION | Accept: explicit configured identity at [amphoraStock.ts:36](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/amphoraStock.ts:36). |
| **2. Reader signature and demand mapping** | FOUNDATION | Accept: batched mapping and closed unreadable outcomes at [amphoraStock.ts:63](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/amphoraStock.ts:63). |
| **3. Picker retains stock disabling** | PATCH | Reject: mirror still controls selection; finding 5. |
| **4. Shared coverage module** | FOUNDATION / PATCH | Reuse is sound at [stockGate.ts:20](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/stockGate.ts:20); D2’s timestamp round trip needs finding 3’s root fix. |
| **5. Exchange gate independent of requested subset** | FOUNDATION | Accept: explicit dependency identity at [plan.ts:138](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/plan.ts:138); approved lines excluded. |
| **6. Hold check on every admission** | FOUNDATION | Accept: early refusal plus write predicate at [admission.ts:78](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/admission.ts:78), [ledger.ts:358](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:358). |
| **7. Explicit allowed-holder predicate** | FOUNDATION | Accept: excludes manual ownership at [ledger.ts:357](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:357). |
| **8. UUID holds and atomic outbox** | FOUNDATION | Accept: stable hold identity and same-statement alert at [ledger.ts:407](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:407). |
| **9. A1 claim return and lost-CAS behavior** | FOUNDATION | Accept: frozen demand and worker fence at [run.ts:100](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:100), [ledger.ts:790](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:790). Digest omission is finding 6. |
| **10. A3 pending-only detection** | PATCH | Reject claimed evidence-only recovery behavior; findings 1–2. |
| **11. Take/done/release CLI** | FOUNDATION | Accept: ownership acquired before manual effects, terminal exclusion retained, at [holdResolution.ts:94](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/holdResolution.ts:94). |
| **12. Taken-hold daily digest** | FOUNDATION | Accept: durable hold state remains discoverable at [recovery.ts:104](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:104). |
| **13. Draft migration authority and outcomes** | FOUNDATION | Accept: persisted pointers, completion refusal, read-back and conditional clearing at [holdRelease.ts:70](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/holdRelease.ts:70). |
| **14. Constraint naming and added CHECKs** | FOUNDATION / PATCH | Naming accepted; metadata constraints incomplete at [0014:46](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/drizzle/0014_settlement_holds.sql:46); finding 4. |
| **15. Shared Amphora configuration export** | FOUNDATION | Accept: one configuration source at [amphora.ts:29](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/amphora.ts:29). |
| **16. Test doubles** | FOUNDATION | Boundaries acceptable. Correction: checkout tests do use a database, at [checkoutBinding.test.ts:19](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/checkoutBinding.test.ts:19). Coverage gaps are finding 7. |
| **17. Intermediate non-typechecking commit** | Accepted; no runtime mechanism | Confirmed historical mismatch; HEAD typechecks. Disclosed at [plan:363](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:363). |
| **Always OBEYING** | FOUNDATION | Correct [Shopify primitive](https://shopify.dev/docs/api/admin-graphql/2026-04/enums/OrderCreateInputsInventoryBehavior), generated at [exchangeOrderInput.ts:160](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/exchangeOrderInput.ts:160). |
| **Submission-wide fresh-send exclusion** | PATCH | Claim-time filtering leaves dispatch authorization valid across a hold; finding 2. |

CHANGES-REQUIRED