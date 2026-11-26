The six original findings are **RESOLVED**, but As built #10 remains a blocker. No files were modified.

| Finding | Verdict | Judgment and evidence |
|---|---|---|
| **1 — legacy recovery replay** | **RESOLVED** | **FOUNDATION:** `takeOver` checks legacy shape, dependency, holds and manual ownership. Positive evidence remains recordable before replay authorization. [ledger.ts:697](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:697), [run.ts:288](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:288). Probe passed. |
| **2 — hold after claim** | **RESOLVED** | **FOUNDATION:** dispatch locks the submission, then checks blocking state in a separate statement. [ledger.ts:754](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:754). Claim → A3 hold → dispatch probe returned no token. |
| **3 — timestamp precision** | **RESOLVED** | **FOUNDATION:** SQL compares stored timestamps using the submission’s stable ID. [ledger.ts:556](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:556). Equal and unequal microsecond probes passed. |
| **4 — nullable metadata constraints** | **RESOLVED** | **FOUNDATION:** populated branches explicitly require non-NULL fields. [0014_settlement_holds.sql:46](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/drizzle/0014_settlement_holds.sql:46). Each individually omitted actor, evidence or timestamp was rejected. |
| **6 — unreadable digest** | **RESOLVED** | **FOUNDATION:** the reason reaches recovery reporting and an alert keyed by operation ID and UTC day. [run.ts:115](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:115), [recovery.ts:86](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/recovery.ts:86). Probe confirmed repeated daily-key stability and no hold. |
| **7 — missing execution coverage** | **RESOLVED** | **FOUNDATION:** tests now cover claimed siblings crossing hold creation, blocked dispatch, rollback, competing writers and legacy recovery. [settlementHoldsConcurrency.test.ts:181](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHoldsConcurrency.test.ts:181), [settlementHolds.test.ts:394](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/tests/settlementHolds.test.ts:394). |

Finding 5 remains the owner’s decision and was not reopened.

The dispatch lock audit found **no new reachable deadlock against the requested paths**:

- `insertHold`, legacy holds and short-stock claim return acquire the submission before downstream writes: [ledger.ts:410](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:410), [:594](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:594), [:910](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:910).
- `recordRejected(exchange)` remains **operation → submission → hold**, so the blanket claim that every writer locks the submission first is inaccurate. Its reachable recording states are dispatched/unresolved; dispatch requires claimed. For the same exchange, those predicates prevent the operation-lock wait needed to close a cycle. [ledger.ts:764](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:764), [:802](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:802).
- Hold resolution, cancellation and tracking acquire the submission first. Dispatch acquires no order-row lock that reverses tracking’s order. [holdResolution.ts:168](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/holdResolution.ts:168), [submissionScope.ts:319](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/submissionScope.ts:319), [:479](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/server/submissionScope.ts:479).

This appropriately uses PostgreSQL’s [row-lock](https://www.postgresql.org/docs/16/explicit-locking.html) and [READ COMMITTED](https://www.postgresql.org/docs/16/transaction-iso.html) primitives; agent-framework persistence would not replace this protocol.

The gift-card change is **FOUNDATION**: an authorized replay retains the frozen code; a refused takeover falls back to observation. Matching evidence records done; a search miss becomes unresolved without creating a card. [run.ts:293](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:293), [evidence.ts:225](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/evidence.ts:225). Shopify documents that the [default gift-card search includes codes](https://shopify.dev/docs/api/admin-graphql/2026-04/queries/giftCards). Probes verified actual database completion for legacy, dependency-blocked and held cards.

**As built #10 is a correctness gap in recovery liveness.** I reproduced the complete trap:

1. Legacy refund, evidence absent → hold created; operation stays dispatched.
2. `--take` refuses because it is in flight. [holdResolution.ts:56](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/holdResolution.ts:56).
3. `resolve-operation` refuses because it is not unresolved. [operator.ts:116](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/operator.ts:116).
4. `--release` succeeds, but recovery recreates the hold and leaves it dispatched.

Accepting this because live data currently has no dispatched operations would be a **PATCH** rationale. The binding cutover explicitly permits old functions to create legacy operations after P0 and makes P0 informational. [spec:267](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:267), [spec:296](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/docs/superpowers/plans/2026-11-26-fx-exchange-stock-truth-rev2.md:296).

The root fix is a fenced transition into an explicit operator reconciliation state—reusing the existing unresolved path where appropriate—without authorizing replay or treating absence as proof of completion.

TypeScript and diff whitespace checks passed. Production-code PGlite probes passed for 1–4, digest reporting and gift-card recovery. Pg16 races were inspected but not rerun because their harness writes a temporary cluster.

CHANGES-REQUIRED