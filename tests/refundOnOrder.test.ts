import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const bodies: any[] = [];
let READ: any;
let WRITE: any;

beforeEach(() => {
  bodies.length = 0;
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.test";
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "t";
  READ = {
    data: { order: {
      refunds: [],
      transactions: [
        { id: "gid://shopify/OrderTransaction/9", gateway: "shopify_payments", kind: "SALE", status: "SUCCESS" },
      ],
      totalPriceSet: {
        shopMoney: { amount: "93.28", currencyCode: "EUR" },
        presentmentMoney: { amount: "93.28", currencyCode: "EUR" },
      },
    } },
  };
  WRITE = { data: { refundCreate: { refund: { id: "r1" }, userErrors: [] } } };
  vi.stubGlobal("fetch", async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return { ok: true, json: async () => (body.query.includes("refundCreate") ? WRITE : READ) };
  });
});
afterEach(() => vi.unstubAllGlobals());

async function refund() {
  const { refundOnOrder } = await import("@/db/queries");
  return refundOnOrder("13282550841670", "gid://shopify/OrderTransaction/9", 42.03, "rli-MARK", "note");
}

describe("refundOnOrder", () => {
  it("refunds once, carrying the marker in the note", async () => {
    await expect(refund()).resolves.toEqual({ success: true, alreadyRefunded: false });
    const write = bodies.find((b) => b.query.includes("refundCreate"));
    expect(write.variables.input.transactions[0]).toMatchObject({
      parentId: "gid://shopify/OrderTransaction/9",
      amount: "42.03",
      kind: "REFUND",
      gateway: "shopify_payments",
    });
    expect(write.variables.input.currency).toBe("EUR");
    expect(write.variables.input.note).toContain("rli-MARK");
  });

  it("does not refund again when a refund already carries the marker", async () => {
    READ.data.order.refunds = [{ note: "... rli-MARK ..." }];
    await expect(refund()).resolves.toEqual({ success: true, alreadyRefunded: true });
    expect(bodies.some((b) => b.query.includes("refundCreate"))).toBe(false);
  });

  it("refuses to move money when the order cannot be read", async () => {
    READ = { errors: [{ message: "boom" }] };
    const out = await refund();
    expect(out.success).toBe(false);
    expect(bodies.some((b) => b.query.includes("refundCreate"))).toBe(false);
  });

  it("converts to the root order's presentment currency and declares it on RefundInput.currency", async () => {
    READ.data.order.totalPriceSet.presentmentMoney = { amount: "80.00", currencyCode: "GBP" };
    await refund();
    const write = bodies.find((b) => b.query.includes("refundCreate"));
    expect(write.variables.input.transactions[0].amount).toBe((42.03 * (80 / 93.28)).toFixed(2));
    expect(write.variables.input.currency).toBe("GBP");
  });

  it("reports Shopify userErrors as a failure", async () => {
    WRITE = { data: { refundCreate: { refund: null, userErrors: [{ message: "no" }] } } };
    await expect(refund()).resolves.toMatchObject({ success: false });
  });

  it("refuses when the parent transaction is absent from the order's transactions", async () => {
    READ.data.order.transactions = [
      { id: "gid://shopify/OrderTransaction/999", gateway: "shopify_payments", kind: "SALE", status: "SUCCESS" },
    ];
    const out = await refund();
    expect(out).toMatchObject({ success: false });
    expect(bodies.some((b) => b.query.includes("refundCreate"))).toBe(false);
  });

  it("uses the parent transaction's own gateway, not a hardcoded one", async () => {
    READ.data.order.transactions = [
      { id: "gid://shopify/OrderTransaction/9", gateway: "paypal", kind: "SALE", status: "SUCCESS" },
    ];
    await refund();
    const write = bodies.find((b) => b.query.includes("refundCreate"));
    expect(write.variables.input.transactions[0].gateway).toBe("paypal");
  });
});
