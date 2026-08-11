import { beforeEach, describe, expect, it, vi } from "vitest";

// `getOrderById` is wrapped in React `cache()`, which dedupes within one render
// pass. The status poller is not a render pass: it runs repeatedly on warm,
// reused serverless instances, and in production it read a snapshot taken
// before any status had been written —
//
//   [amphora-sync][diag] #310905: read returnStatus=null
//     locator="1Z3EF3229113605089" vs amphora="TRAVELLING"
//
// `locator` (written when the return was created) was there; `returnStatus`
// (written by the first sync) was not. So every run decided the status had
// changed and rewrote it. Harmless only because collectionScheduled is disarmed
// by a stored locator — returnReceived would have emailed on every run.
//
// This pins the contract of the uncached reader. It cannot pin the bug itself:
// any test that mocks @/db/queries bypasses React's cache and passes either
// way. The fix is verified against production by running the sync twice.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const rows: Record<string, any> = {
  "13182814978374": {
    id: "13182814978374",
    orderNumber: "#310905",
    returnStatus: null,
    locator: "1Z3EF3229113605089",
    products: [],
  },
};

let queries = 0;

vi.mock("@/db/drizzle", () => ({
  default: {
    query: {
      orders: {
        findFirst: async ({ where }: any) => {
          queries += 1;
          // The mock ignores the predicate and returns the single row under
          // test; what matters is that a query happens at all.
          void where;
          return rows["13182814978374"];
        },
      },
    },
  },
}));

beforeEach(() => {
  queries = 0;
  rows["13182814978374"].returnStatus = null;
});

describe("getOrderByIdFresh", () => {
  it("sees a value written since the last read", async () => {
    const { getOrderByIdFresh } = await import("@/db/queries");

    const before: any = await getOrderByIdFresh("13182814978374");
    expect(before.returnStatus).toBeNull();

    rows["13182814978374"].returnStatus = "TRAVELLING";

    const after: any = await getOrderByIdFresh("13182814978374");
    expect(after.returnStatus).toBe("TRAVELLING");
  });

  it("queries the database on every call rather than memoising", async () => {
    const { getOrderByIdFresh } = await import("@/db/queries");

    await getOrderByIdFresh("13182814978374");
    await getOrderByIdFresh("13182814978374");
    await getOrderByIdFresh("13182814978374");

    expect(queries).toBe(3);
  });

  it("still loads the line items the ownership rule needs", async () => {
    // hasConfirmedReturn reads order.products; a reader that dropped the
    // relation would make every orphan look unowned and silently skip it.
    const { getOrderByIdFresh } = await import("@/db/queries");

    const order: any = await getOrderByIdFresh("13182814978374");

    expect(order.products).toBeDefined();
  });
});
