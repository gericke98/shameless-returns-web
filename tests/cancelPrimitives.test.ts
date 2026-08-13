import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { orders, productsOrder } from "@/db/schema";

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
// The argument each `.set()` call's matching `.where()` was scoped by, in the
// same order as setCalls. If a regression drops the `.where()` or scopes it by
// the wrong column, this is where that would show up — the values above would
// still look right even as every row in the table got wiped.
const whereCalls: Array<any> = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      setCalls.push(values);
      return chain;
    },
    where: (condition: any) => {
      whereCalls.push(condition);
      return Promise.resolve();
    },
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
  whereCalls.length = 0;
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

  it("sends the id as a GraphQL variable, never interpolated into the document", async () => {
    // Passing the raw id anywhere near the mutation string is the exact
    // injection pattern `createReturn`'s comment warns against — a document
    // that cancels a return being built from unescaped customer-reachable
    // input. `variables.id` is the only place it's allowed to appear.
    const { cancelShopifyReturn } = await import("@/db/queries");

    await cancelShopifyReturn("gid://shopify/Return/1");

    const parsed = JSON.parse(shopifyBody);
    expect(parsed.variables.id).toBe("gid://shopify/Return/1");
    expect(parsed.query).not.toContain("gid://shopify/Return/1");
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

  it("reports failure instead of throwing when the Shopify env vars are missing", async () => {
    // createSession() throws synchronously when these are unset. By the time
    // this function runs, the caller has already cancelled the Amphora return
    // and cannot undo that — an escaping throw here strands the customer with
    // no return and no refund, instead of a failure a caller can act on.
    delete process.env.NEXT_PUBLIC_ACCESS_TOKEN;
    delete process.env.NEXT_PUBLIC_SHOP_URL;
    const { cancelShopifyReturn } = await import("@/db/queries");

    await expect(cancelShopifyReturn("gid://shopify/Return/1")).resolves.toMatchObject({
      success: false,
    });
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

  it("clears the Stripe payment intent, so the NEXT return cannot reuse it", async () => {
    // Leaving `pi_1` behind poisons the next cancellation two different ways.
    // If the second return is FREE, `refundOrderPayment` is handed the old
    // intent and either replays the first refund (Stripe's idempotency makes
    // that look like success) or errors and tells ops to refund by hand for a
    // return that cost nothing. And if the second return IS paid but the
    // webhook's intent write fails — it is swallowed — the stale value
    // short-circuits `resolvePaymentIntentId`'s session-lookup fallback, so
    // the customer is never refunded for what they actually paid.
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const orderUpdate = setCalls.find((c) => "locator" in c);
    expect(orderUpdate).toMatchObject({ stripePaymentIntent: null });
  });

  it("scopes each update to the one order, not the whole table", async () => {
    // A regression that dropped the `.where()` or scoped it by the wrong
    // column would still pass every assertion above — it would just also
    // wipe the tracking and line selections of every other order in the
    // table. This is the only test that would catch that.
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const orderUpdateIndex = setCalls.findIndex((c) => "locator" in c);
    const lineUpdateIndex = setCalls.findIndex((c) => "confirmed" in c);

    expect(whereCalls[orderUpdateIndex]).toEqual(eq(orders.id, "1"));
    expect(whereCalls[lineUpdateIndex]).toEqual(eq(productsOrder.orderId, "1"));
    // The two scopes must be genuinely different conditions (different
    // columns), not the same `where` reused for both updates.
    expect(whereCalls[orderUpdateIndex]).not.toEqual(whereCalls[lineUpdateIndex]);
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

  it("clears the exchange flag, not just the exchange data", async () => {
    // `changed` is the ONLY selection column this reset used to leave behind,
    // and it is the one the portal renders from: `productLineClient` strikes
    // the size through whenever `changed` is true, and shows the replacement
    // beside it only when `new_variant_title` is also set. Clearing the latter
    // without the former left a cancelled line struck through with nothing
    // next to it — the customer's garment displayed as an exchange for
    // nothing, on a return they had just cancelled.
    //
    // Order #311258 (elvidibu, cancelled 2026-08-13) is the row that showed it.
    const { resetOrderReturn } = await import("@/db/queries");

    await resetOrderReturn("1");

    const lineUpdate = setCalls.find((c) => "confirmed" in c);
    expect(lineUpdate).toMatchObject({ changed: false });
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
