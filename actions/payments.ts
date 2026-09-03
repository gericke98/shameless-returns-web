"use server";

import { stripe } from "@/lib/stripe";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { normalizeCountry } from "@/lib/countries";
import { resolveZone } from "@/lib/zones";
import { hasOrderAccess } from "@/lib/orderAccess";
import { alertOps } from "@/actions/opsAlert";
import {
  centsToEuros,
  checkoutLines,
  feesForCountry,
  resolveFee,
  sameZone,
  type CheckoutLine,
} from "@/lib/fees";
import { dictionaries, readLocale } from "@/lib/i18n";
import type { ReturnMethod } from "@/lib/returnMethods";

function absoluteUrl(path: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL}${path}`;
}
const returnUrl = absoluteUrl("/");

/**
 * Create a Stripe Checkout session for the amount the customer owes.
 *
 * The amount is derived here, from the order's own items and its destination
 * country. It is deliberately NOT accepted from the caller: this used to take
 * a `total` computed in the browser, which meant the page could set its own
 * price.
 *
 * Returns { data: null } when the basket does not actually owe anything —
 * callers must treat a null URL as "no payment required".
 */
export const createStripeUrl = async (
  id: string,
  email: string,
  isCredit: boolean,
  method: ReturnMethod
) => {
  // Its only caller, `returnFunction`, already verified this id — so this is
  // defence in depth rather than the primary gate. It is here so the guarantee
  // does not rest on Next's bundler declining to expose this action: server
  // actions are addressable endpoints, and bundler behaviour is not a security
  // boundary. Not shared with the Stripe webhook, which consumes sessions
  // rather than creating them, so gating it is safe.
  if (!(await hasOrderAccess(id))) return { data: null };

  const loaded = await loadBasket(id);
  if (!loaded) return { data: null };

  const { order, basket } = loaded;

  const feeTable = await getFeeTable();
  const fees = feesForCountry(
    feeTable,
    resolveZone(order.shippingCountry, order.shippingZip)
  );
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(sameZone(fees), basket);

  // A self-booked return pays its own courier, so we bill the outbound leg
  // alone — the replacement garment still travels on our account. This is the
  // whole of the SELF pricing rule: a subtraction, not a second fee table.
  //
  // `method` has already been through resolveReturnMethod on the server, so it
  // cannot be a client claiming SELF where SELF is not offered.
  const selfBooked = method === "SELF";
  const chargeReturnLegCents = selfBooked ? 0 : returnLegCents;
  const chargeCents = selfBooked ? outboundLegCents : feeCents;

  // netAmount is what the customer is owed; the fee reduces it. A negative
  // total means the customer owes us that much.
  const totalEuros = basket.netAmount - centsToEuros(chargeCents);
  // Only meaningful once totalEuros < 0 (see below), but computed here so the
  // alert block and the real early return share one number rather than two
  // copies of the same arithmetic drifting apart.
  const amountCents = Math.round(-totalEuros * 100);

  // A degraded basket means at least one replacement was priced from the
  // order's median discount depth, or from list price, because its original
  // variant is not in the catalogue getProducts() returns — that filters
  // Shopify to `status:ACTIVE`, so a product merely set to DRAFT is just as
  // invisible here as one actually deleted. That has never happened in
  // production (0 of 289 exchange lines) — so if it does, we want to hear
  // about it before the customer is charged, not after.
  //
  // The body is written AFTER the amount is known and must say only what is
  // true on THIS path — this repo has already sent someone hunting a refund
  // that never happened (see app/api/cron/auto-approve/route.ts), so a body
  // that claims a charge on a path that returns { data: null } is exactly
  // that mistake again. Every basket-bearing path below still alerts before
  // its own `return` — this only moves WHAT is said, not WHEN.
  if (basket.degraded) {
    if (totalEuros >= 0) {
      await alertOps(
        "EXCHANGE PRICED ON A FALLBACK — no charge",
        `Order ${id}: a replacement was priced from a fallback, not its own ` +
          `line. The customer was NOT charged — net amount computed as ` +
          `€${totalEuros.toFixed(2)} (return €${basket.netAmount.toFixed(2)} ` +
          `minus fee €${centsToEuros(chargeCents).toFixed(2)}). That total ` +
          `itself may be wrong — check the pricing, not a refund.`
      );
    } else if (amountCents < 50) {
      await alertOps(
        "EXCHANGE PRICED ON A FALLBACK — no charge",
        `Order ${id}: a replacement was priced from a fallback, not its own ` +
          `line. The amount owed, €${centsToEuros(amountCents).toFixed(2)}, is ` +
          `under Stripe's €0.50 minimum, so the customer was NOT charged. That ` +
          `total itself may be wrong — check the pricing, not a refund.`
      );
    } else {
      await alertOps(
        "EXCHANGE PRICED ON A FALLBACK — charging",
        `Order ${id}: a replacement was priced from a fallback, not its own ` +
          `line. About to charge €${centsToEuros(amountCents).toFixed(2)}. Check ` +
          `the price is right.`
      );
    }
  }

  if (totalEuros >= 0) return { data: null };

  // Stripe rejects a EUR charge below its €0.50 minimum, so a session created
  // for less would fail at the moment the customer tries to pay. That is now
  // reachable: per-country fees may legitimately be €0.00, which makes a
  // one-cent shortfall on an exchange possible. Treat it as "no payment
  // required" — the same contract as the >= 0 case above.
  if (amountCents < 50) return { data: null };

  // Itemise the checkout the same way the on-site summary itemises it, so the
  // customer is not asked to approve a single "fee" that silently bundles a
  // price difference and two shipping legs. checkoutLines returns [] when the
  // amount cannot be decomposed exactly, and the total is always amountCents
  // either way — this changes the description, never the charge.
  const locale = readLocale(order.locale);
  const t = dictionaries[locale];
  const LINE_LABEL: Record<CheckoutLine["kind"], string> = {
    difference: t.summary.newProducts,
    shipping: t.summary.shipping,
    returnShipping: t.summary.returnShipping,
    deliveryShipping: t.summary.deliveryShipping,
  };

  const lines = checkoutLines(
    basket,
    { returnLegCents: chargeReturnLegCents, outboundLegCents },
    amountCents
  );
  const stripeLines = lines.length
    ? lines.map((line) => ({ name: LINE_LABEL[line.kind], amountCents: line.amountCents }))
    : [{ name: "Returns & Exchanges Fee", amountCents }];

  const isCreditMeta = isCredit ? "true" : "false";
  const stripeSession = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: stripeLines.map((line) => ({
      quantity: 1,
      price_data: {
        currency: "EUR",
        product_data: {
          name: line.name,
          description: "Shameless Collective",
        },
        unit_amount: line.amountCents,
      },
    })),
    metadata: {
      id: id,
      isCredit: isCreditMeta,
    },
    success_url: returnUrl + "/success",
    cancel_url: returnUrl,
  });
  return { data: stripeSession.url };
};
