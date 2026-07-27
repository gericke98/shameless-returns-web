"use server";

import { stripe } from "@/lib/stripe";
import { getFeeTable } from "@/db/fees";
import { loadBasket } from "@/lib/loadBasket";
import { normalizeCountry } from "@/lib/countries";
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
