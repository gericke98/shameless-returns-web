import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReturnInput } from "@/lib/returnPayload";

// `createReturn` stored `order.transactions[0]` with no filter, and the query
// it read from selected neither `status` nor `kind` — so there was nothing to
// filter ON. Order #311882's customer paid twice: a FAILED €136.00 attempt on
// 2026-08-30, then a successful €129.20 sale the next day. `[0]` was the dead
// one, it went into `productsorder.transaction_id`, and every `returnRefund`
// against it failed with "All transactions failed to be refunded" — once a
// morning for five days, with no alert.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/db/drizzle", () => ({ default: {} }));

const sent: any[] = [];
let transactions: any[] = [];

const line = () => ({
  variant_id: "111",
  fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/1",
  quantity: 1,
  action: "DEVOLUCIÓN",
  reason: "TOO_SMALL",
  notes: "",
  new_variant_id: null,
});

beforeEach(() => {
  sent.length = 0;
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "shpat_test";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://example.myshopify.com";

  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return {
      json: async () => ({
        data: {
          returnCreate: {
            userErrors: [],
            return: {
              id: "gid://shopify/Return/58161463622",
              name: "#311882-R1",
              returnLineItems: { nodes: [] },
              exchangeLineItems: { nodes: [] },
              order: { transactions },
            },
          },
        },
      }),
    };
  });
});

function input() {
  return buildReturnInput("13292837830982", [line()], 5, {
    includeExchangeItems: false,
  });
}

describe("createReturn transaction selection", () => {
  it("asks Shopify for the status and kind of each transaction", async () => {
    transactions = [];
    const { createReturn } = await import("@/db/queries");

    await createReturn(input());

    // Without these fields on the wire there is nothing to filter on, which is
    // how the unfiltered `[0]` survived.
    expect(sent[0].query).toContain("status");
    expect(sent[0].query).toContain("kind");
  });

  it("stores the successful retry, not the customer's failed first attempt", async () => {
    transactions = [
      {
        id: "gid://shopify/OrderTransaction/14921336979782",
        kind: "SALE",
        status: "FAILURE",
        amountSet: { shopMoney: { amount: "136.0" } },
      },
      {
        id: "gid://shopify/OrderTransaction/14925389824326",
        kind: "SALE",
        status: "SUCCESS",
        amountSet: { shopMoney: { amount: "129.2" } },
      },
    ];
    const { createReturn } = await import("@/db/queries");

    const result = await createReturn(input());

    expect(result.success).toBe(true);
    expect(result.success && result.data.transactionId).toBe(
      "gid://shopify/OrderTransaction/14925389824326"
    );
    expect(result.success && result.data.transactionAmount).toBe("129.2");
  });

  it("reports no transaction rather than naming an unusable one", async () => {
    transactions = [
      {
        id: "gid://shopify/OrderTransaction/1",
        kind: "SALE",
        status: "FAILURE",
        amountSet: { shopMoney: { amount: "42.90" } },
      },
    ];
    const { createReturn } = await import("@/db/queries");

    const result = await createReturn(input());

    // Null, not the failed id: the settlement must refuse loudly later rather
    // than send Shopify an id that cannot take a refund.
    expect(result.success).toBe(true);
    expect(result.success && result.data.transactionId).toBeNull();
  });
});
