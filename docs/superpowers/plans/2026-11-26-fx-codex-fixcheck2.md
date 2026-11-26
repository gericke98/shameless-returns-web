**The #10 trap is RESOLVED. No new blocker found in `ce6862f`.** No files were modified.

1. **Four-step probe — FOUNDATION.** Re-ran against production code with an in-memory database:

   | Step | Result |
   |---|---|
   | Legacy dispatched refund; evidence absent | `unresolved` plus durable alert; legacy hold retained; no send |
   | `--take` | Refused while unresolved, correctly |
   | `resolve-operation` | Accepted; the commit’s test also verifies a written `--done` |
   | `--release`, then recovery eligibility | Operation remains unresolved and excluded from recovery; no replay |

   The tested `resolve-operation --done → --take → --done` path also succeeds. This fixes the missing state transition through the existing operator reconciliation mechanism. [run.ts:321](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/run.ts:321)

2. **Fencing — FOUNDATION, with a nonblocking classification caveat.** `taken` requires the conditional UPDATE to return a row. The subsequent unresolved transition checks the original operation ID, state, owner and lease generation; its alert is atomic with that successful transition. A probe losing the fence after refusal changed neither operation nor alert. [ledger.ts:711](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:711), [ledger.ts:795](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:795), [ledger.ts:963](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:963)

   Strictly, the three-way classification is not always exact under concurrency: after waiting behind a winning takeover, the UPDATE can lose its fence while the fallback SELECT still sees the statement’s older snapshot and returns `refused`, rather than `not-ours`. PostgreSQL documents these [snapshot and UPDATE recheck semantics](https://www.postgresql.org/docs/16/transaction-iso.html). The subsequent fenced write still fails safely. `apply` can report `"unresolved"` despite that failed write, but it cannot change the winner’s state.

   **Refused takeover plus absence produces neither done nor a send.** An authorized takeover retains the existing replay path.

3. **Non-legacy escalation — FOUNDATION under the existing operator contract.** Moving an aged, previously dispatched operation into `unresolved` is conservative and correct: it records uncertainty, not confirmed nonexecution. A delayed Shopify effect may still land. My delayed-evidence probe confirmed that releasing the hold neither resumes this operation nor replays it; an explicit operator decision remains necessary. [ledger.ts:1157](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:1157)

   **Yes, an incorrect operator `--rejected` can permit double payment.** I reproduced the authorization path: held root refund → absent evidence → unresolved → effect subsequently visible → erroneous manual rejection → release → fresh send with key `<op>:2`, replacing `<op>:1`. `resolveOperation` trusts that human rejection without rereading Shopify. [operator.ts:126](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/operator.ts:126), [ledger.ts:658](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:658)

   That is the existing explicit operator authority, not an automatic absence-to-rejection conversion introduced here. A search miss alone cannot justify rejection. A fresh key does not inherit the original request’s [Shopify idempotency protection](https://shopify.dev/docs/api/usage/idempotent-requests).

4. **Other blockers: none.** Nonblocking stale copy remains: the legacy alert says recovery “keeps re-reading” the operation, although unresolved operations leave automatic recovery. [ledger.ts:708](/Users/santiagogerickeparga/Proyectos/1_Shameless/shameless-returns-web/lib/settlement/ledger.ts:708)

Validation: **63 existing tests and four additional in-memory probes passed**; TypeScript and commit whitespace checks passed. Real PostgreSQL concurrency races were not rerun. The fix reuses PostgreSQL conditional updates and the existing atomic outbox; no agent-framework primitive fits this settlement ownership boundary. No PATCH mechanism found.

APPROVED