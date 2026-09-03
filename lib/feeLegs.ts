// Turn an order into the two band lists its two shipping legs are priced from.
//
// One place, because five call sites need this pair and a disagreement between
// any two of them is a customer charged one number and settled at another.
// Pure: no db, no env, so the portal resolves the same legs the Stripe charge
// is computed from.
import { feesForCountry, type FeeLegs, type FeeTable } from "./fees";
import { resolveZone } from "./zones";
import { deliveryAddressOf, type OrderAddressFields } from "./deliveryAddress";

/**
 * `collection` is priced from `shipping_country` + `shipping_zip` — where the
 * carrier picks the parcel up, which is what it charges for. `delivery` is
 * priced from the delivery address, which is the collection address unless the
 * customer named a different one.
 *
 * Both go through `resolveZone`, so a Spanish address on either leg gets its
 * island or enclave rate rather than the peninsular one.
 *
 * A null order resolves both legs to the '*' row, which is the dearest —
 * the same worst-case principle `feesForCountry` already applies. Callers on
 * that path have bigger problems than the fee, but they must not get a free
 * one.
 */
export function feeLegsForOrder(
  table: FeeTable,
  order: OrderAddressFields | null | undefined
): FeeLegs {
  if (!order) {
    const fallback = feesForCountry(table, null);
    return { collection: fallback, delivery: fallback };
  }
  const delivery = deliveryAddressOf(order);
  return {
    collection: feesForCountry(
      table,
      resolveZone(order.shippingCountry, order.shippingZip)
    ),
    delivery: feesForCountry(table, resolveZone(delivery.country, delivery.zip)),
  };
}
