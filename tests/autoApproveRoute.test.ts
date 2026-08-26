import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This route pays customers with no human in the loop. It is PUBLIC —
// middleware.ts matches only /dashboard and /login — so CRON_SECRET is the only
// thing in front of it, and an unset secret must close it rather than open it.
//
// It must also be dry by default: an operator who deploys without setting
// AUTO_APPROVE_ENABLED gets a report, not a hundred payouts.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const RECEIVED_LONG_AGO = "2026-08-17T12:56:05";

const state = {
  returns: [] as any[],
  orders: [] as any[],
  shopifyStatuses: {} as Record<string, string>,
  skus: {} as Record<string, string>,
  settleThrowsOn: null as string | null,
  /** Which `productsorder` row ids a settle call reports it flipped, by the
   *  variant it was asked about. The exchange lane settles a whole order in
   *  one call, so this is not always the single line the route asked for. */
  lineIdsFor: {} as Record<string, string[]>,
  /** Virtual milliseconds each settle call consumes, so the wall-clock budget
   *  can be driven without real waiting. */
  msPerSettle: 0,
};
const settled: string[] = [];
const alerts: string[] = [];
const alertBodies: string[] = [];
/** The clock the route reads. Advanced only by the settle mock below. */
const clock = { t: 0 };

vi.mock("@/actions/amphora", () => ({ getAmphoraReturns: async () => state.returns }));
vi.mock("@/db/queries", () => ({
  getOrdersWithUnsettledReturns: async () => state.orders,
  getReturnStatusesByIds: async () => state.shopifyStatuses,
  getVariantSkusByIds: async () => state.skus,
}));
vi.mock("@/lib/settleReturn", () => ({
  settleReturnLine: async (product: any) => {
    clock.t += state.msPerSettle;
    if (state.settleThrowsOn === product.variant_id) throw new Error("shopify down");
    settled.push(product.variant_id);
    return {
      settled: true,
      lane: "refund",
      lineIds: state.lineIdsFor[product.variant_id] ?? [String(product.id)],
    };
  },
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push(subject);
    alertBodies.push(body);
  },
}));

function order(id: string, variantIds: string[]) {
  return {
    id,
    orderNumber: `#${id}`,
    products: variantIds.map((v) => ({
      id: `line-${v}`, variant_id: v, quantity: 1, confirmed: true, refunded: false,
      return_id: `gid://shopify/Return/${v}`, price: "50", action: "DEVOLUCIÓN", credit: false,
    })),
  };
}
function amphoraReturn(orderId: string, skus: string[], over: any = {}) {
  return {
    id: `SHP ${orderId}`, name: `#${orderId}`, external_id: orderId,
    internal_status: "RECEIVED", time_received: RECEIVED_LONG_AGO,
    items: skus.map((sku) => ({ sku, quantity: "1", quantity_received: "1" })),
    ...over,
  };
}

async function call(headers: Record<string, string> = {}, query = "") {
  const { GET } = await import("@/app/api/cron/auto-approve/route");
  return GET(new Request(`https://x.test/api/cron/auto-approve${query}`, { headers }));
}

beforeEach(() => {
  settled.length = 0;
  alerts.length = 0;
  alertBodies.length = 0;
  state.lineIdsFor = {};
  state.msPerSettle = 0;
  clock.t = 0;
  // The route measures its own wall clock with `Date.now()`. Driving that from
  // the settle mock is what lets a test prove the budget actually stops the
  // loop instead of only asserting the field exists.
  vi.spyOn(Date, "now").mockImplementation(() => clock.t);
  state.orders = [order("1001", ["v1"])];
  state.returns = [amphoraReturn("1001", ["SKU1"])];
  state.shopifyStatuses = { "gid://shopify/Return/v1": "OPEN" };
  state.skus = { v1: "SKU1" };
  state.settleThrowsOn = null;
  process.env.CRON_SECRET = "s3cret";
  process.env.AUTO_APPROVE_ENABLED = "true";
  delete process.env.AUTO_APPROVE_MAX_PER_RUN;
  delete process.env.AUTO_APPROVE_GRACE_DAYS;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auto-approve cron — authorisation", () => {
  it("401s when no secret is configured, rather than running open", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ authorization: "Bearer anything" });
    expect(res.status).toBe(401);
    expect(settled).toHaveLength(0);
  });

  it("401s on a wrong bearer", async () => {
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(settled).toHaveLength(0);
  });

  it("401s when the header is missing entirely", async () => {
    expect((await call()).status).toBe(401);
    expect(settled).toHaveLength(0);
  });
});

describe("auto-approve cron — settling", () => {
  it("settles an eligible line", async () => {
    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(settled).toEqual(["v1"]);
    expect(body.settled).toBe(1);
  });

  it("does not settle a return Shopify has already closed", async () => {
    state.shopifyStatuses = { "gid://shopify/Return/v1": "CLOSED" };
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "shopify-not-open:CLOSED" });
  });

  it("does not settle when the warehouse is a garment short", async () => {
    state.returns = [amphoraReturn("1001", ["SKU1"], {
      items: [{ sku: "SKU1", quantity: "1", quantity_received: "0" }],
    })];
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "short-receipt:SKU1" });
  });

  it("holds every line on an order when one sibling is short", async () => {
    state.orders = [order("1001", ["v1", "v2"])];
    state.skus = { v1: "SKU1", v2: "SKU2" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
    };
    state.returns = [amphoraReturn("1001", [], { items: [
      { sku: "SKU1", quantity: "1", quantity_received: "1" },
      { sku: "SKU2", quantity: "1", quantity_received: "0" },
    ] })];
    await call({ authorization: "Bearer s3cret" });
    expect(settled).toHaveLength(0);
  });

  it("holds an order with no Amphora record at all", async () => {
    state.returns = [];
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "no-amphora-record" });
  });
});

function threeEligibleOrders() {
  state.orders = [order("1001", ["v1"]), order("1002", ["v2"]), order("1003", ["v3"])];
  state.skus = { v1: "SKU1", v2: "SKU2", v3: "SKU3" };
  state.shopifyStatuses = {
    "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
    "gid://shopify/Return/v3": "OPEN",
  };
  state.returns = [
    amphoraReturn("1001", ["SKU1"]), amphoraReturn("1002", ["SKU2"]), amphoraReturn("1003", ["SKU3"]),
  ];
}

describe("auto-approve cron — throttles", () => {
  it("stops at the per-run cap and reports the remainder", async () => {
    threeEligibleOrders();
    process.env.AUTO_APPROVE_MAX_PER_RUN = "2";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(2);
    expect(body.capped).toBe(true);
  });

  it("stops starting settlements once the wall-clock budget is spent", async () => {
    // The money bug this guards: Vercel kills the function mid-`await`, the
    // payout has happened but `refunded` was never written, and the next run
    // pays the same garment again. Refusing to START work near the edge is the
    // only thing that bounds the window.
    threeEligibleOrders();
    state.msPerSettle = 25_000; // two settlements clear 40s

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(settled).toEqual(["v1", "v2"]);
    expect(body.budgetExhausted).toBe(true);
    // Distinct from the cap — nothing here hit the per-run limit.
    expect(body.capped).toBe(false);
  });

  it("reports budgetExhausted false on a run that finishes inside the budget", async () => {
    threeEligibleOrders();

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(settled).toHaveLength(3);
    expect(body.budgetExhausted).toBe(false);
  });

  it("keeps the default grace period when AUTO_APPROVE_GRACE_DAYS is blank", async () => {
    // `Number("")` is 0 and `0 >= 0` passes the old guard, so a variable added
    // in the Vercel dashboard and left blank meant "no grace period at all" —
    // a fail-OPEN on a safety control. Blank must read as absent.
    process.env.AUTO_APPROVE_GRACE_DAYS = "";
    state.returns = [
      amphoraReturn("1001", ["SKU1"], { time_received: new Date().toISOString() }),
    ];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "within-grace" });
  });

  it("keeps the default cap when AUTO_APPROVE_MAX_PER_RUN is blank", async () => {
    // Same helper, the other direction: blank used to mean a cap of 0, which
    // settled nothing at all.
    process.env.AUTO_APPROVE_MAX_PER_RUN = "";
    threeEligibleOrders();

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(settled).toHaveLength(3);
    expect(body.capped).toBe(false);
  });

  it("is DRY when AUTO_APPROVE_ENABLED is unset — a deploy alone pays nobody", async () => {
    delete process.env.AUTO_APPROVE_ENABLED;
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(0);
    expect(body.dry).toBe(true);
    expect(body.settled).toBe(1); // reports what it WOULD have settled
  });

  it("is DRY on ?dry=1 even when armed", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" }, "?dry=1")).json();
    expect(settled).toHaveLength(0);
    expect(body.dry).toBe(true);
  });

  // Only the exact string "true" arms this. Anything else — a truthy-looking
  // "1", the shouted "TRUE", or the blank value Vercel produces when someone
  // adds a variable and leaves it empty — must pay nobody.
  for (const value of ["1", "TRUE", ""]) {
    it(`is DRY when AUTO_APPROVE_ENABLED is ${JSON.stringify(value)}`, async () => {
      process.env.AUTO_APPROVE_ENABLED = value;
      const body = await (await call({ authorization: "Bearer s3cret" })).json();
      expect(settled).toHaveLength(0);
      expect(body.dry).toBe(true);
    });
  }
});

describe("auto-approve cron — honest reporting", () => {
  it("counts a batched exchange once per line and holds nothing", async () => {
    // The exchange lane settles EVERY pending exchange line of an order in one
    // call. The route loops per line, so without the returned line ids the
    // sibling comes back around, is refused as already-refunded, and lands in
    // `held` — reported as a failure moments after being paid.
    state.orders = [order("1001", ["v1", "v2"])];
    state.skus = { v1: "SKU1", v2: "SKU2" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
    };
    state.returns = [amphoraReturn("1001", ["SKU1", "SKU2"])];
    // One call settles both rows.
    state.lineIdsFor = { v1: ["line-v1", "line-v2"] };

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(settled).toEqual(["v1"]); // the sibling is never asked again
    expect(body.settled).toBe(2); // but both lines are counted
    expect(body.held).toEqual([]);
  });

  it("falls back to the order id when orderNumber is null", async () => {
    const o = order("1001", ["v1"]);
    o.orderNumber = null as any;
    state.orders = [o];
    state.shopifyStatuses = { "gid://shopify/Return/v1": "CLOSED" };

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.held).toContainEqual({
      order: "1001",
      reason: "shopify-not-open:CLOSED",
    });
  });
});

describe("auto-approve cron — resilience", () => {
  it("keeps settling after one line throws, and alerts on it", async () => {
    state.orders = [order("1001", ["v1"]), order("1002", ["v2"])];
    state.skus = { v1: "SKU1", v2: "SKU2" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
    };
    state.returns = [amphoraReturn("1001", ["SKU1"]), amphoraReturn("1002", ["SKU2"])];
    state.settleThrowsOn = "v1";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toEqual(["v2"]);
    expect(alerts.join(" ")).toContain("AUTO-APPROVE");
    expect(body.settled).toBe(1);
  });

  it("says money may have moved only when a payout was actually attempted", async () => {
    state.settleThrowsOn = "v1";

    await call({ authorization: "Bearer s3cret" });

    expect(alerts[0]).toContain("AUTO-APPROVE FAILED");
    expect(alertBodies[0]).toContain("Money may have moved partially");
  });

  it("does not claim money moved when the throw came before any payout", async () => {
    // A malformed Amphora payload makes the verdict itself throw — strictly
    // before `settleReturnLine` is ever entered. Alerting "money may have
    // moved" here sends whoever is on call chasing a refund that never
    // happened; this repo has already done that once.
    state.returns = [amphoraReturn("1001", [], { items: {} })];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(settled).toHaveLength(0);
    expect(body.held).toContainEqual({ order: "#1001", reason: "threw" });
    expect(alerts[0]).toContain("AUTO-APPROVE HELD");
    expect(alertBodies[0]).toContain("NO MONEY MOVED");
    expect(alertBodies[0]).not.toContain("Money may have moved");
  });
});
