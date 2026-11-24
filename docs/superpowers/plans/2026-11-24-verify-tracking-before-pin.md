# Verify a self-booked tracking number before Amphora pins it

Date: 2026-11-24. Tier: LIGHT (portal UI, admin screen, one additive migration). Follows #49, whose
order-number check is a labelled stopgap (Santi chose "ship now, verify next").

## Problem

`submitReturnTracking` sends whatever the customer typed to Amphora's `approve`, where `carrier_number`
and `carrier_url` are pinned **write-once**. Nothing checks that the number is a real shipment:

- #311595 and #313127 sent their order number; Amphora pinned `313127`, and the warehouse matches parcels by number.
- "Order #313127", a typo, or a number from a different parcel would pass #49's check.

## What exists (read 2026-11-24)

- `actions/shipping.ts` `obtainLastStatus` / `readCarrierMovement` call Correos's
  `localizador.correos.es/canonico/eventos_envio_servicio_auth/{n}` with our credentials.
  `lib/trackingStatus.ts` parses the response (pure and tested).
- **Live probe, 2026-11-24:**
  - It answers for parcels customers post themselves. `CD0CPS0001314360028110S` (#313127) shows "Entregado"
    today; `PQ0B7K…` (#312284) shows "Entregado" on 06/11.
  - An unknown number returns 200 with `error.codError "3"` "Sin Trazabilidad en Minerva".
  - ⚠️ `313127` returns **another parcel** (`codEnvio 6330003413121560`, `numReferencia1 "313127"`), because
    the localizador also matches references. Verification must require `codEnvio === number`.
- Self-booked so far: Correos 11, DHL 2, CTT 1, Other 5 (19 total).
- **Other carriers, probed from a server on 2026-11-24** (Santi: "we should be able to do a quick check with the
  tracking link"):
  - **NACEX:** `seguimientoDetalle.do` is server-rendered HTML.
    - `7280/13972666` gives "Estado: Entregado … martes 24/11 09:56", with the consignee "SHAMELESS COLLECTIVE
      (AMPHORA LOGI…".
    - A made-up number gives "No existe ningún albarán introducido en el sistema…".
  - **bpost:** public JSON at `track.bpost.cloud/track/items?itemIdentifier=`. A real number returns `items[]` with
    `itemCode`; an unknown one returns `{"error":"NO_DATA_FOUND"}`.
  - **Not readable from a server:** Royal Mail (403, bot protection), DHL (page times out), UPS and FedEx (bot
    protection), CTT (captcha). We do not work around these. DHL, UPS and FedEx have official tracking APIs that
    need a developer account (DHL's is free); none is set up.
- Admin actions are guarded by `isAdmin()` (`lib/requireAdmin.ts`). Ops alerts go through `alertOps`.

## Design

One rule: **a number reaches Amphora only once it is verified.** Who verifies depends on the carrier:

| Carrier | Verified by | When |
|---|---|---|
| Correos | localizador API: `codEnvio` equals the number and there is at least one event | at submit |
| NACEX | its tracking page: the page names this exact `agency/note` and has a status, and does not say "No existe" | at submit |
| bpost | its public JSON: an item whose `itemCode` equals the number | at submit |
| Any other (DHL, UPS, FedEx, CTT, Royal Mail, GLS, SEUR, An Post, MRW, Other) | ops, opening the link from the dashboard | after submit |

A check can only **confirm** a number. It never approves on a guess:
- `unknown` (the carrier says it does not know this number) refuses the submit (Q1, decided).
- `unreadable` (timeout, a layout we don't recognise, an HTTP error) falls back to ops. Our or the carrier's outage
  never blocks the customer, and never approves.

1. **Verifiers as data, next to the carriers:** `CarrierOption.verify?: "correos" | "nacex" | "bpost"`. Each one
   is a pure verdict over the carrier's response, `(payload, number) => "verified" | "unknown" | "unreadable"`,
   in `lib/trackingVerification.ts`, tested against the real payloads captured above (including Correos's
   reference false match on `313127`). The network fetch is a thin wrapper with a 10s timeout. Adding DHL later
   is one more verifier on its official API, once a key exists.
2. **State, as an additive migration:** `orders.tracking_verified_at timestamptz NULL` and
   `orders.tracking_verified_by text NULL` (`correos` or an admin email). Approve at Amphora ⇔ verified.
3. **Submit** (`submitReturnTracking`): same checks as #49, then:
   - A carrier with a verifier: check **before** the write-once claim.
     - `verified`: claim, set `tracking_verified_by` to the carrier, approve. This is today's path plus a proof.
     - `unknown`: refuse `not-at-carrier` and write nothing; the customer can correct it.
     - `unreadable`: take the ops path below.
   - No verifier, or `unreadable`: claim (write number, carrier and link), leave it unverified, **do not approve**,
     and alert ops with the order, number, link and a dashboard link. The customer sees "thanks, we're checking it".
4. **Ops confirms** in the dashboard: on a self-booked row with tracking that isn't verified, show the number and
   the link, plus **Confirm** and **Reject**.
   - `confirmSelfTracking(id)`: `isAdmin`, then a conditional UPDATE `WHERE tracking_verified_at IS NULL`,
     then approve at Amphora. A failure alerts with `describeError`.
   - `rejectSelfTracking(id)`: `isAdmin`, then clear locator, carrier and link
     (`WHERE tracking_verified_at IS NULL`). The portal shows the tracking form again, and the customer gets an
     email asking for the correct number.
5. **#49's order-number check stays** as an instant hint in the form and a server guard. It is no longer what
   keeps Amphora safe; verification is.

## Phases (each gated)

1. **Verdict and state:** `correosVerdict` with tests on real payloads (verified, unknown, the reference false
   match, unreadable), plus the migration file. *Gate:* tests green; the DDL is reviewed and, per the records,
   **the user runs it on prod** before deploy.
2. **Submit path:** the Correos check before the claim, and the pending path for other carriers. *Gate:* tests
   prove that an unknown or reference-matched number writes nothing and calls no Amphora; that a verified
   number approves once; and that a non-Correos number writes but does not approve. Mutation-checked.
3. **Ops confirm and reject:** dashboard UI and admin actions, plus the reject email. *Gate:* render tests,
   admin-guard tests, a race test (confirm vs reject), and a local E2E with screenshots at desktop and 390px.
4. **Ship:** one Codex code review, the PR, the migration run, merge = deploy, and a live check on the next real
   submission.

## Decisions

- **Q1 (Santi, 2026-11-24):** if a carrier we can check says the number is unknown, refuse it and let the customer
  retry.
- **Q2 (Santi, 2026-11-24):** check automatically through the carrier where possible (Correos, NACEX, bpost).
  Ops confirms the rest. That is the safe default for carriers that cannot be read from a server; the
  alternative, auto-approving them unchecked, is what this plan removes.
- **Open (optional):** a free DHL developer key would let DHL check automatically too (2 of 19 so far). Creating
  that account is Santi's to do.

## Not in scope

Fixing the values already pinned (#313127 `313127`, and the two 17track links): Amphora support only.
Carrier APIs beyond Correos.
