// Replacement orders: the Shopify orders WE create when an exchange settles.
//
// Pure — no db, no env, no network — because these rules decide what a
// returned garment is worth and which order pays for it.
//
// `createOrder` (db/queries.ts) gives every replacement the tags `Change` and
// `Order #NNN`, a €0.01 `manual` payment, and LIST prices. So a line on a
// replacement order says nothing true about money: its value is the price the
// customer paid on the original order's exchange row, and a refund must go to
// the order that holds the real payment. #312061 (replacement for #311749)
// showed both: €62 list against €47.03 paid, refunded against €0.01.
import { variantGid } from "@/lib/shopifyIds";

// Field names as Drizzle returns `productsorder` rows (camelCase `productId`).
export type OriginalRow = {
  variant_id: string;
  productId: string;
  new_variant_id: string | null;
  action: string | null;
  confirmed: boolean | null;
  price: string;
};

export type ReplacementLine = {
  variant_id: string | number;
  product_id: string | number;
};

const ORDER_TAG = /^Order (#\d+)$/;

/** The original's order number, or null when this is not unambiguously ours. */
export function originalOrderNumberFromTags(
  tags: string | null | undefined
): string | null {
  const list = String(tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!list.includes("Change")) return null;
  const numbers = list
    .map((t) => ORDER_TAG.exec(t)?.[1])
    .filter((n): n is string => !!n);
  return numbers.length === 1 ? numbers[0] : null;
}

function exchangeRowsFor(originalRows: OriginalRow[], variantId: string) {
  const target = variantGid(String(variantId));
  return originalRows.filter(
    (r) =>
      r.action === "CAMBIO" &&
      r.confirmed === true &&
      !!r.new_variant_id &&
      variantGid(r.new_variant_id) === target
  );
}

/**
 * The paid price of every replacement line, or why it cannot be known.
 *
 * All-or-nothing: one unmatched line fails the whole order, because saving the
 * others at the right price and that one at list would still overpay.
 */
export function planReplacementPricing(
  lines: ReplacementLine[],
  originalRows: OriginalRow[]
): { ok: true; priceByVariant: Record<string, string> } | { ok: false; reason: string } {
  if (lines.length === 0) return { ok: false, reason: "no-lines" };
  const priceByVariant: Record<string, string> = {};
  for (const line of lines) {
    const bare = String(line.variant_id);
    const matches = exchangeRowsFor(originalRows, bare);
    if (matches.length === 0) return { ok: false, reason: `no-original-line:${bare}` };
    if (matches.length > 1) return { ok: false, reason: `ambiguous-original-line:${bare}` };
    priceByVariant[bare] = matches[0].price;
  }
  return { ok: true, priceByVariant };
}

/** Follow `exchange_of` links to the order that holds the real payment. */
export async function resolveRootOrderId(
  startId: string,
  exchangeOfOf: (id: string) => Promise<string | null>
): Promise<string> {
  const seen = new Set<string>([startId]);
  let current = startId;
  for (;;) {
    const next = await exchangeOfOf(current);
    if (!next) return current;
    if (seen.has(next)) throw new Error(`exchange_of cycle at order ${next}`);
    seen.add(next);
    current = next;
  }
}

/**
 * Did the customer swap to a DIFFERENT product for this replacement? Only then
 * can they have paid a Stripe top-up that the original line price does not
 * cover. False when nothing matches — the caller has already failed closed.
 */
export function wasProductSwap(
  originalRows: OriginalRow[],
  replacementVariantId: string,
  replacementProductId: string
): boolean {
  const [match] = exchangeRowsFor(originalRows, replacementVariantId);
  return !!match && String(match.productId) !== String(replacementProductId);
}
