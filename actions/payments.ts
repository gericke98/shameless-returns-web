"use server";

import { stripe } from "@/lib/stripe";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { normalizeCountry } from "@/lib/countries";
import { resolveZone } from "@/lib/zones";
import { hasOrderAccess } from "@/lib/orderAccess";
import {
  centsToEuros,
  checkoutLines,
  feesForCountry,
  resolveFee,
  type CheckoutLine,
} from "@/lib/fees";
import { dictionaries, readLocale } from "@/lib/i18n";

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
  isCredit: boolean
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
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(fees, basket);

  // netAmount is what the customer is owed; the fee reduces it. A negative
  // total means the customer owes us that much.
  const totalEuros = basket.netAmount - centsToEuros(feeCents);
  if (totalEuros >= 0) return { data: null };

  const amountCents = Math.round(-totalEuros * 100);

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

  const lines = checkoutLines(basket, { returnLegCents, outboundLegCents }, amountCents);
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
