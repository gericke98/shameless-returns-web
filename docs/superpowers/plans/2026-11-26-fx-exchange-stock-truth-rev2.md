# FX: an exchange's replacement is backed by Amphora's stock (HEAVY) — plan rev 2, 2026-11-26

Base: `feat/f1-server-boundary` @ `75d3d9a`. Supersedes rev 1 (`2026-11-26-fx-exchange-stock-truth.md`) wherever they
differ. Rev 1 §Foundation 4 (customer decision, agreement revision, `replacement_shortfalls`) and D1 (refund
conversion) are **superseded** by Santi's scope decision after Codex r1: they move to F4. D2 and D3 stand.
Answers Codex r1 (`2026-11-26-fx-codex-review-r1.md`) #1 #2 #4 #7 #8. #3 is accepted as a stated residual; #5 #6 #9 → F4.

Owner's rules, verbatim:
1. Fix the root cause. Never a heuristic, tie-breaker, special case, flag, retry, regex over words, "until phase N" stopgap, or workaround for an existing weakness. If the root fix is bigger than the ask, say so and do the root fix (or stop and ask) — never ship the patch silently.
2. Before designing anything, read the official skills and docs for what already exists, and reuse it instead of rebuilding. State in the design which official primitive you use, or why none fits.
4. Identity, state and ownership are explicit data with stable ids — never derived from content, position, object identity, names, lineage or quote text.
5. Plan once, then build: every open decision is made in the plan, not left to the implementer.

## Scope (Santi, 2026-11-26 — not widened here)
(a) No new Shopify draft holds; an authorized migration releases the existing ones (#D604, #D613 already deleted by
hand 2026-11-26, pointers cleared). (b) The server refuses a replacement Amphora cannot cover, at line save AND at
submit. (c) At settlement the exchange order is created FIRST with `DECREMENT_OBEYING_POLICY`; goods and sibling money
run only after it exists. (d) Amphora short at settlement → the whole submission is held: explicit record + outbox
alert, nothing planned. Held cases: Santi resolves by email + by hand, and records it with an operator command so
nothing settles twice. Out: customer choice, refund conversion, partial Stripe refunds (F4).

**Residual, stated plainly (Codex #3, bound to Amphora's answer).** Amphora allocates nothing for a NEW order
(foundation plan :94-96). Once our replacement order exists and before Amphora starts preparing it, Amphora's
`available` still includes that unit, so two settlements — even hours apart — can both see the last unit and both
create orders. Nothing on our side can close this; only an Amphora allocation can (Santi's 3 questions, rev 1 §Questions).
Likewise accept-time checks between two concurrent customers are not serialized (Q5); D2 priority at settlement decides.

**Official primitives (rule 2).** Shopify `orderCreate` `options.inventoryBehaviour = DECREMENT_OBEYING_POLICY`
(enum `OrderCreateInputsInventoryBehavior`; variants are `inventoryPolicy: DENY`, tested in rev 1) and
`draftOrderDelete`; Amphora Company API v1.15.0 `GET /inventory/{company_id}` → `InventoryLevels`
(`company-api-live.yaml:301-353, 5232-5286`); Postgres conditional `UPDATE … RETURNING` CTEs, partial unique index,
CHECK constraints — i.e. the existing settlement ledger. The LangChain skills named in the owner's rules do not apply:
this is a deterministic money ledger, not an agent (agent checkpoints give neither warehouse allocation nor
exactly-once external effects; Codex r1 agrees).

---

## #2 — The stock pool (one reader, `lib/server/amphoraStock.ts`, `server-only`)
**Source.** `GET {AMPHORA_COMPANY_API_URL}/inventory/{AMPHORA_TENANT_ID}?warehouses={W}&shop_name={AMPHORA_SHOP_NAME}`
(spec :301-340; the tenant is the same `{company_id}` the existing client puts in its paths, `lib/server/amphora.ts:28-48`;
the inventory path puts it after `/inventory/`, so the reader builds its own URL with the same key/header). One call
returns the whole catalogue; no pagination in the spec.
**Which rows count.** Exactly the rows with `location_id = W` (Q1: the one warehouse that ships Shopify orders,
explicit config) and `product_type = 'ITEM'`. The count is `available_quantity` ("stock available to place new
orders", :5272-5274). `reserved`, `pending`, `committed` never count.
**Variant → SKU.** Reuse `getVariantSkusByIds` (`db/queries.ts:651-698`; Amphora SKU == Shopify variant SKU, verified
there). SKU is the identifier both systems declare for the product (Amphora returns/orders key items by `sku`,
`amphora.ts:66,126`); it is validated, not trusted: for each SKU there must be **exactly one** row at `W`.
**Result type.** `readAvailable(variantGids) → { ok: true; bySku: Map<sku, { productId, locationId, available }>,
skuOf: Map<variantGid, sku> } | { ok: false; reason }`. Unreadable is a value, never 0 and never "enough":
`amphora-http:<status>` / thrown transport; `no-sku:<variant>` (absent from `getVariantSkusByIds`, which skips
sku-less nodes, :688); `not-at-amphora:<sku>` (0 rows at W); `ambiguous:<sku>` (>1 row at W, or two `product_id`s);
`not-item:<sku>`; `bad-count:<sku>` (non-integer or negative).
**Demand (pure, `lib/stockCoverage.ts`).** `need(lines) → Map<sku, units>` sums `quantity` over every CAMBIO line
mapped to that SKU (two lines × 1 against available 1 → short). `covers(need, available, earlier) →
{ ok } | { short: [{ sku, need, available, earlier }] }` with covered ⇔ `available − earlier ≥ need` per SKU.
**Open demand (D2).** One read (`openExchangeDemand`, `readQuery`): lines with `sl.action='CAMBIO'` of submissions
`state='accepted' AND holder IS DISTINCT FROM 'cancellation'`, `sl.settled_at IS NULL`, row `p.refunded IS NOT TRUE`
(settled outside the ledger, e.g. #310542/#310848), not covered by a `settlement_approvals` row, whose submission has no
`exchange_order` op in `done`/`void`, and no `manual` hold (open holds: Q3). Returns `(submission_id, accepted_at,
new_variant_id, quantity)`; SKUs mapped in the same batched read.
- **Accept time** (save, submit): `earlier` = all open demand except this order's unconfirmed basket; `need` = the basket.
- **Settlement**: `earlier` = open demand of submissions with `accepted_at <= mine AND id <> mine`. Equal timestamps
  count both ways (both promises stand; no tie-breaker). A later submission can never take an earlier one's unit.
- `accepted_at` becomes total: migration adds `CHECK (state <> 'accepted' OR accepted_at IS NOT NULL)` (precondition
  P0 verifies zero violations; legacy submissions get `now()` at recording, `legacyTerms.ts:159-163`).
**Serialization (Codex #2).** A submission's coverage depends only on Amphora and on EARLIER-accepted lines, which are
fixed data long before its admission (admission opens ≥2 days after receipt, `autoApproveGate.ts:84`), so two
admissions never decide on each other's promises. Within one submission all writes share the `admission_seq` fence (#7).

## #1 — Accept: the server refuses (b)
- `lib/replacementCatalogue.ts:17-29`: `isOfferedReplacement` → `isOfferedProduct({ productStatus })` (ACTIVE only).
  Stock leaves the shared predicate; it is not an offer rule any more.
- `orderScope.setLineSelection` (`lib/server/orderScope.ts:75-103`): after the ACTIVE check, `readAvailable` for the
  variant; `need` = this row's quantity + the order's other unconfirmed CAMBIO rows on the same SKU (from `read()`);
  refusals `replacement-unavailable`, `stock-unreadable` added to the closed union (`:78`), the handler
  (`handlers/customer/lines.ts:31`) and `dialogForm.tsx:236-239` + i18n `action.replacementUnavailable`,
  `action.stockUnreadable` (`lib/i18n/{es,en}.ts`, next to `variantNotOffered` :210/:201).
- Submit, bound to the exact agreement persisted (Codex #1): `proposeCurrentSelection` (`lib/submissionProposal.ts:96-113`)
  checks `current.agreement.lines` × `current.lines[].newVariantId` BEFORE `proposeSubmission`; `ProposalRefusal`
  (:26) gains both values; they flow through `createStripeUrl` (`payments.ts:16-18,44-45`) and `submitReturn`
  (`submitReturn.ts:39,188-198`, its `alertSubmitRefused` unchanged) to `asyncButton.tsx:80-84` (new messages).
- The Stripe webhook does not re-check (refusing after payment would need a refund: F4). Settlement is the gate.
- Picker: Q2.

## #4 — Exchange first (`lib/settlement/plan.ts`) and its lifecycle (c)
**Plan.** If the submission has a non-approved CAMBIO line (`plan.ts:317`), the gate op id is fixed BEFORE the loop:
`gate = existingExchange?.id ?? newId()`. The `exchange_order` op has `after: null`; **every** other op planned for
that submission — `process_goods` (:180, :294), `process_refund` (:280), credit/residual/root money
(`moneyOperation` :474, :498 gain an `after` parameter) — gets `after: gate`. `inventoryBehaviour` is always
`DECREMENT_OBEYING_POLICY` (`exchangeOrderInput.ts:159`; `holdExisted` :116-117 and :338 deleted). The `release_hold`
block (:365-383) and `PlanInput.reservation` (:53) are deleted. Existing primitive reused: `claim` already refuses an
op whose `after` is not `done` (`ledger.ts:337-339`), as do `recoverableOperations` (:661-664) and `settle.runnable`
(`settle.ts:30-31`).
**Admission unit.** `expandAdmission` (`admission.ts:34-44`) admits every non-approved CAMBIO line whenever ANY line of
a submission with one is requested (today only when a requested line is CAMBIO, :40), so a refund sibling can never
be admitted without its exchange gate (Codex #4 "refund sibling").
**Admission stock read (d).** Only when the exchange op will be NEWLY planned: blocking hold → `held:stock-held:<id>`
or `held:resolved-by-hand:<id>`; `readAvailable` unreadable → `held:stock-unreadable:<reason>` (no record; transient,
the cron reports it); short → `insertHold` (#7) → `held:stock-short:<hold id>`, no ops; covered → plan + `insertAdmission`.
`readDraftExists` (`facts.ts:110-113`) and the reservation read (`admission.ts:116-122`) are deleted.
**Transitions of the exchange op** (dependents wait in every non-done state):
| Outcome | What happens |
|---|---|
| `done` (answer, or evidence search by `sourceIdentifier`, `run.ts:159-165`) | replacement lines recorded (`ledger.ts:591-610`); dependents become claimable |
| definite rejection (`userErrors`, `run.ts:111-114`; or operator `--rejected`, `operator.ts:126-131`) | `recordRejected` for `exchange_order` writes, in the SAME statement, a hold (`cause='exchange-rejected'`, `exchange_operation_id`), bumps `admission_seq`, and its outbox row. `claim` refuses ops of a submission with a blocking hold, so recovery no longer re-sends it every 15 min (Codex #4) |
| no answer | stays `dispatched`; recovery reads evidence (`run.ts:230-241`); a zero search is `unresolved`, never re-sent (`ledger.ts:368`, `evidence.ts:297-301`) |
| `unresolved` | existing atomic alert (`ledger.ts:454-479`); operator `done` (with `--order`) or `rejected` (→ hold) via `resolve-operation.ts`, unchanged |
An unknown `orderCreate` is never turned into a fresh order or a refund: only a definite rejection (or an operator's
`rejected`) makes it claimable again, and only after `release` (#7). `takeOver` of dispatched non-exchange ops stays
unblocked (evidence-first recovery of effects that may have happened).
**Rollout.** P0 verifies no `settlement_operations` of a non-`reconciled`/`voided` submission is in
`pending|claimed|dispatched|rejected|unresolved` (the coordinator verified none today) — so no frozen
`DECREMENT_IGNORING_POLICY` request or `after:null` sibling can run after deploy. If P0 finds any: stop and ask.
No code path handles them.

## #7 — Holds serialized on the admission fence; outbox in the same statement
**Table** (`drizzle/0014_settlement_holds.sql`, additive): `settlement_holds(id uuid pk, submission_id uuid NOT NULL
REFERENCES return_submissions, cause text CHECK IN ('stock-short','exchange-rejected'), exchange_operation_id uuid NULL
REFERENCES settlement_operations, detail jsonb NOT NULL, created_at, resolution text NULL CHECK IN ('release','manual'),
resolved_by text, evidence text, resolved_at timestamptz)`; CHECKs: `(cause='exchange-rejected') = (exchange_operation_id
IS NOT NULL)`; resolution/resolved_by/evidence/resolved_at all null or all set (non-blank); partial unique
`(submission_id) WHERE resolved_at IS NULL` (one open hold). "Blocking" = open, or `resolution='manual'`.
**The fence.** Every write that changes what may be planned for a submission is ONE statement whose first CTE is the
submission CAS `UPDATE return_submissions SET admission_seq = admission_seq + 1 WHERE id=$s AND admission_seq=$seen AND
state='accepted' AND holder IS DISTINCT FROM 'cancellation'`, exactly as `insertAdmission` (`ledger.ts:274-285`):
- `insertAdmission`: + `AND NOT EXISTS (blocking hold)`.
- `insertHold` (stock-short): `s` → `INSERT settlement_holds … FROM s` → outbox row.
- `recordRejected` on `exchange_order`: its existing fenced op UPDATE `r` → `INSERT settlement_holds … FROM r ON
  CONFLICT (submission_id) WHERE resolved_at IS NULL DO NOTHING` → seq bump on that submission → outbox row.
- `resolveHold` (operator): `s` (CAS on the seq the operator read) → `UPDATE settlement_holds … WHERE id=$h AND
  resolved_at IS NULL` → for `manual`: refused if any op of the submission is `claimed|dispatched|unresolved`
  (an effect may have happened); else every not-done op → `void` (the 0012 primitive: no fence matches it,
  `voidReconciliation.ts:83-93`), and `productsorder.refunded = true` on the submission's rows (the existing permanent
  "we settled that garment" record, `submissionScope.ts:375-377`), so the gate never picks them again
  (`autoApproveGate.ts:71`). Counts are compared as `voidForeignReconciliation` does (:99-101).
A worker that read "enough" and a worker that recorded "short" cannot both win: whichever commits second fails the CAS
and re-reads (the hold, or the ops). `claim` gains `AND NOT EXISTS (blocking hold for o.submission_id)` and
`recoverableOperations` the same filter on its pending/rejected branch. Cancellation is unchanged
(`submissionScope.ts:319-344` UPDATEs the same row, so it serializes): a held submission may still be cancelled while
`cancelEligibility` allows it; a hold left on a cancelled submission is inert (admission and `resolveHold` require
`accepted`).
**Outbox, named.** The ledger's atomic outbox pattern: `INSERT INTO ops_alerts (dedupe_key, subject, body) SELECT … FROM
<state CTE> ON CONFLICT (dedupe_key) DO NOTHING` inside the state statement, as `recordRejected`/`recordUnresolved`
(`ledger.ts:418-479`). Key `settlement-held:<hold id>`; body: order number, submission, cause, the shortfall per SKU
(`need/available/earlier`) or the userErrors, and the two `resolve-hold` commands. Never `alertOps`
(`opsAlert.ts:31`), never a separate `enqueueOpsAlert`. (The auto-approve cron's own daily `alertNotSettled`,
`app/api/cron/auto-approve/route.ts:223-226,296-311`, still fires for any `held:` line — unchanged; moving it to the
outbox is F5's.)
**Operator command** `scripts/resolve-hold.ts --hold <uuid> (--release | --manual) --evidence "<what was done>" [--by]
[--write]`, dry-run by default, `systemTarget("resolve-hold")` (F1 §11 G2), logic in `lib/settlement/holdResolution.ts`
modelled on `scripts/void-reconciliation.ts`. `--release` (Q4): the hold closes; a stock-short submission is re-admitted
by the next gate run with a fresh Amphora read (short again → a NEW hold row); an exchange-rejected op becomes
claimable again (a rejection proved no order exists; `claim` starts a new attempt, `ledger.ts:330-331`). `--manual`:
Santi settled it himself; nothing of that submission is ever planned or sent again.

## #8 — Releasing the existing drafts: a new migration authority
- `effects.ts:75-90`: `HoldReleaseAuthority.by` becomes `"migration"` only; minted only in
  `lib/settlement/holdRelease.ts` (scripts may not import `effects.ts`, `settlementImportGraph.test.ts:67-72`; they import
  `holdRelease.ts`, as `void-reconciliation.ts` imports its `lib/settlement` module).
- `releaseHoldDraftsForMigration(cap: SystemTarget, { write })`: input = the persisted pointers
  `SELECT id, exchange_reservation_id FROM orders WHERE exchange_reservation_id IS NOT NULL` (draft id + owning order id
  are explicit data; never found by tag/name). Per draft: read `draftOrder(id){ id status order { id } }` (new query
  in `reads.ts`, schema-validated like the others) → `unreadable` | `already-gone` (null) | `completed` (status
  COMPLETED or an order: never deleted) | else `draftOrderDelete` through `releaseHoldDraft`, then **read back**:
  null → `deleted`, present → `still-exists`.
- Per-draft record, one statement each: `INSERT hold_draft_releases(id, order_id, draft_order_id, outcome, detail,
  released_by, pointer_cleared)` + for `deleted|already-gone` only `UPDATE orders SET exchange_reservation_id = NULL
  WHERE id=$o AND exchange_reservation_id=$d` (conditional: a changed pointer is reported, not overwritten). Table in
  0014; append-only history; re-running is idempotent (a crash after delete reads `already-gone` next time).
- Script `scripts/release-hold-drafts.ts [--write]`: prints every draft's outcome and the remaining pointer count.
- **Deploy order:** P0 preconditions (read-only) → P1 apply 0014 by hand → P2 deploy FX (no creator, no
  `release_hold` planning) → P3 after the old deployment's functions have drained (≥ its maxDuration), run dry, then
  `--write`; re-run until every remaining pointer has a non-releasable outcome → P4 `drizzle/0015`: `ALTER TABLE orders
  ADD CONSTRAINT orders_no_exchange_reservation CHECK (exchange_reservation_id IS NULL)` (validated; it fails if any
  pointer remains → stop, Santi decides each `completed`/`still-exists` by hand). After P4 no code path can set a hold.
- Readers: cancel/revert no longer release anything (their helpers are deleted at P2; any hold of a cancelled order is
  released at P3 — pointer-driven, not state-driven). Historical `release_hold` requests keep their frozen draft id
  (`types.ts:94-98`); `judgeDraftOrderGone` already accepts a deleted draft (`evidence.ts:305-311`); after P4 the
  `clearReservation` CTE (`ledger.ts:611-618`) matches 0 rows, harmlessly.

## Edit / retain / delete map (Codex #1 + own grep)
| Site | Disposition |
|---|---|
| `lib/exchangeReservation.ts` (whole, `RESERVATION_TAG` :46) | DELETE |
| `lib/server/exchangeReservation.ts` (whole, `reserveExchangeStock` :71) | DELETE |
| `lib/submissionConfirmation.ts:22-23` imports; `:81-104` revert release block; `:305-325` reserve call | DELETE (keep `revalidatePath` :105, :327) |
| `lib/server/handlers/customer/cancelReturn.ts:14`, step 3 `:133-143` | DELETE; renumber steps |
| `lib/settlement/holdRelease.ts` (cancellation/revert mints :37-135) | REWRITE → migration authority (#8) |
| `lib/settlement/effects.ts:9-17,75-90` | EDIT (`by: "migration"`, header) |
| `app/api/webhooks/stripe/route.ts:135-136` | DELETE the stock-hold guidance lines |
| `lib/settlement/recovery.ts:94` | EDIT text ("the stock hold" removed) |
| `lib/settlement/plan.ts:53, 180, 280, 294, 313-384, 474, 498` | EDIT (#4) |
| `lib/settlement/admission.ts:15, 33-44, 116-122, 124-139` | EDIT (#4, stock read, hold) |
| `lib/settlement/facts.ts:110-113` `readDraftExists` | DELETE (`DRAFT_ORDER_QUERY` retained for run/operator) |
| `lib/settlement/exchangeOrderInput.ts:9-10, 116-117, 155-159` | EDIT (always OBEYING) |
| `lib/settlement/ledger.ts:268-312` insertAdmission, `:325-344` claim, `:418-448` recordRejected, `:657-673` recoverable | EDIT (#7); new `insertHold`, `holdOf`, `openExchangeDemand` |
| `lib/settlement/ledger.ts:493-494, 525-530, 611-618` | RETAIN (historical `release_hold` done records) |
| `lib/settlement/types.ts:9, 94-98`; `run.ts:118-127, 167-170, 180-182`; `evidence.ts:305-311`; `operator.ts:12-13, 93-106`; `scripts/resolve-operation.ts:17`; `drizzle/0007:56` kind CHECK | RETAIN (historical ops must parse, judge and be operator-resolvable; none is non-done today — P0) |
| `lib/settlement/settle.ts` | RETAIN (`runnable` already honours `after`; `claim` enforces holds) |
| `lib/replacementCatalogue.ts`; `lib/server/orderScope.ts:15, 69-103`; `handlers/customer/lines.ts:31` | EDIT (#1) |
| `lib/submissionProposal.ts:26, 96-113`; `payments.ts:16-18`; `asyncButton.tsx:80-84`; `dialogForm.tsx:12, 23-25, 236-239`; `lib/i18n/{es,en}.ts` | EDIT (#1) |
| `dialogForm.tsx:544-605` picker disable; `db/queries.ts:471-476, 497` | per Q2 |
| `db/queries.ts:563-575` `VariantInfo` comment (fields retained: the dashboard reads it, `app/dashboard/page.tsx:50`) | EDIT comment |
| `db/schema.ts:70-74` `exchangeReservationId` | RETAIN column (migration input + history); EDIT comment; CHECK at P4 |
| `scripts/audit-exchange-overcharges.ts:165,203`; `scripts/verify-311749-fix.ts:84` | RETAIN (pricing audit display; no stock authority) |
| `scripts/set-line-action.ts` | RETAIN (legacy lines; settlement's stock gate covers any CAMBIO it sets) |
| New: `lib/server/amphoraStock.ts`, `lib/stockCoverage.ts`, `lib/settlement/holdResolution.ts`, `scripts/resolve-hold.ts`, `scripts/release-hold-drafts.ts`, `drizzle/0014`, `drizzle/0015` | ADD |
| Tests DELETE: `exchangeReservation.test.ts`, `exchangeReservationAction.test.ts`; the `buildReservationDraft` half of `exchangeReservationGid.test.ts` (keep the `buildReturnInput` half) | |
| Tests EDIT (drop stale mocks): `noReturnableLinesLeft:85-90`, `replacementReturnTransactionGuard:120-125`, `returnRevertGuard:105-110`, `selfBookedSettlement:133-138`, `confirmFromSnapshot:92-97,145-150` (assert NO draft is created), `revertKeepsLiveReturnIntact:27-35,102` (its live-return refusal stays), `cancelReturn:176,252-255` | |
| Tests EDIT (behaviour): `exchangeOrderBatching:11,74-84` (OBEYING; no `release_hold`; every non-exchange op `after = exchange`), `exchangeOrderAddress:39`, `orderScopeDb:26-32,80-84` (Amphora mock: covered/short/unreadable/not ACTIVE), `support/planFixtures.ts:95`, `freshExchangeSizes.render` (Q2) | |
| Tests EDIT (historical fixtures built by the planner FX removes): `settlementEvidenceMatrix:82-90,321-345`, `settlementLedgerDb:165-170,424-434` → literal frozen `release_hold` request; `settlementHoldRelease` → rewritten for the migration authority | |

## Verification (gate: all green, single-fork suite, `tsc`, lint)
- **Unit.** Reader: each unreadable case ≠ 0. Coverage: 2 lines × 1 vs 1 → short; qty 2 vs 1 → short; D2 earlier
  demand incl. equal `accepted_at`. Plan: exchange `after:null`, every other op `after = exchange`, OBEYING always,
  no `release_hold`. Admission: covered → ops; short → one hold + one `ops_alerts` row, zero ops; unreadable → held, no
  row; blocking hold → held. `recordRejected(exchange_order)` → hold + alert + seq bump in one statement; claim refuses;
  `--release` → claimable. `--manual` → voids, `refunded`, refused with an in-flight op. Migration: each outcome;
  conditional pointer clear; rerun idempotent. Save/submit refusals and their i18n keys (es, en).
- **Revert-and-fail.** Restore `DECREMENT_IGNORING_POLICY` → "every planned exchange obeys policy" fails; set a goods
  op `after:null` → "no goods/money claimable before the exchange is done" fails; drop the admission stock read → the
  short-stock admission test admits and fails; drop the seq bump from `insertHold` → concurrency test (1) fails; drop
  the hold filter from `claim` → the rejected-exchange test re-sends and fails.
- **Concurrent connections** (pg16, pattern of `tests/settlementConcurrency.test.ts:9-15`, ≥15 rounds each): (1)
  `insertHold` vs `insertAdmission` on the same seen seq → exactly one; (2) `resolveHold --manual` vs `insertAdmission`
  → never both; (3) two `resolveHold` with different resolutions → exactly one; (4) `recordRejected(exchange)` vs
  `claim` of a dependent → the dependent is never claimed.
- **Neon-branch E2E** (local `next dev`, senders off except Amphora/Shopify reads): CAMBIO to a SKU Amphora shows 0 →
  refused at save; stock dropped between save and submit → refused at submit, nothing proposed; a seeded accepted
  submission short at Amphora → admission writes one hold + one alert row, no ops; `resolve-hold --release` → re-held
  with a new id; `--manual` → rows `refunded`, admission refuses forever; `release-hold-drafts` dry run against the
  branch's copied pointers lists outcomes.
- **After deploy (prod).** P0–P4 in order with counts before/after; first real exchange settlement: ledger shows
  `exchange_order` done before any goods/money op is claimed, request OBEYING; each of the 7 remaining sold-out lines
  (foundation plan :105-107) gets exactly one hold + one alert when it reaches the gate; no new
  `exchange_reservation_id` ever set (P4 CHECK). Then one Codex review of the code against this plan.

## FOUNDATION / PATCH self-judgement
| Mechanism | Judgement |
|---|---|
| One Amphora reader; unreadable is a value; pinned location + ITEM + exactly-one-row identity | FOUNDATION |
| Server refusal at save and at proposal, closed unions, bound to the persisted agreement | FOUNDATION |
| Exchange op as the explicit `after` gate of every sibling op (existing ledger dependency primitive) | FOUNDATION |
| `DECREMENT_OBEYING_POLICY` always | FOUNDATION (Shopify's own guard; does not allocate at Amphora — residual stated) |
| Holds as rows written on the `admission_seq` CAS, outbox in the same statement | FOUNDATION |
| Rejected exchange → hold (no silent re-send every recovery run) | FOUNDATION |
| D2 priority by `accepted_at` (made total by CHECK), equal stamps count both ways | FOUNDATION |
| Draft release by an explicit migration authority over persisted pointers, per-draft record, CHECK after | FOUNDATION |
| Picker display (Q2 A) | FOUNDATION only if B; A keeps a display-only mirror number — Santi decides |
| Accept-time promises not serialized among themselves (Q5 A) | Stated residual, not a mechanism; same class as the Amphora residual |

## Decisions (Santi, 2026-11-26) — all A
1. **Stock pool location: A.** Live read 2026-11-26: Amphora `GET /inventory/Shameless` returns 353 rows, all at
   `location_id = '10'` (349 ITEM, 2 PACKAGING, 2 MARKETING PAPER), SKUs unique. `W = '10'`, explicit config.
2. **Size picker: A.** Shopify `inventoryQuantity` stays a display hint only; the server's Amphora read is the authority.
3. **An open hold's demand still counts: A** (strict decide-by-time).
4. **Resolution kinds: A** (`--release` and `--manual`).
5. **Accept-time race: A** (not serialized; the later-accepted submission is held at settlement).

## Codex plan review round 2 (final, 2026-11-26): CHANGES-REQUIRED, 3 blockers → Santi (full text: …-codex-review-r2.md)
r1 #1 #2 RESOLVED; #4 #7 #8 NOT RESOLVED because of:
- R2-1 Stock is checked only when the exchange op is first planned; a recovered pending op or a rejected op released by
  `--release` is sent later without a fresh Amphora read.
- R2-2 `--manual` records AFTER Santi's by-hand effect and cancellation's claim (`submissionScope.ts:325`) does not
  exclude it: a customer cancel can refund by card a return Santi already settled by hand.
- R2-3 Cutover: P0 runs before old functions drain, so an old cron/dashboard request can still admit a frozen
  `IGNORING_POLICY` exchange that the new recovery then executes.
Status: decided by Santi 2026-11-26 (all A) — amendments below SUPERSEDE the sections they name.

## Amendments after round 2 (binding for the implementer)
**A1 (R2-1) Stock is authorized before EVERY fresh exchange send.** In `lib/settlement/run.ts`, after `claim` and
before `dispatch`, an `exchange_order` op on a fresh attempt (claimed from `pending` or from `rejected` after a
`--release`; never a `takeOver` of a `dispatched` op, which stays evidence-only) calls
`authorizeExchangeSend(op)`: demand = the frozen `request.check.lines` (variantGid, quantity) — never re-derived from
rows; Amphora read and `earlier` demand exactly as #2 (accepted_at of this op's submission, itself excluded).
- covered → `dispatch` as today.
- short → ONE fenced statement (op's `lease_gen` + submission `admission_seq` CAS): op back to `pending`, owner/lease
  cleared, attempt NOT consumed; `INSERT settlement_holds (cause 'stock-short', detail = shortfall)`; outbox row. The
  open hold then blocks `claim` (#7).
- unreadable → ONE fenced statement: op back to `pending`, owner/lease cleared, attempt not consumed; no hold, no
  alert (transient); run result `wait`. Repeated unreadable is reported by the existing cron digest only.
Admission keeps its own stock read (#4) so a short submission is never planned at all; A1 covers the time between.
**A2 (R2-2) Manual resolution: take first, then act.** Reuse the ledger's single-owner column: `return_submissions.holder`
gains the value `'manual'` (migration 0014 widens `return_submissions_holder_check`). `resolve-hold.ts` becomes:
- `--take --hold <id> --by <who>`: ONE statement under the submission CAS: hold open AND state='accepted' AND
  (holder IS NULL OR (holder='settlement' AND no op of the submission is `claimed|dispatched|unresolved`)) →
  `holder='manual', holder_since=now()`, `settlement_holds.taken_by/taken_at` set (new columns), every not-done op
  → `void`. Refused otherwise, with the reason. Cancellation (`submissionScope.ts:325` requires `holder IS NULL`),
  admission, `claim` and A1 all refuse a `manual` holder — no new predicate in cancellation is needed, and a test pins it.
  Santi runs `--take` BEFORE touching Shopify/Stripe.
- `--done --hold <id> --evidence "<what was done>"`: requires holder='manual' taken on this hold; closes the hold
  (`resolution='manual'`), sets `productsorder.refunded=true` on the submission's rows; holder stays `manual` forever.
- `--release` (unchanged meaning) requires holder IS NULL or 'settlement' and is refused on a taken hold.
- A taken-but-not-done hold older than 24h is listed by the existing settlement-recovery alert digest until `--done`.
**A3 (R2-3) Cutover: the new code refuses old shapes.** `claim` (and so recovery) refuses, and records a hold for, any
op whose frozen request has an old shape: `exchange_order` with `inventoryBehaviour <> 'DECREMENT_OBEYING_POLICY'`,
`release_hold`, or a non-exchange op of a submission that has an `exchange_order` op while its own `after` is not that
op. ONE fenced statement: hold `cause='legacy-plan'` (added to the CHECK), detail = op ids, outbox row; ops untouched.
Resolution by `--take/--done` or `--release` after an operator voids them. Shapes are read from the frozen request
(explicit data), never from deploy timing. P0 becomes informational; the 0015 CHECK still waits for P3.
**Tests added:** recovery and `--release` with Amphora 0 / Shopify positive → no orderCreate, one hold; `--take` vs
customer cancel in both orders on two connections; cancel eligibility snapshot taken before `--take` → refused; an op
frozen with `DECREMENT_IGNORING_POLICY` → never dispatched, one `legacy-plan` hold; revert-and-fail for each.

## § As built (implementer, 2026-11-26) — where the code differs from, or decides inside, the text above
Branch `feat/fx-exchange-stock`. Nothing below changes a decision (1–5, A1–A3); each item is either a detail the text
left open or a deviation the code forced. Coordinator: review each.
1. **W is a code constant.** `SHOPIFY_WAREHOUSE_ID = "10"` (`lib/server/amphoraStock.ts:36`), explicit, not an env var.
2. **Reader signature.** `readAvailable(need, demand = [])`: SKUs of `need` AND `demand` (other customers' open lines)
   are mapped in ONE `getVariantSkusByIds` call; a demand variant with no SKU fails the read closed (unattributable
   demand); only `need` SKUs are validated at Amphora (demand on another SKU cannot change the answer). Extra
   unreadable reasons beyond §#2: `amphora-transport:<msg>`, `amphora-body` (no `inventory_levels` array),
   `shopify-skus:<msg>`, `bad-variant:<id>`. "Two product_ids" is covered by `ambiguous` (>1 row at W).
3. **Q2 (A) picker — Decision 2 as Santi chose it.** `dialogForm.tsx` `offered = isOfferedProduct({status}) &&
   inventoryQuantity > 0`: the picker keeps greying out sizes from Shopify's number (`freshExchangeSizes.render`
   unchanged); the server's Amphora read is the authority at save, submit and settlement. Codex FX code review #5
   judged this PATCH (Amphora may have a unit Shopify's mirror shows as 0, and the customer cannot pick it). Santi,
   2026-11-26, keeps it: "worst case a size shows greyed out for a few minutes after it comes back in stock". Not a
   deviation to fix.
4. **One coverage module for all three call sites**: `lib/settlement/stockGate.ts` — `exchangeCoverage` (admission +
   A1, `earlier` = accepted_at ≤ mine, itself excluded), `acceptCoverage` (submit: whole agreement basket, `earlier` =
   all open demand), `lineCoverage` (save: this row + the order's other unconfirmed CAMBIO rows whose SKU equals this
   row's, read in the same call).
5. **Plan.** The exchange op is planned whenever the submission has a non-approved CAMBIO line and no exchange op
   exists — independent of `admit` — because every sibling's `after` references it (FK). `expandAdmission` takes the
   approved set so approved (money-only) CAMBIO lines are not dragged in. `planAdmission` also holds
   `taken-by-hand` for `holder = 'manual'`.
6. **Admission hold check runs for EVERY admission**, not only when the exchange is newly planned: `holdOf` first →
   `held:stock-held:<id>` (any open hold, whatever its cause) / `held:resolved-by-hand:<id>`; then `taken-by-hand`.
   `insertAdmission`'s CAS refuses a blocking hold regardless; the early check only names the reason.
7. **Fence predicate.** `insertAdmission`, `insertHold` use `(holder IS NULL OR holder = 'settlement')` instead of
   `holder IS DISTINCT FROM 'cancellation'`, so a `manual` holder (A2) is refused too.
8. **Hold ids are generated in JS** (`randomUUID`) so each hold's outbox row (`settlement-held:<id>`, built by
   `holdAlert`, `ledger.ts:111`) carries its own `resolve-hold` commands; the order number is filled in SQL.
9. **A1 details** (`run.ts` `authorizeExchangeSend`; `ledger.ts` `returnClaimForStock`). Short: the statement's
   first CTE is the submission seq CAS on the seq read at authorization; if it lost, nothing is written, the run
   returns `not-claimed` and the undispatched claim lapses with its lease (reclaimable, never sent). Unreadable:
   fenced on owner + lease_gen + never-dispatched only, result `wait` with the reader's reason. Attempt returned as
   `GREATEST(attempt-1, 0)`. **"Reported by the existing cron digest" (review #6):** `runOutcome` keeps the reason;
   recovery's report carries `ran[].reason`, and every op left `wait` is in the recovery digest
   (`enqueueOpsAlerts`, key `exchange-stock-unreadable:<op id>:<UTC day>`, the taken-hold digest's mechanism: once a
   day per op while it repeats). Never a hold. The digest fires on the first unreadable run of a day, not after N
   runs: nothing records a count, and permanent reasons (`no-sku`, `not-at-amphora`, `ambiguous`, `bad-count`) need
   a human on day one.
10. **A3 details** (`ledger.ts` `legacyShape`, `legacyHoldCtes`, `claim`, `takeOver`). CORRECTED after Codex FX
    code review #1: the first version claimed a dispatched legacy op "stays evidence-only through `takeOver`" — false,
    `takeOver` checked neither A3 nor the exchange dependency, and recovery re-sent a legacy sibling whose evidence
    was absent while its exchange was pending and the submission held. Now: `claim` refuses a legacy op in a state it
    would take (pending / rejected / expired undispatched claim); `takeOver` (recovery's re-send authority) refuses
    one in a state it would take over (dispatched over a lease ago / expired takeover claim). Both record the
    `legacy-plan` hold in the same statement (shared CTEs). `takeOver` also requires what `claim` requires: its
    `after` op done, no blocking hold, no manual holder. Evidence is always read first and applied
    (`recoverDispatched`), so a legacy dispatched op is observed and completed from evidence only — absence never
    authorizes its replay. A gift card (whose re-send was its probe) is read instead when its re-send is refused; a
    search miss is `unresolved` (the existing `judgeGiftCardSearch` rule). The hold's `detail.operations` lists every
    not-done legacy op of the submission; no hold is added if a blocking hold or a manual holder already exists. The
    legacy alert's body names the submission. **Absent evidence + refused re-send → `unresolved`** (Codex fix check,
    2026-11-26): left `dispatched`, such an op was a dead end (`--take` refuses in-flight ops, `resolve-operation`
    takes only `unresolved` ones, `--release` just let recovery re-create the hold). `takeOver` now answers
    `taken | refused | not-ours` (`refused` = same fence, aged, replayable kind, but not authorized: legacy shape,
    `after` not done, blocking hold, manual holder). On `refused` with absent evidence, `recoverDispatched` records
    the op `unresolved` through the existing `recordUnresolved` on its own fence, with its atomic "SETTLEMENT NEEDS A
    HUMAN" outbox alert naming `resolve-operation`. Absence is never recorded as done and never authorizes a replay;
    the legacy-plan hold stays. The operator resolves the op with `resolve-operation --done|--rejected`; then
    `--take` (nothing in flight) or `--release` works. Positive evidence still records `done`. `not-ours` (another
    worker moved the fence) changes nothing.
11. **A2 CLI** (`scripts/resolve-hold.ts`, `lib/settlement/holdResolution.ts:68`): `--take [--by]`,
    `--done --evidence [--by]` (resolved_by = `--by` or the taker), `--release --evidence [--by]`. §#7's `--manual`
    is replaced by `--take`/`--done` per A2. Every verb is ONE statement whose first CTE is the submission seq CAS.
    `--take` sets `holder='manual', holder_since=now()`, `taken_by/at`, voids every not-done op; `--done` sets
    `resolution='manual'` and `productsorder.refunded=true` for the submission's rows. Reported counts are the
    write's own (a stale pre-read is never compared after commit).
12. **A2 digest** (`recovery.ts:105`): taken-not-done > 24 h → `enqueueOpsAlerts` with key
    `hold-taken-not-done:<hold id>:<UTC day>` (the recovery's existing digest path, not the atomic outbox).
13. **Migration authority** (`holdRelease.ts:70`): dry run reads and reports (`would-delete` for an open draft),
    writes nothing; a draft with an `order` is `completed` whatever its status; a failed read-back after the delete
    is recorded `unreadable` (pointer kept; the next run reads `already-gone`). `released_by` = `--by` or the OS user.
    New read `HOLD_DRAFT_QUERY` (`reads.ts:140`) checked against the bundled Admin 2026-04 schema
    (`draftOrder(id: ID!)`, `DraftOrder.status: DraftOrderStatus!`, `DraftOrder.order: Order`) offline — the
    toolkit's `validate.mjs` posts telemetry to Shopify, so it was not run.
14. **0014 naming.** `settlement_holds_resolution_fields_check` (Postgres' auto-name for the column CHECK took
    `_resolution_check`); A2's columns add `settlement_holds_taken_check`, `_manual_taken_check`,
    `_release_untaken_check`. Review #4: each populated branch requires the actor/evidence `IS NOT NULL` before the
    trimmed length (`length(trim(NULL))` is NULL and a NULL CHECK passes). 0014 is applied nowhere yet; its
    `CREATE TABLE IF NOT EXISTS` would NOT add the corrected CHECKs to a table created by an earlier draft.
15. **`amphora.ts` `getConfig` → exported `amphoraConfig`** so the stock reader shares key/tenant/base/shop.
16. **Test doubles.** The checkout unit tests (`checkoutBinding`, `exchangeFallbackAlert`, `selfBookedFee`,
    `submissionProposalTender`) mock `@/lib/settlement/stockGate` as covered (they do use a database — Codex
    corrected the first wording); every stock behaviour
    test mocks the reader at `@/lib/server/amphoraStock` (`tests/support/amphoraStockMock.ts`).
17. **Commit granularity.** `c64392f` (plan) does not typecheck on its own (admission still passed `reservation`);
    the next commit `1bb8de0` restores it.
18. **Review fixes (Codex FX code review, 2026-11-26, CHANGES-REQUIRED; implementation mistakes, same spec).**
    - **#2 dispatch serializes on the submission** (`ledger.ts` `dispatch`): ONE transaction, the F1 §10 pattern
      (`claimForCancellation`): (1) `SELECT … FROM return_submissions … FOR UPDATE` (the row every hold writer locks
      through its `admission_seq` bump), (2) the dispatch UPDATE on a fresh READ COMMITTED snapshot with
      `NOT blocking hold`, `NOT manual holder` and the existing owner/lease_gen/state/lease checks. A hold committed
      after a claim now stops that claim's send; a hold writer that comes second waits and commits after the send.
    - **`resolveHold` takes the same lock first** (all three verbs: `[FOR UPDATE, statement]`), so `--take`'s
      in-flight check never reads a snapshot older than a dispatch that committed while it waited (otherwise its
      void CTE could void a just-dispatched op). Not in the review's list; same mechanism, closes the take↔dispatch
      interleaving review #7 asked for.
    - **Lock order, found by the new race (10)** (deadlock): `claim`'s A3 hold wrote the hold row (its one-open
      unique entry) before bumping `admission_seq`, while `insertHold` bumps first. Every hold writer now locks the
      submission row first and writes the hold FROM that bump (`legacyHoldCtes`; `recordRejected(exchange)`: op →
      seq → hold), the order of `insertHold`, `returnClaimForStock`, `resolveHold` and `dispatch`. This is §#7's
      "first CTE is the submission CAS"; the spec's listing of `recordRejected` (hold, then seq) is reordered.
    - **#3 D2 in SQL** (`ledger.ts` `earlierExchangeDemand(submissionId)`): `s.accepted_at <= m.accepted_at` where
      `m` is that submission's own row looked up by id inside the query; no Date is passed back.
      `SubmissionForAdmission.acceptedAt` is removed; `exchangeCoverage(submissionId, lines)`; a submission with no
      `accepted_at` (or none at all) → `unreadable:no-accepted-at`. `openExchangeDemand()` (accept time) keeps all
      open demand.
    - **#1, #4, #6**: items 10, 14, 9 above. **#5**: item 3 (Santi's decision, no change). **Fix check (#10
      blocker):** a dispatched op whose re-send is refused and whose evidence is absent goes `unresolved` (item 10),
      so every recovery dead end lands on the existing operator path. This also covers a non-legacy op under a
      blocking hold or with its exchange not done: it no longer waits silently for the hold to clear.
    - **#7 interleavings** (pg16 `settlementHoldsConcurrency` 6–11): claim → A3 hold → dispatch; claim →
      stock-short hold → dispatch; a paused hold writer holding the lock (dispatch blocks, then refuses); the same
      lock rolled back (dispatch blocks, then sends); dispatch vs two hold writers at once (15 rounds); `--take` vs
      release → claim → dispatch (15 rounds). PGlite (`settlementHolds`): Codex's 4-step walk ending resolvable
      (dispatched + absent → unresolved + alert → `resolve-operation --done` → `--take`/`--done`), the same op with
      positive evidence → done, legacy gift card, gated sibling before its exchange is done and under a blocking hold
      (both → unresolved, never re-sent), a takeover lost to another worker (unchanged); D2 microsecond-equal / -earlier; the unreadable digest. Migration: each NULL field alone.

## Code review status (2026-11-26)
Codex code review of ff38737: CHANGES-REQUIRED (1–7) → fixed 255410c…f47e34c → fix-check: 1–7 RESOLVED, #10 blocker →
ce6862f → fix-check 2: **APPROVED** (docs …-fx-codex-code-review.md, -fixcheck.md, -fixcheck2.md). Verified by the
coordinator: tsc clean, single-fork suite 157 files / 1731 tests.
Operator rule (existing authority, Codex fix-check 2 #3): `resolve-operation --rejected` re-authorizes a fresh send with
a new idempotency key, so use it ONLY when Shopify proves the effect never happened; a search miss is not proof.

## E2E verification (2026-11-26, FX @ 10b9a59, Neon branch fx-e2e; Shopify/Amphora read-only, no live writes) — 7/7 PASS
1. 0014 applied cleanly on a copy of live data. `release-hold-drafts` dry run: 42 pointers → 42 `would-delete` (OPEN),
   branch unchanged (md5 of pointers identical, 0 release rows).
2. 0015 after clearing pointers (branch only): CHECK validated; setting a pointer fails.
3. Real `admit()` for #313127 (SKU 20240802, Amphora 0): one `stock-short` hold, one outbox alert, 0 ops, seq +1; a
   second admit → `stock-held`, no duplicate.
4. `--take` → holder `manual`; `claimForCancellation` never "claimed" (answers `in-transit`/`settled`, not "taken by
   hand" — wording gap, not safety); `--done` → resolved manual, row refunded; next admit → `resolved-by-hand`.
5. Portal save on #38594: sold-out Medium → `replacement-unavailable` + Spanish message, row unchanged; Small saves.
6. Portal submit with the sold-out variant → refused before any Shopify/Amphora/Stripe call; Shopify returns unchanged.
7. Exemption reverted, temp route deleted, worktree clean.
Note: `admit` needs the Next runtime (React `cache()`); release-hold-drafts and resolve-hold run under plain tsx.

## Rollout (2026-11-26) — DONE
- P0 read-only prod check: 0 in-flight ops (33 legacy unresolved only), 0 bad accepted/holder rows, 44 pointers.
- P1 0014 applied by Santi; verified tables + 3 CHECKs.
- P2 F1 merged (#51, `142d1b1`), FX merged (#52, `f44bd7e`); production deploy success 17:59Z; `/` 200, protected routes 401.
- P3 `release-hold-drafts` dry 44/44 OPEN, then `--write` at 18:09Z: 44 deleted, 0 pointers, 44 `hold_draft_releases` rows.
- P4 0015 applied by Santi; `orders_no_exchange_reservation` validated.
Still to observe: the first real exchange admission (expect a `stock-short` hold + alert for the 7 sold-out cases when they pass the gate).

## Sold-out cases: customer answers + Santi's decisions (2026-11-26 ~18:40Z)
All 4 CAMBIO lines will be HELD at warehouse arrival (replacement SKUs at 0); resolve by hand: `--take` → act → `--done`.
Agreements are frozen: never rewrite `action`/`new_variant_id` in place.
| Order | Line | Decision | Amount / action at arrival |
|---|---|---|---|
| #312939 | 1345 | refund | 38,65 € (35,15 garment + 3,50 unused outbound; paid 8,50 upfront = 5,00 return + 3,50 outbound) |
| #313061 | 1322 | refund | 22,80 € (SELF, not posted yet) |
| #313090 | 1321 | refund | 20,90 € |
| #313008 | 1327 | Mad Air Knit M (20261903) instead, NO price difference (goodwill) | create order by hand |
| #313470 | 1448, 1450 | customer cancels himself in the portal | nothing |
| #313114 | 1374 | customer cancels SELF, redoes with Correos, pays 5,00 € | check the new Amphora registration after |
