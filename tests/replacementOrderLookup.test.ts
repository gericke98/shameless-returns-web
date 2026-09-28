import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORIGINALS: Record<string, any> = {};
vi.mock("@/db/queries", () => ({
  getOrderByNumberFresh: async (n: string) => ORIGINALS[n],
}));
const alerts: string[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
}));

const replacement = (tags: string) => ({
  id: 13327059452230,
  name: "#312061",
  tags,
  line_items: [{ variant_id: 54623384404294, product_id: 14958568177990, quantity: 1 }],
}) as any;

beforeEach(() => {
  alerts.length = 0;
  for (const k of Object.keys(ORIGINALS)) delete ORIGINALS[k];
  ORIGINALS["#311749"] = {
    id: "13282550841670",
    products: [{
      variant_id: "54623384437062", productId: "14958568177990",
      new_variant_id: "gid://shopify/ProductVariant/54623384404294",
      action: "CAMBIO", confirmed: true, price: "47.03",
    }],
  };
});

async function plan(order: any) {
  const { planReplacementOrder } = await import("@/actions/replacementOrder");
  return planReplacementOrder(order);
}

describe("planReplacementOrder", () => {
  it("leaves an ordinary order alone and alerts nothing", async () => {
    await expect(plan(replacement("amphora_shipped"))).resolves.toEqual({ kind: "ordinary" });
    expect(alerts).toHaveLength(0);
  });

  it("links a replacement to its original and prices from the paid row", async () => {
    await expect(plan(replacement("Change, Order #311749"))).resolves.toEqual({
      kind: "replacement",
      exchangeOf: "13282550841670",
      priceByVariant: { "54623384404294": "47.03" },
    });
  });

  it("refuses and alerts when the original is not in our DB", async () => {
    const out = await plan(replacement("Change, Order #999999"));
    expect(out).toEqual({ kind: "refused", reason: "original-not-found:#999999" });
    expect(alerts).toHaveLength(1);
  });

  it("refuses and alerts when a line cannot be matched", async () => {
    ORIGINALS["#311749"].products[0].new_variant_id = "gid://shopify/ProductVariant/1";
    const out = await plan(replacement("Change, Order #311749"));
    expect(out.kind).toBe("refused");
    expect(alerts).toHaveLength(1);
  });

  it("ignores zero-quantity lines like the lookup does", async () => {
    const order = replacement("Change, Order #311749");
    order.line_items.push({ variant_id: 1, product_id: 2, quantity: 0 });
    await expect(plan(order)).resolves.toMatchObject({ kind: "replacement" });
  });
});
