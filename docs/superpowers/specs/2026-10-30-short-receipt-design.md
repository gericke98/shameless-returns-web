# Short receipt, Phase 1: detect, record, alert ops (no customer answer yet)

Status: DRAFT v3. Codex rounds used: 2 of 2 (cap). The section "v3: changes after Codex round 2"
at the end SUPERSEDES anything above it that it contradicts. Tier: HEAVY. Base sha: `51610ae`.
v1 was rejected by Codex round 1 (6/7 mechanisms PATCH). Santi split the work on 30 Oct 2026:
Phase 1 = this document. Phase 2 (customer one-click answer + a real post-receipt withdrawal
operation) is out of scope here and gets its own plan.

## Why

#312246 (Miguel): exchange of 2 crewnecks, he sent back 1. Amphora counted correctly
(`20240800 = 0`, `20252901 = 1`). The received email promised both replacements; the gate
held `short-receipt:20240800` every morning, visible only in the cron's JSON and ~1 h of Vercel
logs. 12 days, 3 angry mails, nobody told. #311208 has sat the same way since September.

**Root cause:** "the warehouse counted fewer units of a SKU than the customer declared on this
return" is a business state with no representation and no owner. Phase 1 gives it both. It
does not resolve the case (humans do, as today); it makes sure a human knows within a day.

## Mechanisms

1. **State: one row per (return, SKU) shortfall.** New table `receipt_shortfalls` (additive
   migration 0004): `id` uuid, `order_id`, `shopify_return_id` (the Shopify Return gid already
   stored on the lines as `return_id`: the explicit id of this return episode), `sku`,
   `declared_qty`, `received_qty`, `first_seen_at`, `last_seen_at`, `resolved_at`,
   `alert_stage` smallint (0 none, 1 first alert sent, 2 escalation sent),
   `alert_last_attempt_at`, `alert_last_error`. Unique on `(shopify_return_id, sku)`.
   The shortfall is recorded **per SKU, not per line**: the pool proves an aggregate shortage
   and nothing in the data says which of two same-SKU lines was kept, so Phase 1 does not pretend
   to know. A cancelled-and-rebooked return gets a new Shopify Return gid, so a new episode.
2. **Pure detector, shared with the gate.** Extract the pool computation from
   `decideAutoApprove` into `lib/receiptShortfall.ts::shortfallsBySku(pendingLines, amphora)`
   returning `{sku, declared, received}[]` (aggregate, no line attribution). The gate keeps its
   verdict strings (`short-receipt:<sku>`). Per SKU, for one return episode:
   `supply = Σ quantity_received − Σ quantity of confirmed lines already settled (refunded = t)`,
   `demand = Σ quantity of pending lines (confirmed, not refunded)`; shortfall when
   `demand > supply`. This also fixes the inherited gap Codex found (#4): today a settled line's
   received unit stays in the pool and can satisfy a same-SKU sibling. That is a behaviour change
   to the gate in the safe direction only (it can hold more, never settle more); called out for
   review, with a test for it.
3. **Host: its own sweep inside `amphora-sync`**, modelled on `actions/selfReturnSweep.ts`
   (called from `app/api/cron/amphora-sync/route.ts` every 15 min), not inside auto-approve
   (cap, 40 s budget and dry-mode coupling, Codex #6). It reuses the gate's own inputs:
   `getOrdersWithUnsettledReturns`, `getAmphoraReturns` with counts, `getVariantSkusByIds`.
   Covers domestic and international (the normal sync loop's domestic exclusion does not apply
   to this sweep). Only returns in `WAREHOUSE_STATUSES` and past `AUTO_APPROVE_GRACE_DAYS` from
   `time_received`, same constants, imported not copied. Each run:
   upsert shortfalls seen now (bump `last_seen_at`); set `resolved_at` on rows not seen now
   (count corrected, line withdrawn by a human, return settled). Resolution sends nothing.
4. **Alert, durably.** `alertOps` gains a sibling `sendOpsAlert(subject, body): Promise<{ok,
   error?}>` sharing its transport; `alertOps` keeps its best-effort contract for existing
   callers. Stage advances **only after Postmark accepts** (200). A failed send records
   `alert_last_error` and is retried on the next run (15 min), so a crash or outage delays the
   alert, never loses it. Duplicate risk is bounded to a crash between Postmark 200 and the
   stage write: accepted, it is an ops mail, not a customer mail.
   Alert body: order number, customer email, per-SKU declared vs received, Shopify return gid,
   dashboard link, and what to do (ask the customer; if kept, withdraw that line by hand;
   if sent, open the Amphora `order chn_ret` ticket).
5. **Escalation after 7 days** (Santi): unresolved and `first alert + 7 d` → stage 2 alert
   "[returns] SHORT RECEIPT UNRESOLVED 7 DAYS". Nothing after stage 2 (the case is a human's).
6. **Neutral receipt email** (Santi): on RECEIVED, `applyReturnStatus` sends the existing
   `buildTrackingUpdateEmail("received", …)` copy ("ha llegado, la estamos revisando, te
   avisaremos") instead of `buildReturnReceivedEmail`'s refund/exchange promise. No new copy, no
   counts needed at that moment. The outcome is communicated by settlement (existing mails).

## Decisions already made (Santi, 30 Oct 2026)

- Split into phases; Phase 1 has no customer answer and no withdrawal.
- If the customer says "sent" and Amphora later corrects the count, auto-settle (the gate already
  does this, and Phase 1 just resolves the row). If no reply: escalate after 7 days.
- Neutral arrival notice at RECEIVED.
- Backlog: never email a customer we already asked. Phase 1 sends no customer email, so the only
  backlog effect is ops alerts. Run the first deploy with alerts for today's rows (#311208 only).

## Out of scope / anti-goals

- Any change to money paths or the gate's all-or-nothing rule. No row ever makes the gate settle.
- Customer emails about the shortfall, answer links, line withdrawal: Phase 2.
- Alerting on ordinary waits (`no-amphora-record`, `TRAVELLING`, `within-grace`).

## Tests

Unit: `shortfallsBySku` (multi-line kept, single-line 0, same-SKU pool, qty 2 with 1 received,
refunded sibling, NaN). Gate tests unchanged. Sweep (mocked IO like `tests/amphoraSyncRoute`):
new row → one alert, stage 1; Postmark 500 → stage stays 0, retried next run; corrected count →
resolved, no alert; 7 days → stage 2 once. Receipt mail: RECEIVED sends the neutral copy.
Real test on a Neon branch preview with #312246's pre-fix rows replayed.

## Phase 0 (ships first, Santi chose A on 30 Oct): explicit return ownership

Codex #7: `matchReturnsToOrderIds` picks between same-order Amphora records by carrier presence,
first-seen order and creation time. Tie-breakers: PATCH under rules 1 and 4.

**Evidence (30 Oct, full `GET /returns?created_after=2025-01-01`, 292 records, 1 page):** zero
ids with more than one record, cancelled included (a cancelled return disappears from the list).
Amphora's return id is `SHP <shopify order id>`, and the Company API addresses every return
operation by it (`/returns/{return_id}/approve|travelling|received|cancel|shipping_label`). It is
Amphora's primary key, and there is at most one return per order on their side. The tie-breakers
resolve a state the source of truth does not produce.

**Change:** `matchReturnsToOrderIds` keys on the Amphora return `id` and nothing else.
- `orderId` = the order id inside `id` (`orderIdFromWebhook`, existing). When `external_id` is
  present it must equal that order id; a mismatch is a data error: skip that record and report it.
- Two records with the same `id` in one listing: skip that order entirely and report it. Never
  choose. (Contract violation by Amphora; a human looks.)
- Reports go to the caller as `{ matches, conflicts }`; both crons send one `alertOps` per
  conflict per run (the sweep in Phase 1 makes it durable later; for Phase 0 the conflict set is
  empty in production today).
- Delete `createdAt`/`hasCarrier`/precedence logic and their tests; replace with tests for: one
  record per id, external/id mismatch, duplicate id. `viaExternalId` stays as data (callers use it
  to relax the ownership check), no longer as a precedence input.
- Caller ownership checks (ours, international, Shopify-channel returns) unchanged.

The 2026-08-05 incident the precedence was written for (Amphora deleted our record and re-created
it in their UI) is still handled: there is again exactly one record under that `id`, now with
`external_id: null`, and it matches by `id`.

## v3: changes after Codex round 2 (coordinator's calls, not re-reviewed; Codex reviews the code once)

Round 2 verdicts: Phase 1 mechanisms 1, 4, 5, 6 FOUNDATION; 2, 3 PATCH. Phase 0 matcher with
conflict rejection FOUNDATION; Phase 0 as written PATCH (name fallback, non-durable conflict
alerts, unproven uniqueness claim). Each fix below names the finding it closes.

**Phase 0**
- **Drop the uniqueness claim.** Correctness never relies on "one Amphora return per order": the
  matcher keys on the Amphora return `id`, and any listing with two records under one `id`, or an
  `external_id` that disagrees with it, is refused for that order and reported. The 292-record
  listing is evidence the refusal path is rare, not a contract.
- **Remove the name fallback** in `app/api/cron/amphora-sync/route.ts:92`
  (`getOrderByNumberFresh(ret.name)`). No order for the id → skip and report. Rule 4.
- **Durable ops-alert outbox moves into Phase 0**, shared by Phase 1: table `ops_alerts`
  (`id` uuid, `dedupe_key` unique, `subject`, `body`, `created_at`, `accepted_at`,
  `last_attempt_at`, `last_error`). `dedupe_key` is explicit data
  (`match-conflict:<amphora return id>`, `shortfall:<shortfall id>:stage1|stage2`). Delivery
  advances only on Postmark 200. `alertOps` keeps its best-effort contract for existing callers.

**Phase 1**
- **Pool owner = the Amphora return, not the Shopify return gid** (round 2 #2). Historic orders
  carry several Shopify return gids for one parcel (`actions/updateOrder.ts:485`), and the
  warehouse counts one pool. `receipt_shortfalls` is keyed `(amphora_return_id, sku)`; the
  Shopify gids involved are stored as data. Demand = all confirmed lines of the order not yet
  settled; supply = Σ `quantity_received` − Σ quantity of settled lines of that SKU. SKU
  resolution covers settled lines too (the cron today resolves only pending variants).
- **Three-valued detector** (round 2 #1). `shortfallsBySku` returns
  `{ status: "ok" } | { status: "short", skus } | { status: "unknown", reason }`. NaN counts,
  unresolved SKUs, a missing or conflicted Amphora record all give `unknown`. The gate treats
  `unknown` exactly as today (hold); the sweep never opens OR resolves a case on `unknown`.
  Unit test: NaN supply must hold (today's `!(available >= quantity)` behaviour, kept).
- **Resolution needs evidence, not absence** (round 2 #3). A case resolves only on a positive
  observation: the detector returns `ok` for that Amphora return, or every line is settled, or
  `getReturnStatusesByIds` (existing) shows every Shopify return involved CLOSED/CANCELED. Not
  seeing the order in the candidate query resolves nothing.
- **Immutable escalation anchor** (round 2 #4): `first_alert_accepted_at`, written once when the
  stage-1 alert is accepted; escalation due at `+7 days`; failed attempts never move it.
- **Own cron route** (round 2 #5): `/api/cron/receipt-shortfalls`, every 15 min in
  `vercel.json`, its own function budget. It runs the sweep, then dispatches the `ops_alerts`
  outbox (pending rows, independent of fresh detection). `amphora-sync` is left as it is apart
  from Phase 0 and the neutral receipt email.

## Owner decisions after round 2 (Santi, 30 Oct 2026): plan APPROVED

- **Detection timing: as soon as counted.** A shortfall is evaluated once Amphora has finished the
  count (`time_processed` set, status in `WAREHOUSE_STATUSES`); before that the detector returns
  `unknown`. No settlement grace for detection (the gate keeps its own grace for payouts).
- **A shortage that comes back after resolution: reopen and restart.** Clear `resolved_at`, reset
  `alert_stage` to 0 and `first_alert_accepted_at` to NULL, increment a `reopen_count` column,
  and use it in the outbox key (`shortfall:<id>:open<n>:stage1|stage2`) so a fresh stage-1 alert
  goes out and a new 7-day clock starts.

Build order: Phase 0 (matcher + no name fallback + `ops_alerts` outbox), then Phase 1.
Next review: ONE Codex code review per phase, against this spec.
