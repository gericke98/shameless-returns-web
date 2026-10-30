import { describe, expect, it, vi } from "vitest";
import { planAdmission } from "@/lib/settlement/plan";
import { SOURCE_LINE_PROPERTY } from "@/lib/settlement/types";
import { line, planInput, submission } from "./support/planFixtures";

// One exchange order per submission (S2 plan L3/L6), now decided by admission
// rather than by a loop in validateReturn.
//
// Replaces the pre-S2 "releases the stock hold BEFORE creating the real
// order": the hold is now released only AFTER the replacement order exists
// (`release_hold.after = exchange_order`), so stock is never unheld while no
// order holds it either. "closes the shared return once" is removed behaviour
// (returnClose is gone; returnProcess closes a fully processed return).

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {}, transact: async () => [] }));

const V1 = "gid://shopify/ProductVariant/11";
const V2 = "gid://shopify/ProductVariant/22";
const exchangeLines = () => [
  line(1, { action: "CAMBIO", newVariantId: V1, payCents: 0 }),
  line(2, { action: "CAMBIO", newVariantId: V2, payCents: 0, quantity: 2 }),
];

describe("admission — one exchange order per submission", () => {
  it("creates ONE Shopify order carrying BOTH replacement garments", () => {
    const plan = planAdmission(planInput(exchangeLines()));
    if (!plan.ok) throw new Error(plan.held);
    const orders = plan.ops.filter((o) => o.kind === "exchange_order");
    expect(orders).toHaveLength(1);
    const items = (orders[0].request.variables as any).order.lineItems;
    expect(items.map((i: any) => [i.variantId, i.quantity])).toEqual([[V1, 1], [V2, 2]]);
    expect(orders[0].members).toEqual([1, 2]);
  });

  it("tags every replacement line with the productsorder id it replaces", () => {
    const plan = planAdmission(planInput(exchangeLines()));
    if (!plan.ok) throw new Error(plan.held);
    const items = (plan.ops.find((o) => o.kind === "exchange_order")!.request.variables as any).order.lineItems;
    expect(items.map((i: any) => i.properties)).toEqual([
      [{ name: SOURCE_LINE_PROPERTY, value: "1" }],
      [{ name: SOURCE_LINE_PROPERTY, value: "2" }],
    ]);
  });

  it("names the order with the operation's own id as sourceIdentifier", () => {
    const plan = planAdmission(planInput(exchangeLines()));
    if (!plan.ok) throw new Error(plan.held);
    const op = plan.ops.find((o) => o.kind === "exchange_order")!;
    expect((op.request.variables as any).order.sourceIdentifier).toBe(op.id);
  });

  it("does not create a second order when the exchange is already admitted", () => {
    const plan = planAdmission(
      planInput(exchangeLines(), {
        existing: [{ id: "op-x", kind: "exchange_order", scopeKey: `exchange:${submission().id}` }],
      })
    );
    if (!plan.ok) throw new Error(plan.held);
    expect(plan.ops.filter((o) => o.kind === "exchange_order")).toHaveLength(0);
  });

  it("admits the whole exchange from EITHER row", async () => {
    const { expandAdmission } = await import("@/lib/settlement/admission");
    const lines = [...exchangeLines(), line(3)];
    expect(expandAdmission(lines, [1])).toEqual([1, 2]);
    expect(expandAdmission(lines, [2])).toEqual([1, 2]);
    expect(expandAdmission(lines, [3])).toEqual([3]);
  });

  it("releases the stock hold only AFTER the replacement order exists", () => {
    const plan = planAdmission(
      planInput(exchangeLines(), { reservation: { draftOrderId: "gid://shopify/DraftOrder/5", existed: true } })
    );
    if (!plan.ok) throw new Error(plan.held);
    const order = plan.ops.find((o) => o.kind === "exchange_order")!;
    const hold = plan.ops.find((o) => o.kind === "release_hold")!;
    expect(hold.after).toBe(order.id);
    // The held stock is already committed by the draft: the order must not
    // be refused for it.
    expect((order.request.variables as any).options.inventoryBehaviour).toBe("DECREMENT_IGNORING_POLICY");
  });

  it("holds the whole admission when a replacement variant was never recorded", () => {
    const plan = planAdmission(
      planInput([line(1, { action: "CAMBIO", newVariantId: null, payCents: 0 })])
    );
    expect(plan).toEqual({ ok: false, held: "bad-replacement-variant:1" });
  });
});
