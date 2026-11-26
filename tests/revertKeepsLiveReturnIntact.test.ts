import { beforeEach, describe, expect, it, vi } from "vitest";
import { vid } from "./support/verified";

// Order #311329 (Koen Krijnen, Netherlands), 2026-08-21. A paid exchange whose
// Amphora booking reported 501 — the POST threw and the immediate read-back
// found nothing, though Amphora had in fact committed the collection. The
// Stripe webhook then reverted.
//
// The rule: a line carrying a Shopify return_id means a REAL Shopify return
// still exists, and reverting cannot delete it — so the revert refuses that
// line and leaves it confirmed. (The stock-hold release that once ran below
// the loop is gone with the holds themselves, FX: nothing is released here.)

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

let rows: any[] = [];
const updates: any[] = [];

vi.mock("@/lib/server/opsAlert", () => ({ alertOps: async () => {} }));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  // db/fees.ts wraps the fee table in it at module load, so importing
  // updateOrder pulls it in even though the revert branch never reads fees.
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      updates.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
    query: {
      productsOrder: { findMany: async () => rows },
    },
  };
  return { default: chain };
})()));

async function revert() {
  const { revertFinalOrder } = await import("@/lib/submissionConfirmation");
  return revertFinalOrder(vid("13238997909830"));
}

beforeEach(() => {
  updates.length = 0;
});

describe("reverting a return that cannot actually be undone", () => {
  it("refuses to un-confirm a line that carries a Shopify return", async () => {
    rows = [
      {
        variant_id: "55927926587718",
        confirmed: true,
        return_id: "gid://shopify/Return/57356845382",
      },
    ];

    await revert();

    expect(updates).toHaveLength(0);
  });

  it("un-confirms only the lines with nothing external behind them", async () => {
    rows = [
      { id: 1, variant_id: "1", confirmed: true, return_id: null },
      { id: 2, variant_id: "2", confirmed: true, return_id: "gid://shopify/Return/1" },
    ];

    await revert();

    expect(updates).toEqual([{ confirmed: false, return_id: null }]);
  });
});
