"use server";

import { stripe } from "@/lib/stripe";

function absoluteUrl(path: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL}${path}`;
}
const returnUrl = absoluteUrl("/");

export const createStripeUrl = async (
  total: number,
  email: string,
  id: string,
  isCredit: boolean
) => {
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
          unit_amount: Math.round(total * 100), // Stripe expects the amount in cents
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
