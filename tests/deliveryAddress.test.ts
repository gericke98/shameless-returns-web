import { describe, expect, it } from "vitest";
import { deliveryAddressOf, hasSeparateDelivery } from "@/lib/deliveryAddress";

/** An order as `orders` stores it. Country is a display NAME, not a code. */
function order(over: Record<string, unknown> = {}) {
  return {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: "3B",
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
  deliveryAddress2: "Apt 4",
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "US",
};

describe("hasSeparateDelivery", () => {
  it("is false when no delivery address is stored", () => {
    expect(hasSeparateDelivery(order())).toBe(false);
  });

  it("is true when a delivery address is stored", () => {
    expect(hasSeparateDelivery(order(US_DELIVERY))).toBe(true);
  });

  // The country and the street are what make an address deliverable and
  // priceable. A row carrying only a stray province is corrupt, not separate.
  it("is false when the country is set but the street is not", () => {
    expect(hasSeparateDelivery(order({ deliveryCountry: "US" }))).toBe(false);
  });

  it("is false when the street is set but the country is not", () => {
    expect(hasSeparateDelivery(order({ deliveryAddress1: "120 Broadway" }))).toBe(false);
  });
});

describe("deliveryAddressOf", () => {
  it("falls back to the collection address when none is stored", () => {
    expect(deliveryAddressOf(order())).toEqual({
      name: "Ana Ruiz",
      address1: "Calle Mayor 1",
      address2: "3B",
      zip: "28013",
      city: "Madrid",
      province: "Madrid",
      country: "España",
    });
  });

  it("returns the stored delivery address when there is one", () => {
    expect(deliveryAddressOf(order(US_DELIVERY))).toEqual({
      name: "Ana Ruiz",
      address1: "120 Broadway",
      address2: "Apt 4",
      zip: "10271",
      city: "New York",
      province: "NY",
      country: "US",
    });
  });

  // All-or-nothing. Merging the two addresses is how a Spanish city ends up
  // filed under a US postcode.
  it("never mixes fields from the two addresses", () => {
    const partial = order({ ...US_DELIVERY, deliveryCity: null });
    expect(deliveryAddressOf(partial).city).toBe("Madrid");
    expect(deliveryAddressOf(partial).country).toBe("España");
  });
});
