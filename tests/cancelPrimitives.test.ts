import { beforeEach, describe, expect, it, vi } from "vitest";

// The two reversals against our own records.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

// Every `.set()` the reset performs, in order. Which table each one targeted is
// deliberately NOT recorded: the assertions identify updates by the columns
// they write, which is the behaviour under test, and reaching into Drizzle's
// internal table symbols to learn the name would couple the test to the ORM's
// private shape for no gain.
const setCalls: Array<Record<string, any>> = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      setCalls.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

let shopifyBody = "";
const shopifyResponse = { value: { data: { returnCancel: { return: { id: "gid://x" }, userErrors: [] } } } };

global.fetch = (async (_url: string, init: any) => {
  shopifyBody = String(init.body);
  return { json: async () => shopifyResponse.value };
}) as any;

beforeEach(() => {
  setCalls.length = 0;
  shopifyBody = "";
  shopifyResponse.value = { data: { returnCancel: { return: { id: "gid://x" }, userErrors: [] } } };
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.myshopify.com";
});

describe("cancelShopifyReturn", () => {
  it("sends returnCancel for that return id", async () => {
    const { cancelShopifyReturn } = await import("@/db/queries");

    const result = await cancelShopifyReturn("gid://shopify/Return/1");

    expect(shopifyBody).toContain("returnCancel");
    expect(shopifyBody).toContain("gid://shopify/Return/1");
    expect(result.success).toBe(true);
  });

  it("reports failure on userErrors rather than throwing", async () => {
    // The caller has already cancelled Amphora and cannot undo it, so it needs
    // a value it can act on, not an exception mid-chain.
    shopifyResponse.value = {
      data: { returnCancel: { return: null, userErrors: [{ field: "id", message: "nope" }] } },
    } as any;
    const { cancelShopifyReturn } = await import("@/db/queries");

    const result = await cancelShopifyReturn("gid://shopify/Return/1");

    expect(result.success).toBe(false);
  });
});

describe("resetOrderReturn", () => {
  it("clears the tracking the cancelled return carried", async () => {
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const orderUpdate = setCalls.find((c) => "locator" in c);
    expect(orderUpdate).toMatchObject({
      locator: null,
      carrier: null,
      carrierUrl: null,
      returnStatus: null,
    });
  });

  it("clears the confirmation and the Shopify return ids from every line", async () => {
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const lineUpdate = setCalls.find((c) => "confirmed" in c);
    expect(lineUpdate).toMatchObject({
      confirmed: false,
      return_id: null,
      return_line_item_id: null,
    });
  });

  it("clears the customer's selections so they get a clean wizard", async () => {
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const lineUpdate = setCalls.find((c) => "confirmed" in c);
    expect(lineUpdate).toMatchObject({
      action: null,
      reason: null,
      notes: null,
      new_variant_id: null,
      new_variant_title: null,
    });
  });
});
