// A productsorder row's `return_id` is identity only when Shopify says that
// return belongs to the row's own order (Return.order.id). The pre-S1 confirm
// write keyed rows by variant, so it stamped one order's return onto rows of
// OTHER orders sharing the variant (#34911-R1 on #34700/#34934; #35036-R1 on
// #34712/#35011). Every path that trusts a legacy return_id — R1's
// classification and grouping, S2 legacy terms, admission — asks this first.
//
// No imports: shared by the pure planner and the readers. NOT "use server".

/** orders.id is the bare Shopify id; Shopify's reads answer the gid. */
export const orderGidOf = (orderId: string): string =>
  orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

/**
 * Null when the return Shopify read belongs to `rowOrderId`; otherwise the
 * hold naming the order it does belong to.
 */
export function returnOwnerProblem(rowOrderId: string, returnOrderGid: string | null | undefined): string | null {
  return returnOrderGid && returnOrderGid === orderGidOf(String(rowOrderId))
    ? null
    : `return-of-other-order:${returnOrderGid || "(none)"}`;
}
