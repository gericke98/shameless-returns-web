/**
 * Collapsing the dashboard's flat garment list into one group per order.
 *
 * Pure — no React, no network.
 *
 * The table rendered one row per garment, repeating the order number, customer,
 * email and shipping status once per garment. A two-garment return read as two
 * unrelated returns, which is exactly the confusion the per-line return model
 * used to cause in Shopify.
 *
 * Rows stay per-garment inside the group: refunding is a per-garment action and
 * must remain one. Only the repetition is removed.
 */

/** Structural, so this module does not depend on @/types — which imports the
 *  Drizzle schema and, through it, half the app. */
export type GroupableOrder = {
  id: string;
  orderNumber: string;
  email: string;
  shippingName: string;
};

export type GroupableReturn<O extends GroupableOrder, P, S> = {
  order: O;
  product: P;
  status: S;
};

export type ReturnGroup<O extends GroupableOrder, P, S> = {
  order: O;
  status: S;
  products: P[];
};

/**
 * One group per order, preserving the order the rows arrived in.
 *
 * Grouped by `order.id`, not by order NUMBER: the number is display data and
 * two orders sharing one would silently merge two customers' returns into a
 * single group.
 */
export function groupReturns<O extends GroupableOrder, P, S>(
  returns: GroupableReturn<O, P, S>[]
): ReturnGroup<O, P, S>[] {
  const groups = new Map<string, ReturnGroup<O, P, S>>();

  for (const row of returns ?? []) {
    const key = row.order?.id;
    if (key == null) continue;

    const existing = groups.get(key);
    if (existing) {
      existing.products.push(row.product);
    } else {
      groups.set(key, {
        order: row.order,
        status: row.status,
        products: [row.product],
      });
    }
  }

  return Array.from(groups.values());
}

export type GroupFilters<P, S> = {
  searchTerm: string;
  /** Keeps a garment in the group. */
  keepProduct: (product: P) => boolean;
  /** Keeps the whole group, judged on its resolved shipping status. */
  keepStatus: (status: S) => boolean;
};

/**
 * Filter groups, and the garments inside them.
 *
 * A group survives when its order matches the search AND its status matches the
 * shipping filter AND at least one garment survives the refund filter. Groups
 * left with no garments are dropped rather than rendered as an empty header —
 * an order card with nothing under it reads as a data fault.
 */
export function filterGroups<O extends GroupableOrder, P, S>(
  groups: ReturnGroup<O, P, S>[],
  filters: GroupFilters<P, S>
): ReturnGroup<O, P, S>[] {
  const term = filters.searchTerm.trim().toLowerCase();

  const matchesSearch = (order: O) =>
    !term ||
    order.orderNumber.toLowerCase().includes(term) ||
    order.email.toLowerCase().includes(term) ||
    order.shippingName.toLowerCase().includes(term);

  return groups
    .filter((group) => matchesSearch(group.order))
    .filter((group) => filters.keepStatus(group.status))
    .map((group) => ({
      ...group,
      products: group.products.filter(filters.keepProduct),
    }))
    .filter((group) => group.products.length > 0);
}

/**
 * The exchange lines a single "Process exchange" action would settle.
 *
 * `validateReturn` gathers every pending CAMBIO line on the order, creates ONE
 * Shopify order with all the replacements, and closes each return. So when more
 * than one is pending, a per-garment button is misleading in both directions:
 * it looks like each must be pressed, and like pressing one might ship only
 * that garment. The second press is in fact a silent no-op.
 *
 * Returns (DEVOLUCIÓN) are excluded — each is refunded individually for its own
 * amount and keeps its own button.
 *
 * `changeAction` is passed in rather than imported so this module stays free of
 * `@/placeholder`, which is a 350kB catalogue.
 */
export function pendingExchanges<
  P extends { action?: string | null; refunded?: boolean | null }
>(products: P[], changeAction: string): P[] {
  return (products ?? []).filter(
    (product) => product.action === changeAction && !product.refunded
  );
}

/**
 * Total garments across groups.
 *
 * Pagination counts ORDERS, so this exists to report the real garment count
 * alongside it — "8 orders (14 garments)" — rather than leaving the page size
 * looking like it dropped rows.
 */
export function countProducts<O extends GroupableOrder, P, S>(
  groups: ReturnGroup<O, P, S>[]
): number {
  return groups.reduce((total, group) => total + group.products.length, 0);
}
