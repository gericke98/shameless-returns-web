// Which address the REPLACEMENT is delivered to.
//
// Pure module: no db, no env, no server-only imports, so client components can
// resolve the same address and zone the server charges from.
//
// The rule is all-or-nothing. A delivery address is either complete enough to
// use in full, or it does not exist and the collection address is used in
// full. There is deliberately no field-by-field fallback: merging the two is
// how a Spanish city ends up filed under a US postcode, which is the exact
// shape of the bug that sent four exchange orders to the wrong country
// (759bb1b).

/** The structural subset of `orders` these functions read. */
export type OrderAddressFields = {
  shippingName: string;
  shippingAddress1: string;
  shippingAddress2: string | null;
  shippingZip: string;
  shippingCity: string;
  shippingProvince: string | null;
  shippingCountry: string;
  deliveryName: string | null;
  deliveryAddress1: string | null;
  deliveryAddress2: string | null;
  deliveryZip: string | null;
  deliveryCity: string | null;
  deliveryProvince: string | null;
  deliveryCountry: string | null;
};

export type DeliveryAddress = {
  readonly name: string;
  readonly address1: string;
  readonly address2: string | null;
  readonly zip: string;
  readonly city: string;
  readonly province: string | null;
  readonly country: string;
};

const filled = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Whether this order carries a delivery address of its own.
 *
 * Requires every field that makes an address both deliverable and priceable:
 * name, street, postcode, city and country. `address2` and `province` are
 * genuinely optional — plenty of real addresses have neither, and `province`
 * is only ever sent to Shopify for Spain.
 *
 * A row with some of these but not all is corrupt rather than separate, and
 * is treated as absent. `updateData` rejects partial writes, so the only way
 * to produce one is a hand-edit in the database.
 */
export function hasSeparateDelivery(order: OrderAddressFields): boolean {
  return (
    filled(order.deliveryName) &&
    filled(order.deliveryAddress1) &&
    filled(order.deliveryZip) &&
    filled(order.deliveryCity) &&
    filled(order.deliveryCountry)
  );
}

/** The address the replacement ships to — the collection address unless a
 *  complete separate one is stored. */
export function deliveryAddressOf(order: OrderAddressFields): DeliveryAddress {
  if (!hasSeparateDelivery(order)) {
    return {
      name: order.shippingName,
      address1: order.shippingAddress1,
      address2: order.shippingAddress2,
      zip: order.shippingZip,
      city: order.shippingCity,
      province: order.shippingProvince,
      country: order.shippingCountry,
    };
  }
  return {
    name: order.deliveryName!,
    address1: order.deliveryAddress1!,
    address2: order.deliveryAddress2,
    zip: order.deliveryZip!,
    city: order.deliveryCity!,
    province: order.deliveryProvince,
    country: order.deliveryCountry!,
  };
}
