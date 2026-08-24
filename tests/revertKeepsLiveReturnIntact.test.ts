import { beforeEach, describe, expect, it, vi } from "vitest";

// Order #311329 (Koen Krijnen, Netherlands), 2026-08-21. A paid exchange whose
// Amphora booking reported 501 — the POST threw and the immediate read-back
// found nothing, though Amphora had in fact committed the collection. The
// Stripe webhook then reverted.
//
// The per-line revert did the right thing: every line carried a Shopify
// return_id, so it refused (the #310957 lesson). But `releaseExchangeReservation`
// ran anyway, one line below the loop and outside its result — so a live
// exchange lost the stock hold on its replacement garment while the return,
// the collection and the customer's confirmation email all survived.
//
// The rule: a refused line means a REAL Shopify return still exists. The hold
// belongs to that return, so it must outlive a revert that could not undo it.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

let rows: any[] = [];
const released: string[] = [];
const updates: any[] = [];

vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async (id: string) => {
    released.push(id);
    return true;
  },
  reserveExchangeStock: async () => {},
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  // db/fees.ts wraps the fee table in it at module load, so importing
  // updateOrder pulls it in even though the revert branch never reads fees.
  unstable_cache: (fn: unknown) => fn,
}));

vi.mock("@/db/drizzle", () => {
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
});

async function revert() {
  const { updateFinalOrder } = await import("@/actions/updateOrder");
  return updateFinalOrder("13238997909830", true, false);
}

beforeEach(() => {
  released.length = 0;
  updates.length = 0;
});

describe("reverting a return that cannot actually be undone", () => {
  it("keeps the exchange stock hold when a line carries a Shopify return", async () => {
    // The exact shape of #311329: one confirmed exchange line with a live
    // Shopify return behind it.
    rows = [
      {
        variant_id: "55927926587718",
        confirmed: true,
        return_id: "gid://shopify/Return/57356845382",
      },
    ];

    await revert();

    expect(released).toHaveLength(0);
  });

  it("still refuses to un-confirm that line", async () => {
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

  it("releases the hold when the revert genuinely undid everything", async () => {
    // No return_id anywhere: nothing external exists, so the replacement
    // garments must not stay frozen for a return that no longer exists.
    rows = [{ variant_id: "1", confirmed: true, return_id: null }];

    await revert();

    expect(released).toEqual(["13238997909830"]);
  });

  it("keeps the hold when only SOME lines are refused", async () => {
    // A partially-created return is still a return. One live Shopify return on
    // the order is enough to make the hold load-bearing.
    rows = [
      { variant_id: "1", confirmed: true, return_id: null },
      { variant_id: "2", confirmed: true, return_id: "gid://shopify/Return/1" },
    ];

    await revert();

    expect(released).toHaveLength(0);
  });

  it("releases the hold when there was nothing to revert at all", async () => {
    // Nothing confirmed, nothing refused. A hold here belongs to no return.
    rows = [{ variant_id: "1", confirmed: false, return_id: null }];

    await revert();

    expect(released).toEqual(["13238997909830"]);
  });
});
