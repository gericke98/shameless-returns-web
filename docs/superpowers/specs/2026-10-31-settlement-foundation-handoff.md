# Settlement foundation handoff

31 Oct 2026 · Santi

Returns are now paid from an agreement frozen before checkout, through a ledger that makes every payout exactly-once. All three phases are live in production; the only thing not yet seen in production is a real payout, expected on the 07:00 UTC run of 1 Nov.

Living copy: https://claude.ai/artifact/CAX2p21k5m7x55VWaR1uCC

## What shipped

Three phases, each deployed to production with its migrations applied by hand before the code.

| Phase | What it does | Code on main | Migrations | Deploy |
| --- | --- | --- | --- | --- |
| S1 — Agreement | The portal saves what the customer is owed (lines, fee, net, Stripe charge) as a `return_submissions` row before checkout. | `d465254`, `48708bd` (deploy commit `354963c`) | 0006 | 30 Oct |
| S2 — Ledger | Settlement executes that agreement instead of recomputing it. Every external effect (refund, gift card, exchange order, hold release) is one `settlement_operations` row, claimed and dispatched exactly once. A recovery cron finishes anything interrupted. | `c830d3e` | 0007, 0008 | 30 Oct, `kxfwtm25m` |
| S3 — Legacy cutover | 603 settled pre-ledger lines reconciled against Shopify and Stripe; returns found paid are recorded so nothing can pay them twice. Adds approvals, the replacement-order census and the void path for a wrong record. | `fdcae06` | 0009, 0010, 0011, 0012 | 31 Oct 01:47 UTC, `bgi7ugs4z` |
| Dashboard fix | The price column shows each line's total rounded once (was "15.505 €"). | `b889285` | — | 31 Oct, `90ueizvwo` |

Tests: 1458 passing with `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`.

## How a return is paid now

The amount is fixed when the customer submits; nothing recomputes it at payout.

1. **Agreement (S1).** The portal writes the submission and its lines (returned value, replacement value, fee, net, Stripe charge) before checkout. A paid return becomes `accepted` from the Stripe webhook; a free one at submit.
2. **Eligibility.** The daily auto-approve cron (07:00 UTC, max 5 orders per run) only settles an order when Amphora shows it `RECEIVED`/`PROCESSING_WAREHOUSE`/`FINISHED`, the receipt is at least 2 days old, every garment was counted in, and the Shopify return is still `OPEN`.
3. **Admission.** In one statement the submission is claimed (holder = `settlement`) and one operation per external effect is written with its frozen request.
4. **Dispatch.** Each operation is claimed, marked `dispatched`, then sent to Shopify. Refunds go through `returnProcess` with `@idempotent`; gift cards use their code as the replay key; exchange orders use `sourceIdentifier`.
5. **Finalize.** `productsorder.refunded` and `submission_lines.settled_at` are set only when every operation of the line is `done`.
6. **Recovery.** Every 15 minutes, `/api/cron/settlement-recovery` finishes anything interrupted, judging a `dispatched` operation from Shopify's own evidence instead of resending it.

| Operation state | Meaning | Who moves it on |
| --- | --- | --- |
| `pending` → `claimed` → `dispatched` | In flight | The runner, then recovery |
| `done` | Shopify confirmed the effect; `effect_ref` holds its id | Final |
| `rejected` | Shopify refused it; nothing moved | An alert goes out; ops decide |
| `unresolved` | Cannot tell whether money moved | `scripts/resolve-operation.ts --done` or `--rejected` |
| `void` | Belonged to a voided reconciliation record | Final, history only |

A cancellation takes the same holder claim (`cancellation`), so a cancel can never race a payout.

## Production state on 31 Oct

Everything is healthy and idle: no operation is in flight, and every cron since the S3 deploy has returned 200.

| Item | Value |
| --- | --- |
| Legacy reconciled records | 510 (plus 1 voided: the wrong #34700 record) |
| Operations done (found already paid) | 507: 222 refunds, 240 exchange orders, 44 gift cards, 1 root refund |
| Operations unresolved (ambiguous) | 33, each with a "LEGACY PAYMENT UNCLEAR" alert |
| Legacy replacement orders recorded | 262; 32 have funding lines, the rest refuse online valuation until funded |
| Agreed (S1) submissions | 1: #312579, €181.50 owed, waiting for Amphora to receive it |
| Unsettled confirmed lines | 113 lines on 94 orders |
| Operations in flight | 0 |
| `AUTO_APPROVE_ENABLED` / cap | `true` / 5 per run (not provable from logs until a run settles) |

Alerts: the 191 "LEGACY EXCHANGE ORDER UNFUNDED" alerts from the backlog were held back on purpose (`accepted_at` set, `last_error` starts with `SUPPRESSED, not sent`). They only matter if one of those orders is returned, and the portal then refuses the return and raises a fresh alert with the funding command.

The 07:00 UTC run on 31 Oct settled nothing, correctly: 53 orders have no Amphora record, 29 are not in the warehouse, 5 lack a receipt timestamp, 5 are inside the 2-day wait, #311208 is short one garment and #311464 is already CLOSED in Shopify.

## Still to verify

The payout path has never paid a real customer in production; the first ledger payouts are due on the runs below. All five orders show every garment received in Amphora and an OPEN return in Shopify.

- [ ] 1 Nov 07:00 UTC run settles #312473, #312195 (2 garments) and #312151
- [ ] 2 Nov 07:00 UTC run settles #312447 and #312424
- [ ] #312579 pays exactly €181.50 to the original card once Amphora receives it (first S1 agreement end to end)

For each run, check read-only:

1. Every operation of the order is `done`, with `attempt` 0 or 1 and no `error`.
2. In Shopify, the refund's amount, currency and parent transaction match the operation's frozen `request`, and it lists `refundLineItems`.
3. The Shopify return closed itself, `productsorder.refunded` is true and `submission_lines.settled_at` is set.
4. No new `settlement-rejected` or `settlement-unresolved` alert.

If a run settles nothing and logs nothing, `AUTO_APPROVE_ENABLED` may be off: a dry run looks the same as a run where everything was held.

## Open items and parked decisions

Nothing here blocks the system; each is either closed by decision or someone else's to pick up.

| Item | Status | If it comes back |
| --- | --- | --- |
| 21 legacy lines Shopify shows unpaid, plus 31 exchange "swap" candidates | Closed by Santi on 31 Oct: not paid. Real exposure is ~€550 across 11 refund lines (latest #311811, #311926). | Pay one with an approval file: `productsorder_id,amount_cents,approved_by`, then `reconcile-legacy.ts --approve-file` dry run, then `--write`. |
| 33 ambiguous legacy payments | Left unresolved; nothing pays them. | `scripts/resolve-operation.ts --op <id> --done` or `--rejected` after checking Shopify. |
| 37 lines with no action set (6 pending) and 5 needing a human (rows 181, 182, 184, 190 and one more) | Closed; nothing pays them. | `scripts/set-line-action.ts` for the 6; the 4 named rows carry another order's Shopify return. |
| 5 returns paid twice (gift card and card refund) | 3 cards with balance deactivated on 30 Oct, stopping €108.93; ~€142.51 was already spent. | Recovering the spent part is a customer-service call. |
| #312512 | Amphora approved it with no carrier, so no collection is booked. | Chase in Amphora; not a settlement bug. |
| #311464 | CLOSED in Shopify, 2 of 3 garments never received. | Likely settled by hand; confirm and leave. |
| US outbound fee for exchanges (€12.96) | Parked: Santi expects ~€20, which matches the carrier cost rather than a Shopify rate. | A decision on the pricing basis, not a code fix. |
| Short-receipt Phase 2 | Next project; was waiting for this ledger. | Write the one-page plan on top of `settlement_operations`. |
| "Closed by Santi" record for the closed legacy lines | Not built (would need a migration). | Only if future reports listing them become a nuisance. |

## Runbook

Run everything from the repo root. Every script dry-runs by default; add `--write` only after reading the dry run. Scripts use `npx tsx --tsconfig tsconfig.scripts.json scripts/<name>.ts`.

| To do this | Run |
| --- | --- |
| Open a SQL session on production | `psql "$(grep '^DATABASE_URL' .env \| cut -d= -f2- \| tr -d '"'"'")"` (database `ShamelessReturns`) |
| Apply a migration | the same, with `-f drizzle/<file>.sql`. Always before the deploy that needs it; nothing applies migrations automatically. |
| See what is in flight | `SELECT kind, state, count(*) FROM settlement_operations WHERE state IN ('pending','claimed','dispatched') GROUP BY 1,2;` |
| Decide an unresolved operation | `resolve-operation.ts --op <id> --done` (the payment you found) or `--rejected` (nothing moved) |
| Pay a legacy line by approval | `reconcile-legacy.ts --out <csv> --approve-file <csv> --by santi`, then the same with `--write` |
| Re-run the legacy reconciliation | `reconcile-legacy.ts --out <csv> --by santi` (idempotent; already-recorded lines are skipped) |
| Void a record built on another order's return | `void-reconciliation.ts --line <productsorder id> --by <name> --evidence "<why>"` |
| Fund a legacy replacement order | `fund-replacement-line.ts` (the alert prints the exact command) |
| Record a human call on a Stripe session | `decide-effect.ts` (binds or excludes) |
| Check no pre-S1 checkout is open | `check-legacy-stripe-sessions.ts` (expect 0 open) |
| Read cron results | `vercel logs <prod deployment url> --since <ISO time> --json`, then read `responseStatusCode` |
| Turn auto-approve off | `vercel env rm AUTO_APPROVE_ENABLED production -y`, then `vercel redeploy <prod url> --target production` |
| Push to production | `gh auth switch -u gericke98 && git push origin HEAD:main` (Vercel deploys main) |

Secrets live in `.env` and in Vercel; this doc holds none.

## Gotchas

- **A return id is not ownership.** The old confirm stamped one order's Shopify return onto other orders' rows that shared a variant. Trust a `return_id` only when Shopify says the return's order is the row's order (`lib/settlement/returnOwnership.ts`).
- **One order can replace several lines.** #311524 swapped two garments into one exchange order; anything keyed per line must key the order by its id, not once per line.
- **A migration file must match what production ran.** Never edit an applied migration; add the next one. A green build is no evidence a migration ran: check `information_schema` on `ShamelessReturns`.
- **Vercel marks cron lines `error` for a Node warning.** The `url.parse` deprecation goes to stderr; read `responseStatusCode` from `vercel logs --json` instead.
- **A held run and a dry run look identical.** The auto-approve route logs only what it attempts, so silence proves nothing about `AUTO_APPROVE_ENABLED`.
- **`productsorder.price` is per unit and unrounded.** Value a line with `lineTotalCents(price, quantity)`, rounded once (2 units at 15.505 = €31.01).
- **Settlement's money boundary is `lib/settlement/effects.ts`.** Every Shopify mutation that moves money goes through it; every export of a `"use server"` file is a public endpoint.
- **Postmark 200 is not delivery, and preview shares the production database.** Look up the message after sending; never QA a payout on a preview.

## Where things are

| What | Where |
| --- | --- |
| S2 plan and decisions | `docs/superpowers/specs/2026-10-30-settlement-S2-ledger-plan.md` |
| S3 plan and decisions (D1–D7) | `docs/superpowers/specs/2026-10-30-settlement-S3-legacy-plan.md` |
| Ledger, runner, recovery, effects | `lib/settlement/` (`ledger.ts`, `run.ts`, `effects.ts`, `recovery.ts`, `settle.ts`) |
| Legacy reconciliation | `lib/settlement/reconcile.ts`, `reconcileLedger.ts`, `returnOwnership.ts`, `voidReconciliation.ts` |
| Crons | `app/api/cron/auto-approve`, `settlement-recovery`, `ops-alerts`, `receipt-shortfalls`, `amphora-sync` (schedules in `vercel.json`) |
| Operator scripts | `scripts/` (see Runbook) |
| Migrations | `drizzle/0006` to `drizzle/0012`, all applied in production |
| Alert outbox | table `ops_alerts`, sent 5 at a time by `/api/cron/ops-alerts` |
| Working files from the 30–31 Oct run (dry-run CSVs, approval sheet, suppressed-alert list) | Local scratchpad only; regenerate with the scripts if needed |
