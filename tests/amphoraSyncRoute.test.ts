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

const state: {
  returns: any[];
  listThrows: boolean;
  dbThrows: boolean;
  failIds: string[];
  sweepThrows: boolean;
} = {
  returns: [OURS, RECREATED, THEIRS, UNKNOWN],
  listThrows: false,
  dbThrows: false,
  failIds: [],
  sweepThrows: false,
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

// `dbThrows` reproduces 2026-09-03: PR #38 deployed with its migration
// unapplied, so EVERY `orders` read raised `column orders.delivery_name does
// not exist` — thrown by the very first statement in the loop's try, which is
// why nothing ever reached `acted` and the counters all stayed at zero.
function failIfDbDown(id?: string) {
  if (state.dbThrows) {
    throw new Error('column orders.delivery_name does not exist');
  }
  // A single genuinely broken row, to prove the alert needs TOTAL failure.
  if (id && state.failIds.includes(id)) {
    throw new Error(`boom for ${id}`);
  }
}

vi.mock("@/db/queries", () => ({
  getOrderById: async (id: string) => { failIfDbDown(id); return ORDERS[id]; },
  getOrderByIdFresh: async (id: string) => { failIfDbDown(id); return ORDERS[id]; },
  getOrderByNumberFresh: async (name: string) => {
    failIfDbDown();
    return Object.values(ORDERS).find((o: any) => o.orderNumber === name);
  },
  getOrderByNumber: async (name: string) => {
    failIfDbDown();
    return Object.values(ORDERS).find((o: any) => o.orderNumber === name);
  },
}));

// The sweep is exercised on its own in tests/selfReturnSweep.test.ts. Here it
// only needs to not pull in the real db connection, since this file mocks
// none of `@/db/drizzle`.
vi.mock("@/actions/selfReturnSweep", () => ({
  sweepSelfReturns: async () => {
    if (state.sweepThrows) throw new Error('column "delivery_name" does not exist');
    return { reminded: 0, alerted: 0 };
  },
}));

const alerts: Array<{ subject: string; body: string }> = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/cron/amphora-sync/route");
  return GET(new Request("https://x.test/api/cron/amphora-sync", { headers }));
}

beforeEach(() => {
  applied.length = 0;
  alerts.length = 0;
  state.returns = [OURS, RECREATED, THEIRS, UNKNOWN];
  state.listThrows = false;
  state.dbThrows = false;
  state.failIds = [];
  state.sweepThrows = false;
  ORDERS["13150000000000"].products = [{ id: "p5", confirmed: false }];
  // The lane is per-test; anything but SELF behaves as it did before
  // self-booking existed.
  delete ORDERS["13192219558214"].returnMethod;
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

  it("does not call a pending self-booked return stranded", async () => {
    // A SELF international ticket sits at PENDING with no carrier for up to ten
    // days BY DESIGN: there is no collection to book, and the carrier is not
    // known until the customer has been to the post office and told us. Without
    // the exclusion it matches on every pass, so the warning the team added to
    // catch genuinely stranded collections fires every 15 minutes about a
    // return that is behaving exactly as intended — and an alarm that is always
    // on is an alarm nobody reads.
    ORDERS["13192219558214"].returnMethod = "SELF";
    state.returns = [
      { ...OURS, internal_status: "PENDING", carrier: null, carrier_number: null },
    ];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    // Still acted on — the status is synced as usual. Only the alarm is silent.
    expect(body.scanned).toBe(1);
    expect(body.stranded).toBe(0);
  });

  it("still reports a carrier-less collection we DID book as stranded", async () => {
    // The control half: same fixture, same missing carrier, only the lane
    // differs — so the two together prove the exclusion is scoped to SELF
    // rather than switching the alarm off for everyone.
    ORDERS["13192219558214"].returnMethod = "AMPHORA";
    state.returns = [
      { ...OURS, internal_status: "PENDING", carrier: null, carrier_number: null },
    ];

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.stranded).toBe(1);
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

// 2026-09-03: PR #38 shipped with `drizzle/0002_delivery_address.sql` unapplied,
// so every `orders` read threw and this sync accomplished NOTHING for ~15 hours
// — roughly 60 consecutive runs, ~40 orders failing in each. It went unnoticed
// because this is the one money-path cron that never called `alertOps`:
// `auto-approve` and `tracking-sync` both do. Vercel drops runtime logs after
// about an hour, so by the time anyone asked, the only evidence of a 15-hour
// outage would have been gone.
//
// The per-return catch is deliberately forgiving — one bad return must not stop
// the sweep — but "every single one failed" is not a bad return, it is a broken
// sync, and it has to reach a human.
describe("amphora-sync cron — total failure is not silent", () => {
  it("emails ops when every return attempted failed", async () => {
    state.dbThrows = true;

    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();

    // The run still returns 200 with zeroed counters — which is exactly why a
    // log line was never enough to notice it.
    expect(res.status).toBe(200);
    expect(body.scanned).toBe(0);
    expect(body.changed).toEqual([]);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("AMPHORA SYNC FAILING");
    // Name the cause, so whoever is on call does not have to reproduce it.
    expect(alerts[0].body).toContain("delivery_name");
    expect(alerts[0].body).toContain("4");
  });

  it("stays quiet on a normal run, so the alert keeps meaning something", async () => {
    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(alerts).toHaveLength(0);
  });

  it("stays quiet when only SOME returns fail — one bad row is not an outage", async () => {
    // A forgiving per-return catch is the documented behaviour: one bad return
    // must not stop the sweep, and must not page anyone either.
    state.failIds = ["13192219558214"];

    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(alerts).toHaveLength(0);
  });
});

// The sweep is the other half of this cron, and on 2026-09-03 it failed on
// every single run alongside the poll — `[amphora-sync] self-return sweep
// failed: column "delivery_name" does not exist` — with nothing but a
// console.error to show for it. A healthy poll with a broken sweep is the case
// the total-failure alert above cannot see at all.
describe("amphora-sync cron — the self-return sweep is not silent either", () => {
  it("emails ops when the sweep throws, even though the poll succeeded", async () => {
    state.sweepThrows = true;

    const res = await call({ authorization: "Bearer s3cret" });
    const body = await res.json();

    // The poll's own results must survive a sweep failure — that is why the
    // sweep is wrapped separately — so this still reports a normal run.
    expect(res.status).toBe(200);
    expect(body.scanned).toBe(2);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("SELF-RETURN SWEEP FAILED");
    expect(alerts[0].body).toContain("delivery_name");
  });

  it("does not alert about the sweep when it succeeds", async () => {
    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(alerts).toHaveLength(0);
  });
});

// The floor was set to 3 so a single bad row could not page every 15 minutes.
// But "every return we touched failed" is already the systemic signal — a quiet
// window with two international returns, both failing, is still a sync that did
// nothing, and staying silent there is the exact gap that cost 15 hours.
describe("amphora-sync cron — total failure alerts regardless of volume", () => {
  it("alerts when both of only two returns fail", async () => {
    state.returns = [OURS, RECREATED];
    state.dbThrows = true;

    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("AMPHORA SYNC FAILING");
    expect(alerts[0].subject).toContain("2/2");
  });
});
