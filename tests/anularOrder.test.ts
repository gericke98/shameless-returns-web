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

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  // db/fees.ts wraps its reader in unstable_cache at module scope.
  unstable_cache: (fn: unknown) => fn,
}));

describe("anularOrder", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("scopes the write to one productsorder row by its primary key", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242);

    expect(captured).toHaveLength(1);
    expect(captured[0].params).toEqual([4242]);
    expect(captured[0].sql).toMatch(/"id"\s*=/);
  });

  it("does not scope by variant_id, which is shared across customers' orders", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(4242);

    expect(captured[0].sql).not.toMatch(/variant_id/);
  });

  it("writes nothing when given no row id", async () => {
    const { anularOrder } = await import("@/actions/updateOrder");
    await anularOrder(undefined as unknown as number);
    await anularOrder(0);
    await anularOrder(NaN);

    expect(captured).toHaveLength(0);
  });
});
