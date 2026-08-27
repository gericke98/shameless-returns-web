import { beforeEach, describe, expect, it, vi } from "vitest";

// This route emails customers unattended. It is PUBLIC — middleware.ts matches
// only /dashboard and /login — so CRON_SECRET is the only thing in front of it,
// and an unset secret must close it rather than open it.
//
// It must also be DRY by default: an operator who deploys without setting
// TRACKING_EMAILS_ENABLED gets a report, not a burst of mail to 82 customers.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
// A bare `{}` here would make `db.update(...)` throw on every non-dry path,
// and the per-parcel catch would swallow it — every "it emailed" test would
// pass vacuously by never reaching the send. The chain records what was
// written so the tests can assert the state actually persisted.
let pendingSet: any = null;
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: any) => { pendingSet = values; return chain; },
    where: () => { persisted.push({ ...pendingSet }); events.push("persist"); return Promise.resolve(); },
  };
  return { default: chain };
});

const state = {
  orders: [] as any[],
  status: {} as Record<string, { label: string; phase: string }>,
  lookupThrowsOn: null as string | null,
};
const sent: Array<{ to: string; subject: string }> = [];
const persisted: Array<Record<string, any>> = [];
const alerts: string[] = [];
const events: string[] = [];

vi.mock("@/db/queries", () => ({
  getParcelsAwaitingTracking: async () => state.orders,
}));
vi.mock("@/actions/shipping", () => ({
  obtainLastStatus: async (loc: string) => {
    if (state.lookupThrowsOn === loc) throw new Error("correos down");
    return state.status[loc] ?? { label: "Sin información", phase: "sin_informacion" };
  },
}));
vi.mock("@/lib/emails", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    buildTrackingUpdateEmail: (key: string) => ({
      From: "f@x", To: "", Subject: `SUBJ:${key}`, TextBody: "t", HtmlBody: "h",
    }),
  };
});
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => { alerts.push(subject); },
}));

// The route persists through drizzle and sends through Postmark; both are
// captured so the tests assert on real effects rather than on mock shape.
vi.mock("axios", () => ({
  default: {
    post: async (_url: string, payload: any) => {
      sent.push({ to: payload.To, subject: payload.Subject });
      events.push("send");
      return { status: 200 };
    },
  },
}));

function order(id: string, locator: string, over: any = {}) {
  return {
    id, orderNumber: `#${id}`, email: `c${id}@example.com`, shippingName: `Cust ${id}`,
    shippingCountry: "Spain", locale: "es", locator,
    lastTrackingKey: null, lastTrackingLocator: null,
    products: [{ id: `p${id}`, confirmed: true, refunded: false }],
    ...over,
  };
}

async function call(headers: Record<string, string> = {}, query = "") {
  const { GET } = await import("@/app/api/cron/tracking-sync/route");
  return GET(new Request(`https://x.test/api/cron/tracking-sync${query}`, { headers }));
}

beforeEach(() => {
  sent.length = 0; persisted.length = 0; alerts.length = 0; events.length = 0;
  state.orders = [order("1001", "PQ1")];
  state.status = { PQ1: { label: "Admitido", phase: "admitido" } };
  state.lookupThrowsOn = null;
  process.env.CRON_SECRET = "s3cret";
  process.env.TRACKING_EMAILS_ENABLED = "true";
  process.env.POSTMARK_SERVER_TOKEN = "tok";
  delete process.env.TRACKING_MAX_EMAILS_PER_RUN;
});

describe("tracking-sync cron — authorisation", () => {
  it("401s when no secret is configured, rather than running open", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ authorization: "Bearer anything" });
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("401s on a wrong bearer", async () => {
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("401s when the header is missing entirely", async () => {
    expect((await call()).status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe("tracking-sync cron — notifying", () => {
  it("emails the customer when a parcel reaches a new milestone", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toEqual([{ to: "c1001@example.com", subject: "SUBJ:accepted" }]);
    expect(body.notified).toBe(1);
  });

  it("records the milestone BEFORE sending, so a retry cannot double-send", async () => {
    await call({ authorization: "Bearer s3cret" });

    expect(persisted).toEqual([
      { lastTrackingKey: "accepted", lastTrackingLocator: "PQ1" },
    ]);
    // The ordering itself, not just the values: an implementation that sent
    // first and persisted second would pass the assertion above unchanged.
    expect(events).toEqual(["persist", "send"]);
  });

  it("says nothing about a parcel Correos cannot trace", async () => {
    state.status = { PQ1: { label: "Sin información", phase: "sin_informacion" } };
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(0);
    expect(body.notified).toBe(0);
  });

  it("does not repeat a milestone already sent", async () => {
    state.orders = [order("1001", "PQ1", { lastTrackingKey: "accepted", lastTrackingLocator: "PQ1" })];
    await call({ authorization: "Bearer s3cret" });
    expect(sent).toHaveLength(0);
  });

  it("skips international parcels — those ride on amphora-sync", async () => {
    state.orders = [order("1001", "PQ1", { shippingCountry: "France" })];
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(0);
    expect(body.skipped).toBeGreaterThan(0);
  });

  it("never asks Correos about a parcel that is not travelling with Correos", async () => {
    // `orders.locator` is overloaded: a SELF return stores the customer's own
    // SEUR/MRW/GLS reference there. The localizador answers "no traceability"
    // for one of those — indistinguishable from a parcel Correos has lost.
    state.orders = [
      order("1001", "PQ1", { carrier: "SEUR" }),
      order("1002", "PQ2", { carrier: "GLS" }),
      order("1003", "PQ3", { carrier: "CORREOS EXPRESS" }),
    ];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
      PQ3: { label: "Admitido", phase: "admitido" },
    };
    // A lookup for any of them is the failure: the mock throws so a regression
    // cannot pass quietly by simply deciding not to notify.
    state.lookupThrowsOn = "PQ1";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(sent).toHaveLength(0);
    expect(body.skipped).toBe(3);
    expect(body.scanned).toBe(0);
  });

  it("still sweeps a parcel Amphora subcontracted to Correos", async () => {
    // The control. Amphora sets carrier "correos" for some destinations, and a
    // null carrier is our own domestic label — both must still be looked up.
    state.orders = [order("1001", "PQ1", { carrier: "Correos" }), order("1002", "PQ2")];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
    };

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.scanned).toBe(2);
    expect(sent).toHaveLength(2);
  });

  // REMOVED 2026-08-27: "alerts ops as well as the customer on a problem".
  //
  // It hand-fed `phase: "incidencia"` through the mocked Correos lookup, and
  // no Correos wording produces that phase — `lib/trackingStatus.ts` has no
  // pattern for it, so `parseCorreosTracking` can never return it. The test was
  // green and proved nothing except that the mock did what the test told it to.
  // The branch it "covered" is gone with it; `problem` is international-only
  // today (see the route's header comment and tests/trackingStatus.test.ts).
});

describe("tracking-sync cron — throttles", () => {
  it("is DRY when TRACKING_EMAILS_ENABLED is unset — a deploy alone mails nobody", async () => {
    delete process.env.TRACKING_EMAILS_ENABLED;
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(0);
    expect(body.dry).toBe(true);
    expect(body.notified).toBe(1); // reports what it WOULD have sent
  });

  it("is DRY on ?dry=1 even when enabled", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" }, "?dry=1")).json();
    expect(sent).toHaveLength(0);
    expect(body.dry).toBe(true);
  });

  it("treats any ?dry= value as a preview, not just \"1\"", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" }, "?dry=true")).json();

    expect(body.dry).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("refuses to run rather than burn milestones with no Postmark token", async () => {
    // sendEmail returns 500 without trying when the token is absent, so a run
    // would persist every milestone and mail nobody.
    delete process.env.POSTMARK_SERVER_TOKEN;

    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(503);
    expect(persisted).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("does not apply the cap to a dry run, but still reports it", async () => {
    // A preview that stops at the cap cannot show the operator the full blast
    // radius, which is the only thing the preview is for. `capped` still
    // reports true, because the live run WOULD have stopped there.
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2"), order("1003", "PQ3")];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
      PQ3: { label: "Admitido", phase: "admitido" },
    };
    process.env.TRACKING_MAX_EMAILS_PER_RUN = "2";

    const body = await (await call({ authorization: "Bearer s3cret" }, "?dry=1")).json();

    expect(body.notified).toBe(3);
    expect(body.remaining).toBe(0);
    expect(body.capped).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("stops at the per-run email cap", async () => {
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2"), order("1003", "PQ3")];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
      PQ3: { label: "Admitido", phase: "admitido" },
    };
    process.env.TRACKING_MAX_EMAILS_PER_RUN = "2";
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toHaveLength(2);
    expect(body.capped).toBe(true);
  });
});

describe("tracking-sync cron — reporting a run honestly", () => {
  it("distinguishes a truncated run from a quiet one", async () => {
    // `scanned: 82, notified: 0` used to mean both "nothing happened this hour"
    // and "we never got past parcel 40" — and the sweep is oldest-first, so the
    // parcels it drops are the same ones every hour, forever.
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2"), order("1003", "PQ3")];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
      PQ3: { label: "Admitido", phase: "admitido" },
    };
    process.env.TRACKING_MAX_EMAILS_PER_RUN = "2";

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.total).toBe(3);
    expect(body.remaining).toBe(1);
    expect(body.capped).toBe(true);
    expect(alerts.join(" ")).toContain("TRACKING SWEEP TRUNCATED");
  });

  it("does not cry truncation on a run that finished", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.total).toBe(1);
    expect(body.remaining).toBe(0);
    expect(alerts).toHaveLength(0);
  });

  it("counts a parcel Correos cannot trace as a failed lookup", async () => {
    state.status = { PQ1: { label: "Sin información", phase: "sin_informacion" } };

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.lookupFailures).toBe(1);
    expect(body.notified).toBe(0);
  });

  it("alerts ops when more than half the lookups come back empty", async () => {
    // `obtainLastStatus` swallows its own network errors and answers
    // "unknown", so a Correos outage is invisible unless it is counted.
    state.orders = Array.from({ length: 12 }, (_, i) =>
      order(String(1001 + i), `PQ${i}`)
    );
    state.status = { PQ11: { label: "Admitido", phase: "admitido" } };

    await call({ authorization: "Bearer s3cret" });

    expect(alerts.join(" ")).toContain("TRACKING LOOKUPS FAILING");
  });

  it("does not call a quiet hour an outage", async () => {
    // A ratio needs a sample. Two parcels registered this morning and not yet
    // scanned by Correos are BOTH legitimately `sin_informacion` — 2 of 2, an
    // infinitely worse ratio than the ~20% baseline that made this alert's
    // threshold half — and would have paged ops hourly about a working system.
    // The threshold is the shape of an outage; the floor is what makes it
    // evidence.
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2")];
    state.status = {};

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(body.lookupFailures).toBe(2);
    expect(alerts.join(" ")).not.toContain("TRACKING LOOKUPS FAILING");
  });

  it("stays quiet about lookups while the job is still dry", async () => {
    // The route spends most of its life dry by design and runs hourly, so an
    // alert from a dry run is an hourly ops email about a job deliberately
    // doing nothing. The counters in the body report the same facts.
    delete process.env.TRACKING_EMAILS_ENABLED;
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2"), order("1003", "PQ3")];
    state.status = { PQ3: { label: "Admitido", phase: "admitido" } };

    const body = await (await call({ authorization: "Bearer s3cret" })).json();

    expect(alerts).toHaveLength(0);
    expect(body.lookupFailures).toBe(2);
  });
});

describe("tracking-sync cron — seeding", () => {
  it("records the current milestone without emailing anyone", async () => {
    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=1")).json();

    expect(sent).toHaveLength(0);
    expect(persisted).toEqual([
      { lastTrackingKey: "accepted", lastTrackingLocator: "PQ1" },
    ]);
    expect(body.seeded).toBe(1);
    expect(body.notified).toBe(0);
  });

  it("seeds even when the job is not enabled — that is the point", async () => {
    delete process.env.TRACKING_EMAILS_ENABLED;

    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=1")).json();

    expect(persisted).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(body.seeded).toBe(1);
  });

  it("seeds without a Postmark token, since it sends nothing", async () => {
    delete process.env.POSTMARK_SERVER_TOKEN;

    const res = await call({ authorization: "Bearer s3cret" }, "?seed=1");

    expect(res.status).toBe(200);
    expect((await res.json()).seeded).toBe(1);
  });

  it("still requires the cron secret", async () => {
    const res = await call({ authorization: "Bearer wrong" }, "?seed=1");

    expect(res.status).toBe(401);
    expect(persisted).toHaveLength(0);
  });

  it("treats any ?seed= value as a seed, not just \"1\"", async () => {
    // `?seed=true` used to perform a NORMAL run — a live email burst once the
    // job is enabled. A dangerous flag must not fail open into the dangerous
    // direction; `?dry=` has always parsed this way.
    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=true")).json();

    expect(body.seeded).toBe(1);
    expect(body.notified).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("still runs normally on ?seed=0 and ?seed=false", async () => {
    for (const value of ["0", "false"]) {
      sent.length = 0;
      const body = await (
        await call({ authorization: "Bearer s3cret" }, `?seed=${value}`)
      ).json();
      expect(body.seeded, value).toBe(0);
      expect(body.notified, value).toBe(1);
    }
  });

  it("reports the mode honestly rather than claiming to be dry", async () => {
    // Seeding WRITES. An operator reading `dry: true` on a run that persisted
    // 40 rows would conclude the opposite of what happened.
    delete process.env.TRACKING_EMAILS_ENABLED;

    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=1")).json();

    expect(body.mode).toBe("seed");
    expect(body.dry).toBe(false);
    expect(persisted).toHaveLength(1);
  });

  it("leaves an already-delivered parcel unseeded, so it still gets told", async () => {
    // The backlog this whole feature exists for: ~36 parcels sitting delivered
    // whose customers were never told. Seeding `received` for them is how the
    // runbook would silently suppress the exact people it was built to reach.
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2")];
    state.status = {
      PQ1: { label: "Entregado", phase: "entregado" },
      PQ2: { label: "Admitido", phase: "admitido" },
    };

    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=1")).json();

    expect(body.seeded).toBe(1);
    expect(persisted).toEqual([
      { lastTrackingKey: "accepted", lastTrackingLocator: "PQ2" },
    ]);
  });

  it("seeds an in-transit parcel — that one is not owed a notice yet", async () => {
    state.status = { PQ1: { label: "En tránsito", phase: "en_transito" } };

    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=1")).json();

    expect(body.seeded).toBe(1);
    expect(persisted).toEqual([
      { lastTrackingKey: "in_transit", lastTrackingLocator: "PQ1" },
    ]);
  });

  it("seeds every parcel even when the cap is smaller than the backlog", async () => {
    // A HALF-seeded database is worse than an unseeded one: the parcels it
    // missed still get stale news on the first live run, and nothing records
    // which ones they were. The cap counts emails, and seeding sends none —
    // this pins that the two never became entangled.
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2"), order("1003", "PQ3")];
    state.status = {
      PQ1: { label: "Admitido", phase: "admitido" },
      PQ2: { label: "Admitido", phase: "admitido" },
      PQ3: { label: "Admitido", phase: "admitido" },
    };
    process.env.TRACKING_MAX_EMAILS_PER_RUN = "1";

    const body = await (await call({ authorization: "Bearer s3cret" }, "?seed=1")).json();

    expect(body.seeded).toBe(3);
    expect(persisted).toHaveLength(3);
    expect(body.capped).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("tracking-sync cron — resilience", () => {
  it("keeps going after one parcel's lookup throws", async () => {
    state.orders = [order("1001", "PQ1"), order("1002", "PQ2")];
    state.status = { PQ2: { label: "Admitido", phase: "admitido" } };
    state.lookupThrowsOn = "PQ1";
    const body = await (await call({ authorization: "Bearer s3cret" })).json();
    expect(sent).toEqual([{ to: "c1002@example.com", subject: "SUBJ:accepted" }]);
    expect(body.notified).toBe(1);
  });
});
