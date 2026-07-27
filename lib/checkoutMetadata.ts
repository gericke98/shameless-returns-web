// Reading the metadata Stripe hands back on `checkout.session.completed`.
//
// Stripe metadata is always a string -> string map: whatever
// `actions/payments.ts` puts in comes back out as a string, verbatim. There is
// therefore nothing to JSON.parse, and parsing it actively broke both fields:
//
//   JSON.parse("true")        -> boolean true, which then failed a `=== "true"`
//                                string comparison, so isCredit was PERMANENTLY
//                                false. A customer who chose store credit paid
//                                for their exchange and silently received a card
//                                refund instead of the gift card plus 15%.
//   JSON.parse("5678901234")  -> the number 5678901234, passed to functions
//                                typed for a string and into eq(orders.id, ...)
//                                against a `text` column. It only worked because
//                                order ids happen to be numeric and the driver
//                                coerced them; JSON.parse throws outright on a
//                                non-numeric id such as a Shopify GID.
//
// Pure module — no db, no env, no Stripe SDK — so the parsing is unit-testable
// without a webhook, a database or a network.

export type CheckoutMetadata = {
  /** The `orders.id` this session was created for. Always a string, as stored. */
  id: string;
  /** Whether the customer chose store credit over a refund to their card. */
  isCredit: boolean;
};

/**
 * Extract the fields the return pipeline needs from a Checkout session's
 * metadata. Returns null when the order id is absent or blank — the caller
 * cannot do anything useful without it and should reject the webhook rather
 * than proceed against an undefined order.
 *
 * `isCredit` is true only for the exact string "true", the literal
 * `actions/payments.ts` writes. Anything else, including a missing key, is
 * false: defaulting to a card refund is the recoverable direction, since a
 * refund can be reissued as credit but an issued gift card cannot be recalled.
 */
export function parseCheckoutMetadata(
  metadata: Record<string, string | undefined> | null | undefined
): CheckoutMetadata | null {
  const id = metadata?.id?.trim();
  if (!id) return null;

  return { id, isCredit: metadata?.isCredit === "true" };
}
