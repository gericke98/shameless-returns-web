> **Superseded (2026-07-29):** the Sendcloud lane referenced below no longer
> exists. `actions/sendcloudReturn.ts`, its label-proxy route, its email and the
> `SENDCLOUD_*` env vars were removed once Amphora took every international
> destination — international returns are collected, not dropped off. The
> Sendcloud comparisons here are kept as the record of why that call was made.

# Pre-launch Checklist — International Returns via Correos-Direct (S0159)

Status: **Blocked on CorreosID auth** · Owner: Santiago · Last updated: 2026-07-22

## Why this path

Corisa's own Correos contract is the cheapest option for EU return labels —
**FR €6.15 vs Sendcloud default €10.35**, and well below Amphora (which also
overbills ~41% vs market, per the May–Jun reconciliation). So Correos-direct is
the primary target; **Sendcloud (already built, `sendcloudReturn.ts`) is the
fast fallback** while CorreosID access is pending.

Scope: **EU lanes first** (intra-EU = no customs). **GB/US are deferred** — a
return re-entering the EU is a customs import needing Returned Goods Relief.

---

## 1. Unblock — credentials & API access

- [ ] **CorreosID token authorization** (the current blocker). Email sent to
      Correos contact. Need: confirmation the app is authorized for the token
      scope, or separate CorreosID OAuth creds.
      - Token endpoint: `POST https://apioauthcid.correos.es/Api/Authorize/Token`
        (`grant_type=client_credentials`, `client_id`, `client_secret`,
        `scope=AP3 LBS RCG`) → token in the **`idToken`** field.
      - Every API call also needs `client_id`/`client_secret` headers
        (dual policy) alongside `Authorization: Bearer <idToken>`.
      - Verify with `scratchpad/rest_preregister.py` (already wired for the full
        flow) — it should return `idToken` instead of `403 No autorizado`.
- [ ] **Labels API access** — separate "Request Access" in the Correos portal
      (Preregister creates the shipment; **Labels** produces the PDF + CN22/CN23).
- [ ] **Regenerate** the CorreosID client_secret (it was pasted in chat during
      setup).

## 2. Environment variables (Vercel — all 3 envs)

- [ ] `CORREOS_PREREGISTER_CLIENT_ID`
- [ ] `CORREOS_PREREGISTER_CLIENT_SECRET`
- [ ] `CORREOS_OAUTH_CLIENT_ID` / `CORREOS_OAUTH_CLIENT_SECRET` — only if Correos
      issues a *separate* CorreosID pair; otherwise the gateway creds are reused.
- [ ] `CORREOS_INTL_RETURNS_ENABLED` — master flag, leave **unset** until Phase 5.
- [ ] Confirm existing `USERNAME_CORREOS` / `PASSWORD_CORREOS` /
      `CODIGO_ETIQUETADOR_CORREOS` (labeller `AZXT`) are present.

## 3. Build (code)

- [ ] `actions/correosReturn.ts` — production module (not yet written; the API
      contract is proven via the scratchpad harness):
      - Fetch + cache the `idToken` (~55 min TTL).
      - `POST /admissions/preregister/api/v1/delivery` (EU) with
        `product=S0159`, `deliveryMethod=DOURUA`, `frankingType=FP`,
        `labellerCode=AZXT`, `sender` (customer: `country` ISO, ZIP in **`zip`**
        not `cp`), `to_address` (warehouse), weight.
      - Get the shipment code from the response → call the **Labels** API for the
        label PDF.
      - Persist `locator`/`carrier`/`carrierUrl`; email the customer (bilingual,
        print + drop-off).
      - Reuse the hardening: label booked → return 200 regardless of email
        (orphan-safe), idempotency guard.
- [ ] Wire routing in `return.ts` + Stripe webhook: EU non-ES →
      `createCorreosReturn` gated by `CORREOS_INTL_RETURNS_ENABLED`, above the
      Sendcloud/Amphora branches. Both other flags off = unchanged.
- [ ] `tsc --noEmit` clean.

## 4. Verify (against prod API, pre-enable)

- [ ] **Country-code format** — confirm `sender.country` wants ISO alpha-2 or
      alpha-3 (Annex III); the SOAP wanted alpha-3 (`FRA`).
- [ ] **Response mapping** — confirm the field paths for the shipment code,
      tracking, and label PDF (never got a live success under the SOAP; verify on
      first REST call).
- [ ] **One controlled real EU return** on a known order → real label generated,
      tracking persisted, email received, PDF prints and is scannable abroad.
- [ ] **Drop-off UX** — confirm the label is accepted at the customer's local
      post office (Correos international-return routing).
- [ ] **Weight** — replace the 0.5 kg/item estimate with real garment weights
      (catalog: crewneck 423 g, hoodie 900 g, tee 375 g, knit 550 g, polo 500 g,
      jeans 730 g, beanie 70 g — from the reconciliation methodology).

## 5. Billing safeguard

- [ ] Correos preregistros are **not billed until the parcel is inducted**
      (unlike Sendcloud) — so unused labels are low-risk. Confirm this holds for
      S0159, and decide whether to cancel abandoned preregistros
      (`POST /delivery/annulment`) as housekeeping.

## 6. Rollout

- [ ] Set config env vars (flag off) → redeploy → confirm ES + existing flows
      unchanged.
- [ ] Flip `CORREOS_INTL_RETURNS_ENABLED=true` → run the controlled test →
      verify → enable for customers.
- [ ] Rollback = unset the flag (instant, behaviour-neutral).

## 7. Later — GB/US (separate phase)

- [ ] **EORI number** for Corisa (currently null in Sendcloud) — importer of
      record for non-EU returns.
- [ ] **Returned Goods Relief**: CN23 marked "returned goods", ≤3 yr, unaltered,
      same-entity re-import + export evidence — confirm handling with a customs
      broker so returns don't incur import VAT/duty at the Spain border.
- [ ] Use `POST /delivery/cn` (customs variant) with
      `packages[].packageContents.customsData[]` for GB/US.
