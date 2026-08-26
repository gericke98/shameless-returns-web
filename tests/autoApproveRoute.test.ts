import { beforeEach, describe, expect, it, vi } from "vitest";

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
};
const settled: string[] = [];
const alerts: string[] = [];

vi.mock("@/actions/amphora", () => ({ getAmphoraReturns: async () => state.returns }));
vi.mock("@/db/queries", () => ({
  getOrdersWithUnsettledReturns: async () => state.orders,
  getReturnStatusesByIds: async () => state.shopifyStatuses,
  getVariantSkusByIds: async () => state.skus,
}));
vi.mock("@/lib/settleReturn", () => ({
  settleReturnLine: async (product: any) => {
    if (state.settleThrowsOn === product.variant_id) throw new Error("shopify down");
    settled.push(product.variant_id);
    return { settled: true, lane: "refund" };
  },
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
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

describe("auto-approve cron — throttles", () => {
  it("stops at the per-run cap and reports the remainder", async () => {
    state.orders = [order("1001", ["v1"]), order("1002", ["v2"]), order("1003", ["v3"])];
    state.skus = { v1: "SKU1", v2: "SKU2", v3: "SKU3" };
    state.shopifyStatuses = {
      "gid://shopify/Return/v1": "OPEN", "gid://shopify/Return/v2": "OPEN",
      "gid://shopify/Return/v3": "OPEN",
    };
    state.returns = [
      amphoraReturn("1001", ["SKU1"]), amphoraReturn("1002", ["SKU2"]), amphoraReturn("1003", ["SKU3"]),
    ];
    process.env.AUTO_APPROVE_MAX_PER_RUN = "2";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(settled).toHaveLength(2);
    expect(body.capped).toBe(true);
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
});
