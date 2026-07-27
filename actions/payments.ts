"use server";

import { stripe } from "@/lib/stripe";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { normalizeCountry } from "@/lib/countries";
import { hasOrderAccess } from "@/lib/orderAccess";
import { centsToEuros, feesForCountry, resolveFee } from "@/lib/fees";

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
  const fees = feesForCountry(feeTable, normalizeCountry(order.shippingCountry));
  const { feeCents } = resolveFee(fees, basket);

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

  const isCreditMeta = isCredit ? "true" : "false";
  const stripeSession = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "EUR",
          product_data: {
            name: "Returns & Exchanges Fee",
            description: "Shameless Collective",
          },
          unit_amount: amountCents,
        },
      },
    ],
    metadata: {
      id: id,
      isCredit: isCreditMeta,
    },
    success_url: returnUrl + "/success",
    cancel_url: returnUrl,
  });
  return { data: stripeSession.url };
};
