import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const alerts: string[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => {
    alerts.push(subject);
  },
}));

const sent: any[] = [];

function stubShopify() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          data: {
            orderCreate: {
              order: { id: "gid://shopify/Order/1", name: "#999" },
              userErrors: [],
            },
          },
        }),
      } as any;
    })
  );
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
    ...over,
  };
}

const LINES = [{ new_variant_id: "gid://shopify/ProductVariant/1" }];

async function subject() {
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.test";
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  return (await import("@/db/queries")).createOrder;
}

/** Both addresses on the created order, as they were sent to Shopify. */
function addresses() {
  const input = sent[0].variables.order;
  return { shipping: input.shippingAddress, billing: input.billingAddress };
}

beforeEach(() => {
  sent.length = 0;
  alerts.length = 0;
  stubShopify();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOrder — the exchange ships to the customer's own country", () => {
  it("sends Belgium as BE, not the shop's own ES", async () => {
    const createOrder = await subject();

    await createOrder(order(), LINES);

    const { shipping, billing } = addresses();
    expect(shipping.countryCode).toBe("BE");
    expect(billing.countryCode).toBe("BE");
  });

  it("sends Portugal as PT", async () => {
    const createOrder = await subject();

    await createOrder(
      order({
        shippingCountry: "Portugal",
        shippingCity: "Leiria",
        shippingProvince: "Leiria",
        shippingZip: "2410-211",
      }),
      LINES
    );

    expect(addresses().shipping.countryCode).toBe("PT");
  });

  it("still sends ES for a genuinely Spanish order", async () => {
    const createOrder = await subject();

    await createOrder(
      order({ shippingCountry: "Spain", shippingCity: "Madrid", shippingProvince: "Madrid" }),
      LINES
    );

    expect(addresses().shipping.countryCode).toBe("ES");
  });

  it("accepts the Spanish spelling we actually store", async () => {
    // `orders.shippingCountry` is written straight from Shopify and is not
    // guaranteed to be English.
    const createOrder = await subject();

    await createOrder(order({ shippingCountry: "España" }), LINES);

    expect(addresses().shipping.countryCode).toBe("ES");
  });

  it("passes the customer's zip through untouched", async () => {
    // The zip was never the bug, and must not become one.
    const createOrder = await subject();

    await createOrder(order(), LINES);

    const { shipping, billing } = addresses();
    expect(shipping.zip).toBe("1150");
    expect(billing.zip).toBe("1150");
  });
});

describe("createOrder — an unresolvable country is refused, never guessed", () => {
  it("creates nothing and reports failure", async () => {
    const createOrder = await subject();

    const result = await createOrder(order({ shippingCountry: "Wakanda" }), LINES);

    expect(result.success).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("alerts ops so the stranded exchange is not silent", async () => {
    const createOrder = await subject();

    await createOrder(order({ shippingCountry: "Wakanda" }), LINES);

    expect(alerts.join(" ")).toContain("#311078");
  });

  it("refuses an empty country rather than defaulting to the shop's own", async () => {
    // Defaulting silently is precisely what shipped four parcels to Spain.
    const createOrder = await subject();

    const result = await createOrder(order({ shippingCountry: "" }), LINES);

    expect(result.success).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("createOrder — province codes are Spanish-only", () => {
  it("never sends a foreign city as a province code", async () => {
    // Order #311687 sent "Woluwe-Saint-Pierre" as a provinceCode, because
    // getProvinceCode returns its input unchanged when nothing matches its
    // Spanish table and the province field was blank so the CITY was passed in.
    const createOrder = await subject();

    await createOrder(order(), LINES);

    const { shipping, billing } = addresses();
    expect(shipping.provinceCode).toBeUndefined();
    expect(billing.provinceCode).toBeUndefined();
  });

  it("still resolves a Spanish province to its code", async () => {
    const createOrder = await subject();

    await createOrder(
      order({ shippingCountry: "Spain", shippingProvince: "Madrid", shippingCity: "Madrid" }),
      LINES
    );

    expect(addresses().shipping.provinceCode).toBe("M");
  });

  it("falls back to the city for a Spanish order with no province", async () => {
    // The existing behaviour for Spain, which is where the fallback works:
    // a Spanish city name is very often also its province name.
    const createOrder = await subject();

    await createOrder(
      order({ shippingCountry: "Spain", shippingProvince: "", shippingCity: "Barcelona" }),
      LINES
    );

    expect(addresses().shipping.provinceCode).toBe("B");
  });
});
