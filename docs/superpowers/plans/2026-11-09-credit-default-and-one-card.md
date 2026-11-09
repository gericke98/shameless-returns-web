# Plan: no default tender + one gift card per settlement (9 Nov 2026)

Base: `origin/main` @ `c1fa6d4`. Trigger: #312385 Jacobo wanted a card refund, got 3 gift cards
(86,82 + 86,82 + 0,01) because credit was pre-selected; Santi reversed it by hand (151 € refund).

> **Foundations rules (verbatim, ~/.claude/rules/foundations.md):**
> 1. Fix the root cause. Never a heuristic, tie-breaker, special case, flag, retry, regex over words, "until phase N"
>    stopgap, or workaround for an existing weakness. If the root fix is bigger than the ask, say so and do the root fix
>    (or stop and ask) — never ship the patch silently.
> 2. Before designing anything, read the official skills and docs for what already exists, and reuse it instead of
>    rebuilding. State in the design which official primitive you use, or why none fits.
>
> Reviewer: judge **FOUNDATION vs PATCH** per mechanism (A1, A2, B1, B2, B3).

## A. Tender is chosen, never defaulted (LIGHT tier: UI)

**Root cause.** `app/[id]/clientOrder.tsx:21` `useState<boolean>(true)`: a customer who clicks
Continue on step 3 without touching the cards submits `isCredit = true`. "No choice" is unrepresentable.

- **A1.** `credito: boolean | null`, initial `null` (type already allows null in `lastWindow.tsx:26`).
  Prop types in `orderWindow`, `orderWindowContent`, `thirdWindow` widen to `boolean | null`.
  Step 3's `ContinueButton` is disabled while `credito === null`; neither card shows selected.
  An exchange still forces `false` (`handleItemChange`), unchanged.
- **A2.** Server boundary refuses a missing choice: `returnFunction` (and the Stripe webhook's
  `metadata.isCredit`) must receive an explicit boolean; anything else → error, no submission row.
  `AsyncButton` takes `isCredit: boolean` and is only rendered when it is non-null.
- Proof: screenshots step 3 + step 4, desktop + 390px, ES/EN; a unit test that `returnFunction`
  rejects `undefined`.

## B. One gift card per admission, residual included (HEAVY tier: money)

**Root cause.** `lib/settlement/plan.ts`: in credit tender every admitted line gets its own
`moneyOperation` → its own `giftCardCreate`, and the submission residual (`agreement.ts`
`splitProportionally`, floor per line) gets **another** card. A gift card is a balance the customer
spends as one, so the unit of payment is the admission, not the line. Per-line amounts stay as data
(`submission_lines.pay_cents`, op `members`), not as separate cards.

Official primitive: Shopify `giftCardCreate` (one card, `initialValue` = sum), already used in
`effects.ts`; no new API.

- **B1.** In credit tender, `planAdmission` emits **one** `gift_card` op per admission:
  `members` = every admitted paying line, `amount_cents` = Σ `pay_cents`, plus `residual_cents`
  when this admission leaves every paying line covered. `scope_key` = `credit:<submission>:<sorted member ids>`.
- **B2.** "Is this line's money already admitted?" is read from **`members` of existing ops**
  (explicit ownership data), not from the presence of a `money:<s>:<po>` scope key. `PlanInput.existing`
  gains `members`. The residual check becomes "residual owned by an existing op" (`residual` flag in
  the op or the residual scope key kept for already-issued legacy ops).
- **B3.** Legacy: ops already in the ledger (per-line keys) are untouched; recovery still executes them.
  A residual whose paying lines were all admitted before deploy still gets its own op (only case left).
- Proof: plan tests (2 lines one admission → 1 op, amount = owed incl. residual; 2 admissions →
  2 ops, residual on the second; legacy per-line ops → no double pay), `settlementEvidenceMatrix`
  + concurrency suites green, then a Neon-branch preview run of one real-shaped submission.

## Open decisions for Santi (A/B)

1. **Refund tender residual** also creates a separate `root_refund` of a few cents (same `residual`
   path). A) fold it into one refund the same way in this change; B) leave refund tender as is
   (lines refund inside `returnProcess`, so folding needs its own design).
2. **Copy on step 3**: A) neutral "elige cómo quieres tu dinero"; B) keep current copy, just no preselection.

## Phases (each gated)

1. A (UI) → screenshots + one Codex code review → merge.
2. B plan → Codex plan review (max 2 rounds) → build → suites + Neon preview → Codex code review → merge.
