import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const LINKS: Record<string, string | null> = {};
const TX: Record<string, any[]> = {};
vi.mock("@/db/queries", () => ({
  getOrderByNumberFresh: async () => null,
  getOrderByIdFresh: async (id: string) => ({ id, exchangeOf: LINKS[id] ?? null }),
  getOrderTransactions: async (id: string) => TX[id] ?? null,
}));
vi.mock("@/actions/opsAlert", () => ({ alertOps: async () => {} }));

const PLACEHOLDER = { transactionId: "gid://shopify/OrderTransaction/0", transactionAmount: "0.01" };

beforeEach(() => {
  for (const k of Object.keys(LINKS)) delete LINKS[k];
  for (const k of Object.keys(TX)) delete TX[k];
});

async function source(dbOrder: any) {
  const { refundSourceFor } = await import("@/actions/replacementOrder");
  return refundSourceFor(dbOrder, PLACEHOLDER);
}

describe("refundSourceFor", () => {
  it("keeps the return's own transaction on an ordinary order", async () => {
    await expect(source({ id: "A", exchangeOf: null })).resolves.toEqual(PLACEHOLDER);
  });

  it("uses the root order's settled payment on a replacement order", async () => {
    LINKS["B"] = "A";
    TX["A"] = [{ id: "gid://shopify/OrderTransaction/9", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "93.28" } } }];
    await expect(source({ id: "B", exchangeOf: "A" })).resolves.toEqual({
      transactionId: "gid://shopify/OrderTransaction/9",
      transactionAmount: "93.28",
    });
  });

  it("walks a chain to the root", async () => {
    LINKS["C"] = "B"; LINKS["B"] = "A";
    TX["A"] = [{ id: "root", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "10" } } }];
    await expect(source({ id: "C", exchangeOf: "B" })).resolves.toMatchObject({ transactionId: "root" });
  });

  it("stores null rather than the placeholder when the root has no settled payment", async () => {
    LINKS["B"] = "A";
    TX["A"] = [];
    await expect(source({ id: "B", exchangeOf: "A" })).resolves.toEqual({
      transactionId: null,
      transactionAmount: null,
    });
  });
});
