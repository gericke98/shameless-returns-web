# FX: an exchange's replacement is backed by Amphora's stock (HEAVY) — plan rev 1, 2026-11-26

Base: `feat/f1-server-boundary` @ 3590c79 (FX ships after F1). Parent: foundation plan §FX (research answer recorded there).
Santi's decision (2026-11-26): **Amphora's stock is the truth**; no Shopify-side hold.

Owner's rules, verbatim:
1. Fix the root cause. Never a heuristic, tie-breaker, special case, flag, retry, regex over words, "until phase N" stopgap, or workaround for an existing weakness. If the root fix is bigger than the ask, say so and do the root fix (or stop and ask) — never ship the patch silently.
2. Before designing anything, read the official skills and docs for what already exists, and reuse it instead of rebuilding. State in the design which official primitive you use, or why none fits.
4. Identity, state and ownership are explicit data with stable ids — never derived from content, position, object identity, names, lineage or quote text.

## Root weakness
We promise a replacement against a number that is not the warehouse's (a Shopify draft hold Amphora never sees), and at
settlement we tell Shopify to ignore stock (`DECREMENT_IGNORING_POLICY` when a hold existed,
`lib/settlement/exchangeOrderInput.ts:159`). Nothing on the server ever reads stock. Amphora allocates only when it starts
preparing an order (tested: NEW orders and drafts count nowhere), so no Shopify object can reserve there.

## Foundation
1. **One stock reader, Amphora's own number.** `lib/server/stock.ts`: `readAvailable(skus) → Map<sku, number> | unreadable`
   from `GET {AMPHORA_COMPANY_API_URL}/inventory/Shameless` (Company API v1.15.0 `InventoryLevels.available_quantity`,
   "stock available to place new orders"). Variant → SKU through one Shopify read (`ProductVariant.sku`). Unreadable is a
   value, never 0 and never "enough": callers refuse/hold on it.
2. **Accept: the server refuses a replacement Amphora cannot cover.** `saveLine` (CAMBIO) and `submitReturn` call the
   reader; refusal `replacement-unavailable` (closed union, i18n) and `stock-unreadable`. The size picker keeps reading
   `ProductVariant.inventoryQuantity` for display only; the server is the authority.
3. **Settle: the replacement is created only against real stock.** Admission reads Amphora for the exchange lines'
   SKUs. Enough → plan `exchange_order` with `DECREMENT_OBEYING_POLICY` always (Shopify `orderCreate`
   `inventoryBehaviour`, documented; variants are `inventoryPolicy: DENY`, tested), so Shopify also refuses a mirror that
   says 0. Not enough → the submission is **held with a recorded state**, not admitted (see 4). `holdExisted` and
   `DECREMENT_IGNORING_POLICY` are deleted.
4. **"Replacement unavailable" is explicit data.** New table `replacement_shortfalls(id uuid, submission_id, productsorder_id,
   sku, needed, available_seen, detected_at, decision NULL|'other_variant'|'refund', decided_variant_id, decided_by,
   decided_at)`, `UNIQUE(submission_id, productsorder_id) WHERE decision IS NULL`. Admission writes it once and
   `alertOps` (outbox) once; the cron's held reason is `replacement-unavailable:<shortfall id>`. While an undecided row
   exists, admission never plans goods/money/exchange ops for that submission (nothing half-settles).
   A decision is recorded by `scripts/decide-shortfall.ts --shortfall <id> --variant <gid> | --refund --write`
   (operator, `systemTarget` per F1), which re-reads stock for `--variant`. `other_variant` rewrites the line's agreed
   replacement through the agreement path (new agreement revision, not an UPDATE of `new_variant_id` in place);
   `refund` converts the line to the refund lane in the agreement. The next cron run settles from the new agreement.
5. **Drop the draft holds.** Stop creating them (`reserveExchangeStock` call in `lib/submissionConfirmation.ts:313`
   removed with its module). Existing 44 `exchange-reservation` drafts (29 live, 15 expired) are released once through the
   existing `releaseHoldDraft` (`draftOrderDelete`), clearing `orders.exchange_reservation_id`, by a `--write` script with
   before/after counts. The `release_hold` op kind stays readable for history; admission no longer plans it.
   The 11 done `release_hold` ops and 251 done `exchange_order` ops are history; the 9 `unresolved` `exchange_order` ops
   are legacy-reconciliation records (resolved_by `reconcile-legacy`, never dispatched) and out of scope.

## Residual, stated
No reservation: between accept and settlement a unit can sell; the customer then gets the explicit choice (4), never a
stockless order. Between the settlement stock read and `orderCreate` (seconds) a race remains; Shopify's DENY policy
catches it if the mirror has caught up, and otherwise Amphora's own stock exception (`reserved`, tested on #313142) is the
warehouse's existing path. A real reservation needs Amphora (questions below).

## Decisions for Santi (A recommended)
- D1 Refund after the size is gone: A = refund everything the customer paid for this line (garment + any exchange fees
  paid by card), because the failure is ours. B = garment only, minus the return fee, as for a normal refund.
- D2 Promise netting at accept: A = available-to-promise = Amphora available − units of our own open accepted exchanges
  for that SKU (explicit data: open submissions), so two exchange customers cannot both be promised the last unit.
  B = Amphora available alone.
- D3 Customer self-service choice page: A = separate LIGHT phase after FX, writing the same `replacement_shortfalls`
  decision; until then ops records it with the script after emailing the customer. B = inside FX.

## Questions for Amphora (sent by Santi)
1. Does your Shopify connector import an order whose fulfillment order is on hold / unpaid, and does an imported NEW or
   EXCEPTION_HOLD order ever count in `reserved`/`committed`? 2. Can `flags:["reserve_stock"]` be used for a B2C exchange
   shipment, and how does it relate to the Shopify order? 3. Can your sync push physical stock (`on_hand`) instead of
   `available`?

## Verification
- Unit: reader (unreadable ≠ 0), refusals, admission with enough/short/unreadable, decision script (stock re-read).
- Revert-and-fail: put `DECREMENT_IGNORING_POLICY` back → a test that asserts every planned `exchange_order` obeys policy
  fails; remove the admission stock read → a short-stock test admits and fails.
- Neon branch E2E: a CAMBIO to a sold-out SKU is refused at save; an admitted submission whose SKU is 0 at Amphora is held
  with a shortfall row + one alert and plans nothing; decide → next run settles.
- After deploy: the 9 currently-unbacked units are each held as shortfalls when they reach the gate; no `orderCreate`
  with IGNORING appears in the ledger again.
- One Codex review of this plan, then one of the code.
