// Pure — no db, no env, no network. Turns an order's line items into the
// exchange block the transactional emails render, so both the Correos and the
// Amphora template get the same answer from the same rule.
import { ACTIONS } from "@/placeholder";
import type { ExchangeInfo } from "@/lib/emails";

type ProductLine = {
  title?: string | null;
  new_variant_title?: string | null;
  action?: string | null;
};

/**
 * Describe the replacement leg of an exchange, or null for a plain return.
 *
 * Returning a value with an EMPTY `replacements` array is meaningful and not
 * the same as null: the customer is still owed a swap, we just could not name
 * it. The email then keeps the exchange framing and falls back to vaguer copy,
 * rather than telling somebody who paid to change a size that we merely created
 * a return for them.
 */
export function exchangeFromProducts(
  products: ProductLine[] | null | undefined
): ExchangeInfo | null {
  const exchanged = (products ?? []).filter(
    (p) => p?.action === ACTIONS.CHANGE
  );
  if (exchanged.length === 0) return null;

  const replacements = exchanged
    .filter((p) => p.title && p.new_variant_title)
    .map((p) => `${p.title} — ${p.new_variant_title}`);

  return { replacements };
}
