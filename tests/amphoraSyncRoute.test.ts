import { beforeEach, describe, expect, it, vi } from "vitest";

// The sync cron writes to orders and sends customer email, and it is a PUBLIC
// route (middleware.ts matches only /dashboard and /login). `CRON_SECRET` is
// the only thing in front of it, so an unset secret must close the route rather
// than open it — the same fail-closed rule as the Amphora webhook.
//
// It must also act ONLY on returns we created. Amphora's own Shopify-channel
// returns share the tenant and carry `external_id: null`; touching those would
// mean emailing customers about returns that are not ours to manage.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const OURS = {
  id: "SHP 13192219558214",
  name: "#310957",
  external_id: "13192219558214",
  internal_status: "APROVED",
  carrier: "DHP",
  carrier_number: "JJD001",
  carrier_url: "https://track.example/JJD001",
};

const THEIRS = {
  id: "SHP 13181092561222",
  name: "#310889",
  external_id: null,
  internal_status: "RECEIVED",
  carrier: "GLS",
  carrier_number: "410012086538530013",
  carrier_url: null,
};

const state: { returns: any[]; listThrows: boolean } = {
  returns: [OURS, THEIRS],
  listThrows: false,
};
const applied: any[] = [];

vi.mock("@/actions/amphora", () => ({
  getAmphoraReturns: async () => {
    if (state.listThrows) throw new Error("amphora down");
    return state.returns;
  },
}));

vi.mock("@/actions/amphoraStatusSync", () => ({
  applyReturnStatus: async (order: any, payload: any) => {
    applied.push({ order: order.orderNumber, name: payload.name });
    return { changed: true, status: payload.internal_status, emailsSent: [], emailsFailed: [] };
  },
}));

vi.mock("@/db/queries", () => ({
  getOrderById: async (id: string) => ({ id, orderNumber: "#310957" }),
  getOrderByNumber: async (name: string) => ({ id: "x", orderNumber: name }),
}));

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/cron/amphora-sync/route");
  return GET(new Request("https://x.test/api/cron/amphora-sync", { headers }));
}

beforeEach(() => {
  applied.length = 0;
  state.returns = [OURS, THEIRS];
  state.listThrows = false;
  process.env.CRON_SECRET = "s3cret";
});

describe("amphora-sync cron — authorisation", () => {
  it("401s when no secret is configured, rather than running open", async () => {
    delete process.env.CRON_SECRET;

    const res = await call({ authorization: "Bearer anything" });

    expect(res.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("401s on a wrong bearer", async () => {
    const res = await call({ authorization: "Bearer wrong" });

    expect(res.status).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("401s when the header is missing entirely", async () => {
    const res = await call();

    expect(res.status).toBe(401);
    expect(applied).toHaveLength(0);
  });
});

describe("amphora-sync cron — scope and resilience", () => {
  it("acts only on returns we created, never on Amphora's own", async () => {
    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(applied).toEqual([{ order: "#310957", name: "#310957" }]);
    expect(body.scanned).toBe(1);
  });

  it("reports stranded returns — approved with no carrier is the live defect", async () => {
    state.returns = [{ ...OURS, carrier: null, carrier_number: null }];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.stranded).toBe(1);
  });

  it("502s rather than half-running when Amphora is unreachable", async () => {
    state.listThrows = true;

    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(502);
    expect(applied).toHaveLength(0);
  });
});
