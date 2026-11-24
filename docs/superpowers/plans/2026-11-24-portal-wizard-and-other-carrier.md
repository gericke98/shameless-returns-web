# Portal wizard foundation + "Other" carrier link — plan

2026-11-24 · Tier: LIGHT (portal UI, server-action contracts, copy; no change to money math, no migration)
Decisions made (Santi, 2026-11-24): self-booking choice moves to step 2; "Other" carrier link is required, no escape.

## Why (evidence, tested)

- **#312875 crash, reproduced end to end** (local, owner order #38594, 2026-11-24): a double-click on step 2's
  Continue fires two `updateData` POSTs 0.8 s apart. `useFormState` chains `prevState + 1`, so the counter goes
  2→3→4, the payout step is skipped, and submit is live with `isCredit = null`. A single click lands on step 3.
- The summary then shows "Reembolso tradicional — 23,00 €" with nothing chosen (`lastWindow.tsx`: `credito || false`).
- **Second route (from reading the code, not tested):** "Lo envío yo" is chosen on step 4. It removes the return leg
  from the fee and can turn "nothing comes back" into "money comes back" after the payout step was correctly skipped.
  `calculatePrices` (`lib/portalPrices.ts`) ignores the method, so the client's "payout needed?" disagrees with the
  server's `buildAgreement`.
- **#312783 / #312737:** for carrier OTHER we send `carrier_url: ""`; `carrier_url` is required by Amphora's approve
  spec. Every approved OTHER ticket has a hand-entered URL. #311595 has been stuck since 15 Oct. (Probable cause:
  the real error was lost to `[object Object]`.)

## Root causes → foundations

| Weakness | Foundation | Official primitive |
|---|---|---|
| Step is a number advanced from many places (`state+1`, `position-1/-2`, `windows[3] = null`) | One `useReducer` wizard: state `{ step: "items"\|"address"\|"payout"\|"summary", payout: Tender\|null, method }`. Visible steps are **derived** from the agreement; `next`/`back` move within that list | React `useReducer` ("Extracting state logic into a reducer"); derive during render (`rerender-derived-state-no-effect`) |
| Navigation comes from a server-action return value through an effect | Step 2 calls `updateData` in its submit handler inside `startTransition`. `updateData` returns `{ ok } \| { ok:false, reason }`, never a counter. On ok → `dispatch({ type: "addressSaved" })`. Button disabled while `isPending`, so no queued resubmits | `rerender-move-effect-to-event`, `rendering-usetransition-loading`; Next 14 Server Actions returning values |
| "Payout needed?" computed three ways (`calculatePrices`, ThirdWindow inline, server) | One pure `portalAgreement(items, catalogue, legs, method, payout)` wrapping `valueBasket` → `resolveFee` → `buildAgreement`. Used by every screen; the server already uses `buildAgreement`. `calculatePrices` is deleted | Single source of truth (existing `lib/agreement.ts`) |
| Payout can be missing on the summary | Invariant in the reducer: `canSubmit = !payoutRequired \|\| payout !== null`. If the summary is current while the invariant fails, the **derived** step is `payout` (computed in render, no effect). Every basket/fee-changing event (`itemChanged`, `addressSaved`, `methodChanged`) voids `payout` in one place | Reducer invariant |
| Method chosen after the step that depends on it | `ReturnMethodChoice` moves to step 2 (already the "return method" screen); summary only shows it | — |
| A summary shows a tender nobody chose | `SummaryComponent`/`LastWindow` take `payout: Tender \| null`; no `\|\| false` | — |
| Refusal reaches the customer as the crash screen | `returnFunction` returns `{ ok:false, reason:"payout-required" }` for that refusal. The client dispatches `payoutRequired` and shows the payout step. The ops alert stays: reaching it now means the client gate drifted | Server Action typed results; `server-auth-actions` unchanged |
| OTHER sends `""` for a required field | `CarrierOption.link: { kind:"built", build(n) } \| { kind:"customer" }`. OTHER = `customer`. `TrackingCapture` shows a required URL field for it; the confirm step shows number **and** URL. `submitReturnTracking(id, carrier, number, url)` validates on the server (`new URL`, http/https only, ≤ 512 chars) **before** the write-once DB claim; it refuses with `missing-url` / `invalid-url` | Type-level union; server action validates its own input |
| Alerts print `[object Object]` | `lib/describeError.ts`: axios error → `HTTP <status> <JSON body, bounded>`, else message/stack. Replaces the 5 interpolated sites (selfBookedTracking:130, selfBookedReturn:113, shipping:282, amphoraReturn:71, opsAlert:87) | — |

## Phases (each gated)

1. **`portalAgreement` + reducer (pure).** Unit tests: double `addressSaved` stays on payout; `methodChanged` to SELF
   that makes money come back → payout required and voided; summary unreachable with a missing payout; steps derived
   correctly for net ≤ 0 / > 0. *Gate:* tests green; `calculatePrices` has no callers left.
2. **Wire the portal.** ClientOrder owns the reducer; windows receive `state`/`dispatch`; step 2 uses the
   handler + `isPending`; method choice moves to step 2; summary takes `payout`. `returnFunction` returns the typed
   refusal. *Gate:* existing render tests updated, plus new ones (double-submit, SELF route, summary never shows an
   unchosen tender); full suite green (`--pool=forks --poolOptions.forks.singleFork=true`).
3. **"Other" carrier + `describeError`.** *Gate:* `selfBookedTracking.test.ts` covers missing/invalid/valid URL and
   proves no DB write or Amphora call happens on refusal; `trackingCapture` render test; es/en copy.
4. **Real E2E** (local, owner order #38594, allowlist patch reverted afterwards): double-click on step 2 → lands on
   payout; SELF exchange route; screenshots at desktop and 390 px, side by side with the current production page.
   The tracking-capture URL field is checked in a render test only (no real self-booked order to drive).
   *Gate:* screenshots reviewed by Santi.
5. **One Codex code review** of the diff, then PRs: **A** wizard (phases 1–2), **B** carrier + describeError
   (phase 3). Independent, mergeable in either order. Deploy = push to main; no migration.

## Manual ops (not code; outstanding now)

- Contact #312875 (danielagarprie@gmail.com): no return was created; she can submit again.
- Approve in Amphora by hand with a real link: `SHP 13540873732422` (7280/13972666), `SHP 13530002227526`
  (7280/13971190), `SHP 13268102807878` (#311595). `carrier_number` is write-once.
- #312737's stored email is `@gmai.com` (a typo).

## Out of scope

The rest of the dashboard and settlement; migrating `useFormState` → `useActionState` (needs React 19 / Next 15).
