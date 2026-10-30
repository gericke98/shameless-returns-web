import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORIGINALS: Record<string, any> = {};
vi.mock("@/db/queries", () => ({
  getOrderByNumberFresh: async (n: string) => ORIGINALS[n],
}));
vi.mock("@/db/drizzle", () => ({ default: {}, transact: async () => [] }));
let FUNDING: any = { kind: "not-settlement" };
vi.mock("@/db/replacementLines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/replacementLines")>()),
  replacementFundingOf: async () => FUNDING,
}));
const alerts: string[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
}));

const replacement = (tags: string) => ({
  id: 13327059452230,
  name: "#312061",
  tags,
  line_items: [{ id: 35000000000001, variant_id: 54623384404294, product_id: 14958568177990, quantity: 1 }],
}) as any;

beforeEach(() => {
  alerts.length = 0;
  FUNDING = { kind: "not-settlement" };
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
      priceByLineItem: { "35000000000001": "47.03" },
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

  describe("an exchange order settlement created (S2)", () => {
    const funded = (lines: Array<[string, number, number]>) => ({
      kind: "funded",
      funding: {
        sourceOrderId: "13282550841670",
        lineByLineItem: new Map(lines.map(([id, totalCents, quantity]) => [id, { totalCents, quantity }])),
      },
    });

    it("prices each line from replacement_lines, by line item id, not from tags", async () => {
      // A cheaper swap that the customer topped up by card: 35.00 of returned
      // value + 12.50 paid by Stripe = 47.50 a unit — whatever the tags say.
      FUNDING = funded([["gid://shopify/LineItem/35000000000001", 4750, 1]]);
      await expect(plan(replacement("amphora_shipped"))).resolves.toEqual({
        kind: "replacement",
        exchangeOf: "13282550841670",
        priceByLineItem: { "35000000000001": "47.5" },
      });
      expect(alerts).toHaveLength(0);
    });

    it("refuses a line settlement did not fund, rather than pricing it at list", async () => {
      FUNDING = funded([]);
      const out = await plan(replacement("Change, Order #311749"));
      expect(out).toEqual({ kind: "refused", reason: "unfunded-line:35000000000001" });
      expect(alerts).toHaveLength(1);
    });

    it("refuses an S2 order whose records are missing — even with tags that would price it (finding 5)", async () => {
      FUNDING = { kind: "unfunded", sourceOrderId: "13282550841670", reason: "no-replacement-lines" };
      const out = await plan(replacement("Change, Order #311749"));
      expect(out).toEqual({ kind: "refused", reason: "settlement-order-unfunded:no-replacement-lines" });
      expect(alerts).toHaveLength(1);
    });

    it.each([2, 3])(
      "keeps the exact line total: 3101 cents over %i units is valued back at 3101 (finding 8)",
      async (quantity) => {
        FUNDING = funded([["gid://shopify/LineItem/35000000000001", 3101, quantity]]);
        const order = replacement("amphora_shipped");
        order.line_items[0].quantity = quantity;
        const out = (await plan(order)) as any;
        const price = out.priceByLineItem["35000000000001"];
        // How every reader values a stored row (lib/basket.ts valueLine).
        const { valueLine } = await import("@/lib/basket");
        const { indexCatalogue } = await import("@/lib/replacementPricing");
        const valued = valueLine(
          { id: 1, action: "DEVOLUCIÓN", price: String(Number(price)), quantity } as any,
          indexCatalogue([] as any),
          null
        );
        expect(valued.returnedCents).toBe(3101);
      }
    );
  });
});

describe("unitPriceOf (finding 8)", () => {
  it("round-trips every integer line total for quantities 1–10 through valueLine's arithmetic", async () => {
    const { unitPriceOf } = await import("@/db/replacementLines");
    for (let quantity = 1; quantity <= 10; quantity += 1) {
      for (let totalCents = 1; totalCents <= 50_000; totalCents += 7) {
        const unit = Number(unitPriceOf({ totalCents, quantity }).toString());
        expect(Math.round(unit * quantity * 100)).toBe(totalCents);
      }
    }
  });
});
