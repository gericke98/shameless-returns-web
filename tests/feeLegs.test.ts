import { describe, expect, it } from "vitest";
import { feeLegsForOrder } from "@/lib/feeLegs";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  "ES-CN": flat(2115, 3415),
  US: flat(2200, 3496),
};

function order(over: Record<string, unknown> = {}) {
  return {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: null,
    shippingZip: "28013",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingCountry: "España",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
  } as any;
}

const US_DELIVERY = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: null,
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

describe("feeLegsForOrder", () => {
  it("puts the collection zone on both legs when there is no delivery address", () => {
    expect(feeLegsForOrder(TABLE, order())).toEqual({
      collection: flat(500, 850),
      delivery: flat(500, 850),
    });
  });

  it("prices the delivery leg in the delivery country", () => {
    expect(feeLegsForOrder(TABLE, order(US_DELIVERY))).toEqual({
      collection: flat(500, 850),
      delivery: flat(2200, 3496),
    });
  });

  // The collection leg keeps resolveZone's Spanish sub-zone logic: the parcel
  // is still collected from the Canaries whatever the replacement's
  // destination.
  it("keeps the Spanish sub-zone on the collection leg", () => {
    const legs = feeLegsForOrder(
      TABLE,
      order({ ...US_DELIVERY, shippingZip: "38001" })
    );
    expect(legs.collection).toEqual(flat(2115, 3415));
    expect(legs.delivery).toEqual(flat(2200, 3496));
  });

  // A Spanish DELIVERY address gets the same sub-zone treatment, because
  // resolveZone reads the delivery postcode for that leg.
  it("applies the Spanish sub-zone to a Spanish delivery address", () => {
    const legs = feeLegsForOrder(
      TABLE,
      order({
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "Calle del Mar 2",
        deliveryZip: "38001",
        deliveryCity: "Santa Cruz de Tenerife",
        deliveryCountry: "España",
      })
    );
    expect(legs.collection).toEqual(flat(500, 850));
    expect(legs.delivery).toEqual(flat(2115, 3415));
  });

  it("falls back to the default row for a country with no rows", () => {
    const legs = feeLegsForOrder(
      TABLE,
      order({
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "1 Queen St",
        deliveryZip: "1010",
        deliveryCity: "Auckland",
        deliveryCountry: "New Zealand",
      })
    );
    expect(legs.delivery).toEqual(flat(9900, 12000));
  });

  it("puts the default row on both legs for a missing order", () => {
    expect(feeLegsForOrder(TABLE, null)).toEqual({
      collection: flat(9900, 12000),
      delivery: flat(9900, 12000),
    });
  });
});
