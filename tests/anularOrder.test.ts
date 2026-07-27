import { beforeEach, describe, expect, it, vi } from "vitest";

// `anularOrder` was scoped by `productsOrder.variant_id` alone. That column
// holds the SHOPIFY PRODUCT VARIANT id, which is the same value in every order
// containing that product in that size — so one call cleared `changed`,
// `action`, `reason`, `notes` and the new-variant fields for EVERY customer who
// had bought it. It is a "use server" action, so it is an addressable endpoint,
// and a variant id is public storefront data: no order id was needed.
//
// These tests pin that the write is scoped to a single productsorder ROW.

const captured: { sql: string; params: unknown[] }[] = [];

// `actions/updateOrder.ts` imports `db/queries.ts`, which wraps reads in React's
// `cache()`. That export only exists under Next's "react-server" condition, so
// plain vitest resolves a React build without it. Stub it as a pass-through —
// same shim `tests/countries.test.ts` uses, for the same reason.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/db/drizzle", () => {
  const chain = {
    update: () => chain,
    set: () => chain,
    where: (condition: unknown) => {
      // Render the condition through drizzle's own dialect so the assertion
      // sees the real SQL, not a hand-built approximation.
      const { PgDialect } = require("drizzle-orm/pg-core");
      const query = new PgDialect().sqlToQuery(condition as never);
      captured.push({ sql: query.sql, params: query.params });
      return Promise.resolve();
    },
  };
  return { default: chain };
});

const access = { granted: true };
vi.mock("@/lib/orderAccess", () => ({
  hasOrderAccess: async () => access.granted,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  // db/fees.ts wraps its reader in unstable_cache at module scope.
  unstable_cache: (fn: unknown) => fn,
}));

describe("anularOrder", () => {
  beforeEach(() => {
    captured.length = 0;
    access.granted = true;
  });

  it("scopes the write to one productsorder row by its primary key", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242, "5678901234");

    expect(captured).toHaveLength(1);
    expect(captured[0].params).toEqual([4242, "5678901234"]);
    expect(captured[0].sql).toMatch(/"id"\s*=/);
  });

  it("does not scope by variant_id, which is shared across customers' orders", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242, "5678901234");

    expect(captured[0].sql).not.toMatch(/variant_id/);
  });

  it("also scopes by order_id, so a row id alone is not enough", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242, "5678901234");

    expect(captured[0].sql).toMatch(/order_id/);
  });

  it("writes nothing without a portal session for that order", async () => {
    access.granted = false;
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242, "5678901234");

    expect(captured).toHaveLength(0);
  });

  it("writes nothing when no order id is given", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242, "");

    expect(captured).toHaveLength(0);
  });

  it("writes nothing when given no row id", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(undefined as unknown as number, "5678901234");
    await anularOrder(0, "5678901234");
    await anularOrder(NaN, "5678901234");

    expect(captured).toHaveLength(0);
  });
});
