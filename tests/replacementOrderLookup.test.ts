import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/db/queries", () => ({}));
vi.mock("@/db/drizzle", () => ({ default: {}, transact: async () => [] }));
let FUNDING: any = { kind: "not-settlement" };
vi.mock("@/db/replacementLines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/replacementLines")>()),
  replacementFundingOf: async () => FUNDING,
}));
const alerts: string[] = [];
const bodies: string[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => { alerts.push(subject); bodies.push(body); },
}));

const replacement = (tags: string) => ({
  id: 13327059452230,
  name: "#312061",
  tags,
  line_items: [{ id: 35000000000001, variant_id: 54623384404294, product_id: 14958568177990, quantity: 1 }],
}) as any;

beforeEach(() => {
  alerts.length = 0;
  bodies.length = 0;
  FUNDING = { kind: "not-settlement" };
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

  it("never prices from tags, and a KNOWN replacement with no funding refuses — never ordinary (S3 R4, Codex #3)", async () => {
    // Before S3 these tags + the original's CAMBIO row priced the line at
    // 47.03. Now the census / reconciliation name it a replacement by id, and
    // with no replacement_lines it is not returnable online: never list price.
    FUNDING = { kind: "unfunded", sourceOrderId: "13282550841670", reason: "replacement-without-funding", sourceLines: [41, 42] };
    await expect(plan(replacement("Change, Order #311749"))).resolves.toEqual({
      kind: "refused",
      reason: "settlement-order-unfunded:replacement-without-funding",
    });
    expect(alerts).toHaveLength(1);
    // The alert names the funding script with this order and each source line (Santi 30 Oct, A).
    expect(bodies[0]).toContain("scripts/fund-replacement-line.ts --order 13327059452230 --line 41 ");
    expect(bodies[0]).toContain("scripts/fund-replacement-line.ts --order 13327059452230 --line 42 ");
  });

  it("a known replacement no reconciled exchange names yet: the alert says to resolve that first", async () => {
    FUNDING = { kind: "unfunded", sourceOrderId: "13282550841670", reason: "replacement-without-funding", sourceLines: [] };
    await plan(replacement("Change"));
    expect(bodies[0]).toContain("resolve-operation.ts --op <its operation id> --done --order gid://shopify/Order/13327059452230");
    expect(bodies[0]).toContain("fund-replacement-line.ts --order 13327059452230 --line <source productsorder id>");
  });

  it("before the census has run, no order can be shown ordinary: refused, never list-priced (cutover coverage)", async () => {
    FUNDING = { kind: "unprovable", reason: "replacement-census-missing" };
    await expect(plan(replacement("amphora_shipped"))).resolves.toEqual({ kind: "refused", reason: "replacement-census-missing" });
    expect(alerts).toHaveLength(1);
  });

  it("ignores zero-quantity lines like the lookup does", async () => {
    FUNDING = {
      kind: "funded",
      funding: {
        sourceOrderId: "13282550841670",
        lineByLineItem: new Map([["gid://shopify/LineItem/35000000000001", { totalCents: 4703, quantity: 1 }]]),
      },
    };
    const order = replacement("amphora_shipped");
    order.line_items.push({ id: 2, variant_id: 1, product_id: 2, quantity: 0 });
    await expect(plan(order)).resolves.toMatchObject({ kind: "replacement" });
  });

  describe("an exchange order settlement recorded (S2, or the S3 reconciliation)", () => {
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
