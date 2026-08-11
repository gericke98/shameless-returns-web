import { beforeEach, describe, expect, it, vi } from "vitest";

// The sync cron writes to orders and sends customer email, and it is a PUBLIC
// route (middleware.ts matches only /dashboard and /login). `CRON_SECRET` is
// the only thing in front of it, so an unset secret must close the route rather
// than open it — the same fail-closed rule as the Amphora webhook.
//
// It must also act ONLY on returns that are ours to manage. Amphora's own
// Shopify-channel returns and their warehouse-arrival records share the tenant
// and carry `external_id: null`; touching those means emailing customers about
// returns we never handled. Ownership is three things, not one: the order is in
// our table, it is international, and — for anything without an `external_id` —
// at least one line item is confirmed, which is the only proof a return really
// went through our portal rather than the customer just looking the order up.

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

// An orphan for one of OUR international orders: this is what Amphora leaves
// behind when they re-create a return in their own UI (2026-08-05, all seven).
const RECREATED = {
  id: "SHP 13161916465478",
  name: "#310761",
  external_id: null,
  internal_status: "APROVED",
  carrier: "UPS",
  carrier_number: "1Z3EF3229111791266",
  carrier_url: "https://www.ups.com/track?tracknum=1Z3EF3229111791266",
  time: "2026-08-05T06:25:20",
};

// A domestic return as Amphora records it on ARRIVAL at their warehouse. Same
// shape, but the order is Spanish, so we booked it on Correos and already hold
// a Correos locator. Applying this would overwrite that tracking with the
// carrier that delivered the box (real case: order #310273, ours says Correos
// PQAZXT9800004100128221Y, theirs says CEX).
const THEIRS = {
  id: "SHP 13181092561222",
  name: "#310889",
  external_id: null,
  internal_status: "RECEIVED",
  carrier: "GLS",
  carrier_number: "410012086538530013",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

// An orphan for an order that never went through our portal at all.
const UNKNOWN = {
  id: "SHP 99999999999999",
  name: "#309000",
  external_id: null,
  internal_status: "APROVED",
  carrier: "UPS",
  carrier_number: "1Z000",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

// An orphan for an INTERNATIONAL order that is in our table only because the
// customer once looked the order up in the portal (actions/order.ts saves on
// lookup, before anything is started or paid for). They abandoned it and
// returned through customer service; Amphora opened this record when the parcel
// arrived at the warehouse. Acting on it emails the customer about a return we
// never managed, months late. Real shape: order #310500, France.
const LOOKED_UP_ONLY = {
  id: "SHP 13150000000000",
  name: "#310500",
  external_id: null,
  internal_status: "RECEIVED",
  carrier: "UPS",
  carrier_number: "1Z310500",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

// One of ours, matched by external_id, whose order is Spanish. Cannot happen
// while both call sites gate on isInternationalOrder — but the domestic check
// must not depend on that, because it is the only thing standing between a
// Spanish customer's live Correos tracking and whatever carrier delivered the
// box to Amphora.
const OURS_BUT_SPANISH = {
  id: "SHP 13188888888888",
  name: "#310901",
  external_id: "13188888888888",
  internal_status: "APROVED",
  carrier: "CEX",
  carrier_number: "CEX001",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

// An orphan whose resolved order has an empty shippingCountry — the schema
// declares the column NOT NULL and db/repository.ts writes it straight from
// Shopify, so this should be rare, but isInternationalOrder treats an empty
// string as domestic. This must stay unacted, and must be visible as its own
// count rather than folded into an ordinary domestic reject, since a live
// international return with no country on file would otherwise be silently
// under-matched.
const EMPTY_COUNTRY = {
  id: "SHP 13175555555555",
  name: "#310800",
  external_id: null,
  internal_status: "APROVED",
  carrier: "UPS",
  carrier_number: "1Z555",
  carrier_url: null,
  time: "2026-08-02T09:00:00",
};

// `products` mirrors what getOrderById loads (`with: { products: true }`).
// A confirmed line item is the only proof a return actually went through our
// portal — a bare row means the customer merely looked the order up.
const ORDERS: Record<string, any> = {
  // Deliberately carries NO confirmed line item: it is matched by external_id,
  // so it must still be acted on. That keeps the confirmed-item rule honest
  // about being scoped to orphans.
  "13192219558214": {
    id: "13192219558214",
    orderNumber: "#310957",
    shippingCountry: "Germany",
    products: [{ id: "p1", confirmed: false }],
  },
  "13161916465478": {
    id: "13161916465478",
    orderNumber: "#310761",
    shippingCountry: "Italia",
    products: [{ id: "p2", confirmed: true }],
  },
  "13181092561222": {
    id: "13181092561222",
    orderNumber: "#310889",
    shippingCountry: "Spain",
    products: [{ id: "p3", confirmed: true }],
  },
  "13175555555555": {
    id: "13175555555555",
    orderNumber: "#310800",
    shippingCountry: "",
    products: [{ id: "p4", confirmed: true }],
  },
  // France, portal opened in March and abandoned. `confirmed` is flipped by one
  // test below to prove the rule turns on exactly this field.
  "13150000000000": {
    id: "13150000000000",
    orderNumber: "#310500",
    shippingCountry: "France",
    products: [{ id: "p5", confirmed: false }],
  },
  "13188888888888": {
    id: "13188888888888",
    orderNumber: "#310901",
    shippingCountry: "Spain",
    products: [{ id: "p6", confirmed: true }],
  },
};

const state: { returns: any[]; listThrows: boolean } = {
  returns: [OURS, RECREATED, THEIRS, UNKNOWN],
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
  getOrderById: async (id: string) => ORDERS[id],
  getOrderByIdFresh: async (id: string) => ORDERS[id],
  getOrderByNumberFresh: async (name: string) =>
    Object.values(ORDERS).find((o: any) => o.orderNumber === name),
  getOrderByNumber: async (name: string) =>
    Object.values(ORDERS).find((o: any) => o.orderNumber === name),
}));

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/cron/amphora-sync/route");
  return GET(new Request("https://x.test/api/cron/amphora-sync", { headers }));
}

beforeEach(() => {
  applied.length = 0;
  state.returns = [OURS, RECREATED, THEIRS, UNKNOWN];
  state.listThrows = false;
  ORDERS["13150000000000"].products = [{ id: "p5", confirmed: false }];
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
  it("acts on returns we created AND on the ones Amphora re-created for us", async () => {
    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(applied.map((a) => a.order).sort()).toEqual(["#310761", "#310957"]);
    expect(body.scanned).toBe(2);
  });

  it("never touches an orphan whose order is Spanish — Spain is Correos, so it is theirs", async () => {
    await call({ authorization: "Bearer s3cret" });

    expect(applied.map((a) => a.order)).not.toContain("#310889");
  });

  it("never touches an international order the customer only ever looked up", async () => {
    // The row exists because actions/order.ts saves on a successful lookup, not
    // because a return was ever started. Acting on Amphora's warehouse-arrival
    // record here sends a "collection scheduled" AND a "return received" email
    // months late, for a return we never managed.
    state.returns = [...state.returns, LOOKED_UP_ONLY];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(applied.map((a) => a.order)).not.toContain("#310500");
    expect(body.skippedNoReturn).toBe(1);
  });

  it("acts on that same international orphan once a line item is confirmed", async () => {
    ORDERS["13150000000000"].products = [{ id: "p5", confirmed: true }];
    state.returns = [...state.returns, LOOKED_UP_ONLY];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(applied.map((a) => a.order)).toContain("#310500");
    expect(body.skippedNoReturn).toBe(0);
  });

  it("does not demand a confirmed line item of a return we created ourselves", async () => {
    // #310957 is matched by external_id and its order carries no confirmed
    // product; that is the strongest ownership evidence there is, so it stands.
    await call({ authorization: "Bearer s3cret" });

    expect(applied.map((a) => a.order)).toContain("#310957");
  });

  it("never touches a Spanish order even when we created the return ourselves", async () => {
    // Both call sites gate on isInternationalOrder, so this cannot happen today
    // — which is the point: the domestic guard must not lean on that, because
    // it is all that protects the Correos tracking a Spanish customer is
    // actively watching.
    state.returns = [...state.returns, OURS_BUT_SPANISH];

    await call({ authorization: "Bearer s3cret" });

    expect(applied.map((a) => a.order)).not.toContain("#310901");
  });

  it("never touches an orphan for an order that is not in our database", async () => {
    await call({ authorization: "Bearer s3cret" });

    expect(applied.map((a) => a.order)).not.toContain("#309000");
  });

  it("counts the id matches it rejected, so a wrong rule is visible in the logs", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.skipped).toBe(2);
  });

  it("never touches an orphan with no shippingCountry on file, and counts it apart from a domestic reject", async () => {
    state.returns = [OURS, RECREATED, THEIRS, UNKNOWN, EMPTY_COUNTRY];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(applied.map((a) => a.order)).not.toContain("#310800");
    expect(body.skippedUnknownCountry).toBe(1);
  });

  it("does not count the Spanish orphan as an unknown-country skip", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.skippedUnknownCountry).toBe(0);
  });

  it("reports stranded returns — approved with no carrier is the live defect", async () => {
    // Two carrier-less APROVED returns, only ONE of them ours. If `stranded`
    // were ever computed over all matches instead of the acted-on set, this
    // reads 2. With a single-return fixture the two are indistinguishable and
    // the test cannot fail.
    state.returns = [
      { ...OURS, carrier: null, carrier_number: null },
      {
        ...LOOKED_UP_ONLY,
        internal_status: "APROVED",
        carrier: null,
        carrier_number: null,
      },
    ];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.stranded).toBe(1);
    expect(body.skippedNoReturn).toBe(1);
  });

  it("names the stranded orders in the log, so Vercel shows who is waiting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.returns = [{ ...OURS, carrier: null, carrier_number: null }];

    await call({ authorization: "Bearer s3cret" });

    const line = warn.mock.calls.map(String).find((c) => c.includes("no carrier assigned"));
    expect(line).toContain("#310957");
    warn.mockRestore();
  });

  it("502s rather than half-running when Amphora is unreachable", async () => {
    state.listThrows = true;

    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(502);
    expect(applied).toHaveLength(0);
  });
});
