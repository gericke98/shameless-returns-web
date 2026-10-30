// Replacement orders: the Shopify orders WE create when an exchange settles.
//
// Pure — no db, no env, no network — because these rules decide what a
// returned garment is worth and which order pays for it.
//
// Before S2, `createOrder` (db/queries.ts, now removed) gave every replacement
// a €0.01 `manual` payment and LIST prices, so a line on a replacement order
// says nothing true about money: a refund must go to the order that holds the
// real payment. #312061 (replacement for #311749) showed it: €62 list against
// €47.03 paid, refunded against €0.01. What each line IS worth lives in
// `replacement_lines` (db/replacementLines.ts) — written by S2 for its own
// orders and by the S3 reconciliation for the older ones. The tag
// reconstruction that used to stand in for it is gone (S3 R4).

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
