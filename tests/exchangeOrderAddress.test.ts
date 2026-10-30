import { beforeEach, describe, expect, it } from "vitest";

// The exchange order shipped every customer's parcel to Spain.
//
// `createOrder` hardcoded `countryCode: "ES"` in both the billing and the
// shipping address. We store the country as a NAME ("Belgium", "Portugal") and
// Shopify's OrderCreateOrderInput wants an ISO-2 code, so whoever wrote it had
// a name, needed a code, and typed the shop's own country.
//
// Measured 2026-08-26 against live data: 4 of 195 exchange orders went out
// under the wrong country — #311370 (Portugal), #311687 (Belgium),
// #311688 (Italy), #311689 (Portugal), three of them on one day.
//
// The zips were never wrong. A four-digit Belgian zip filed under Spain merely
// READS as a broken Spanish postcode, because Spain uses five. That is what
// makes this worth a test rather than a one-line edit: the symptom pointed at
// the wrong field.
//
// The four existing tests that touch exchange creation all mock `createOrder`
// away, so nothing ever looked at the payload it builds. This is that test.

import { buildExchangeOrderVariables } from "@/lib/settlement/exchangeOrderInput";

// S2: the exchange order's variables are built once, at admission, by the
// pure `buildExchangeOrderVariables`, and frozen into the operation. These are
// the `createOrder` address tests, ported to that builder. A country it cannot
// resolve HOLDS the admission (`unresolvable-country`), which the auto-approve
// cron and the dashboard surface — it is never guessed.

/** Every variables object a successful build produced, as `{ variables }`. */
const sent: any[] = [];

function build(o: any) {
  const result = buildExchangeOrderVariables({
    opId: "op-1",
    order: o,
    customerGid: "gid://shopify/Customer/1",
    lines: [{ productsorderId: 1, newVariantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
    holdExisted: false,
  });
  if (result.ok) sent.push({ variables: result.variables });
  return result;
}

/** An order as `orders` stores it: the country is a display NAME, not a code. */
function order(over: Record<string, unknown> = {}) {
  return {
    id: "1",
    orderNumber: "#311078",
    email: "customer@example.com",
    shippingName: "Gabriel",
    shippingAddress1: "Avenue des Tourterelles 27",
    shippingAddress2: "",
    shippingCity: "Woluwe-Saint-Pierre",
    shippingProvince: "",
    shippingZip: "1150",
    shippingCountry: "Belgium",
    shippingPhone: "0470678370",
    deliveryName: null,
    deliveryAddress1: null,
    deliveryAddress2: null,
    deliveryZip: null,
    deliveryCity: null,
    deliveryProvince: null,
    deliveryCountry: null,
    ...over,
  };
}

/** Both addresses on the created order, as they were sent to Shopify. */
function addresses() {
  const input = sent[0].variables.order;
  return { shipping: input.shippingAddress, billing: input.billingAddress };
}

beforeEach(() => {
  sent.length = 0;
});

describe("exchange order — the exchange ships to the customer's own country", () => {
  it("sends Belgium as BE, not the shop's own ES", async () => {
    build(order());

    const { shipping, billing } = addresses();
    expect(shipping.countryCode).toBe("BE");
    expect(billing.countryCode).toBe("BE");
  });

  it("sends Portugal as PT", async () => {
    build(
      order({
        shippingCountry: "Portugal",
        shippingCity: "Leiria",
        shippingProvince: "Leiria",
        shippingZip: "2410-211",
      })
    );

    expect(addresses().shipping.countryCode).toBe("PT");
  });

  it("still sends ES for a genuinely Spanish order", async () => {
    build(
      order({ shippingCountry: "Spain", shippingCity: "Madrid", shippingProvince: "Madrid" })
    );

    expect(addresses().shipping.countryCode).toBe("ES");
  });

  it("accepts the Spanish spelling we actually store", async () => {
    // `orders.shippingCountry` is written straight from Shopify and is not
    // guaranteed to be English.
    build(order({ shippingCountry: "España" }));

    expect(addresses().shipping.countryCode).toBe("ES");
  });

  it("passes the customer's zip through untouched", async () => {
    // The zip was never the bug, and must not become one.
    build(order());

    const { shipping, billing } = addresses();
    expect(shipping.zip).toBe("1150");
    expect(billing.zip).toBe("1150");
  });
});

describe("exchange order — an unresolvable country is refused, never guessed", () => {
  it("creates nothing and reports failure", async () => {
    const result = build(order({ shippingCountry: "Wakanda" }));

    expect(result).toEqual({ ok: false, reason: "unresolvable-country" });
    expect(sent).toHaveLength(0);
  });

  it("refuses an unresolvable BILLING country too — both addresses must resolve", async () => {
    const result = build(order({ shippingCountry: "Wakanda", deliveryCountry: "Spain",
      deliveryAddress1: "Calle 1", deliveryCity: "Madrid", deliveryZip: "28001" }));

    expect(result).toEqual({ ok: false, reason: "unresolvable-country" });
  });

  it("refuses an empty country rather than defaulting to the shop's own", async () => {
    // Defaulting silently is precisely what shipped four parcels to Spain.
    const result = build(order({ shippingCountry: "" }));

    expect(result).toEqual({ ok: false, reason: "unresolvable-country" });
    expect(sent).toHaveLength(0);
  });
});

describe("exchange order — province codes are Spanish-only", () => {
  it("never sends a foreign city as a province code", async () => {
    // Order #311687 sent "Woluwe-Saint-Pierre" as a provinceCode, because
    // getProvinceCode returns its input unchanged when nothing matches its
    // Spanish table and the province field was blank so the CITY was passed in.
    build(order());

    const { shipping, billing } = addresses();
    expect(shipping.provinceCode).toBeUndefined();
    expect(billing.provinceCode).toBeUndefined();
  });

  it("still resolves a Spanish province to its code", async () => {
    build(
      order({ shippingCountry: "Spain", shippingProvince: "Madrid", shippingCity: "Madrid" })
    );

    expect(addresses().shipping.provinceCode).toBe("M");
  });

  it("falls back to the city for a Spanish order with no province", async () => {
    // The existing behaviour for Spain, which is where the fallback works:
    // a Spanish city name is very often also its province name.
    build(
      order({ shippingCountry: "Spain", shippingProvince: "", shippingCity: "Barcelona" })
    );

    expect(addresses().shipping.provinceCode).toBe("B");
  });
});

describe("a separate delivery address", () => {
  const US_DELIVERY = {
    deliveryName: "Ana Ruiz",
    deliveryAddress1: "120 Broadway",
    deliveryAddress2: "Apt 4",
    deliveryZip: "10271",
    deliveryCity: "New York",
    deliveryProvince: "NY",
    deliveryCountry: "United States",
  };

  /** The helper's defaults are Belgian; spell out the Spanish collection
   *  address wherever a test asserts on it. */
  const SPANISH_COLLECTION = {
    shippingName: "Ana Ruiz",
    shippingAddress1: "Calle Mayor 1",
    shippingAddress2: "3B",
    shippingCity: "Madrid",
    shippingProvince: "Madrid",
    shippingZip: "28013",
    shippingCountry: "España",
  };

  it("ships to the delivery address and bills to the collection address", async () => {
    build(
      order({ ...SPANISH_COLLECTION, ...US_DELIVERY })
    );

    const input = sent[0].variables.order;
    expect(input.shippingAddress).toMatchObject({
      address1: "120 Broadway",
      city: "New York",
      countryCode: "US",
      zip: "10271",
    });
    // The card was charged where the customer lives, which is where they were
    // billed originally.
    expect(input.billingAddress).toMatchObject({
      address1: "Calle Mayor 1",
      city: "Madrid",
      countryCode: "ES",
      zip: "28013",
    });
  });

  // The province is Spanish-only and getProvinceCode returns its INPUT
  // UNCHANGED when nothing matches. Reading the delivery country against the
  // collection city is how "Woluwe-Saint-Pierre" reached Shopify as a province
  // code (759bb1b); the two halves have to move together.
  it("omits provinceCode on a non-Spanish delivery address", async () => {
    build(
      order({ ...SPANISH_COLLECTION, ...US_DELIVERY })
    );
    expect(sent[0].variables.order.shippingAddress.provinceCode).toBeUndefined();
  });

  it("derives provinceCode from the DELIVERY province for a Spanish delivery address", async () => {
    build(
      order({
        shippingCountry: "United States",
        shippingProvince: "NY",
        shippingCity: "New York",
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "Calle Mayor 1",
        deliveryZip: "28013",
        deliveryCity: "Madrid",
        deliveryProvince: "Madrid",
        deliveryCountry: "España",
      })
    );
    const shipping = sent[0].variables.order.shippingAddress;
    expect(shipping.countryCode).toBe("ES");
    // Whatever getProvinceCode maps "Madrid" to, it must not be "NY" and must
    // not be undefined — the point is that it read the delivery address.
    expect(shipping.provinceCode).toBeDefined();
    expect(shipping.provinceCode).not.toBe("NY");
  });

  it("refuses when the delivery country cannot be resolved", async () => {
    const result = build(
      order({
        shippingCountry: "España",
        deliveryName: "Ana Ruiz",
        deliveryAddress1: "1 Nowhere St",
        deliveryZip: "0000",
        deliveryCity: "Nowhere",
        deliveryCountry: "Freedonia",
      })
    );
    expect(result).toEqual({ ok: false, reason: "unresolvable-country" });
    expect(sent).toHaveLength(0);
  });

  it("still ships to the collection address when no delivery address is set", async () => {
    build(
      order({ shippingCountry: "Portugal", shippingCity: "Lisboa", shippingZip: "1100-148" })
    );
    expect(sent[0].variables.order.shippingAddress).toMatchObject({
      city: "Lisboa",
      countryCode: "PT",
      zip: "1100-148",
    });
  });
});
