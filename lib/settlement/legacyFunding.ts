// S3 (Codex #5): what a pre-ledger exchange order's lines were funded by, from
// the REAL historical Stripe payments — never rebuilt from today's catalogue
// or fee table.
//
// Before S1, a checkout session carried `metadata.id` = the order it was for
// and no submission id; its line items were labels ("new products",
// "shipping") with no productsorder line on them. So a paid session's money
// can never be allocated to one exchange line by identity. What CAN be read
// is the absence of payment: a complete listing of every session in which no
// paid legacy session names the order — and no paid legacy session is left
// unattributed — proves the customer paid nothing on top, i.e. funding 0.
// Anything else is unresolved: the order stays a known replacement with no
// funding, and refuses valuation (db/replacementLines.ts).
//
// Stripe is only READ (scripts/reconcile-legacy.ts). NOT "use server".
import { parseCheckoutMetadata } from "@/lib/checkoutMetadata";
import type { EffectDecision } from "./reconcile";
import type { LineFunding } from "./reconcileLedger";

export type StripeSession = {
  id: string;
  payment_status: string | null;
  metadata: Record<string, string | undefined> | null;
};

/** Every checkout session, every page — or no verdict. */
export type StripeSessions = { ok: true; sessions: StripeSession[] } | { ok: false; error: string };

/**
 * The funding of an exchange line on `orderId`, from a complete Stripe
 * listing. `orderOfLine` resolves a human decision that binds a session to a
 * productsorder line to that line's order.
 */
export function legacyFundingOf(
  orderId: string,
  stripe: StripeSessions,
  decisions: ReadonlyMap<string, EffectDecision>,
  orderOfLine: (productsorderId: number) => string | null
): LineFunding {
  if (!stripe.ok) return { ok: false, reason: `Stripe sessions unreadable: ${stripe.error}` };
  const paidLegacy = stripe.sessions.filter((s) => {
    if (s.payment_status !== "paid") return false;
    const meta = parseCheckoutMetadata(s.metadata);
    return !meta?.submissionId;
  });
  const forOrder: string[] = [];
  const unattributed: string[] = [];
  for (const s of paidLegacy) {
    const d = decisions.get(s.id);
    if (d?.verdict === "excludes") continue;
    const named = d?.verdict === "binds" ? orderOfLine(Number(d.productsorderId)) : parseCheckoutMetadata(s.metadata)?.id ?? null;
    if (named === null) unattributed.push(s.id);
    else if (named === orderId) forOrder.push(s.id);
  }
  if (unattributed.length > 0) {
    return {
      ok: false,
      reason: `paid Stripe session(s) ${unattributed.join(", ")} name no order: a human binds or excludes them`,
    };
  }
  if (forOrder.length > 0) {
    return {
      ok: false,
      reason: `paid Stripe session(s) ${forOrder.join(", ")} for order ${orderId} carry no split to the exchange line`,
    };
  }
  return { ok: true, stripeFundedCents: 0, source: `stripe: no paid legacy session for order ${orderId}` };
}
