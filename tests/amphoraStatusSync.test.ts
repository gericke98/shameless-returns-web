import { beforeEach, describe, expect, it, vi } from "vitest";

// `applyReturnStatus` is the shared apply-step behind BOTH the webhook (push)
// and the sync cron (pull). Amphora never registered the webhook, so the cron
// polls every 15 minutes — which makes the no-double-email guarantee
// load-bearing in a way it was not when only a retried webhook could trigger it.
// A poll that re-sent "your collection is scheduled" every quarter of an hour
// would be worse than the silence it was built to fix.
//
// The drizzle mock APPLIES the writes back onto the order, so a second call
// sees genuinely persisted state instead of state hand-fed by the test.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const order: any = {
  id: "13192219558214",
  orderNumber: "#310957",
  email: "josephine@example.com",
  shippingName: "Josephine Denz",
  locale: "en",
  locator: null,
  carrier: null,
  returnStatus: null,
  products: [{ action: "DEVOLUCIÓN", title: "ARCHIVE CLOUD CREWNECK" }],
};

const emails: any[] = [];
const alerts: { subject: string; body: string }[] = [];
let postFails = false;

// Mocked so an ops alert cannot be miscounted as a customer email — alertOps
// posts to the same Postmark endpoint the axios mock below is capturing.
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/db/drizzle", () => {
  let pending: Record<string, unknown> = {};
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, unknown>) => {
      pending = values;
      return chain;
    },
    where: () => {
      Object.assign(order, pending);
      pending = {};
      return Promise.resolve();
    },
  };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (_url: string, body: any) => {
      if (postFails) return { status: 500 };
      emails.push(body);
      return { status: 200 };
    },
  },
}));

async function apply(payload: Record<string, unknown>) {
  const { applyReturnStatus } = await import("@/actions/amphoraStatusSync");
  return applyReturnStatus(order, payload as any);
}

const CARRIER_ASSIGNED = {
  id: "SHP 13192219558214",
  name: "#310957",
  internal_status: "APROVED",
  carrier: "DHP",
  carrier_number: "JJD0002686502965399",
  carrier_url: "https://track.example/JJD0002686502965399",
};

beforeEach(() => {
  Object.assign(order, {
    locator: null,
    carrier: null,
    returnStatus: null,
    lastTrackingKey: null,
    lastTrackingLocator: null,
  });
  emails.length = 0;
  alerts.length = 0;
  postFails = false;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("applyReturnStatus — the poll must not re-notify", () => {
  it("emails the customer the first time a carrier appears", async () => {
    const outcome = await apply(CARRIER_ASSIGNED);

    expect(outcome.changed).toBe(true);
    expect(outcome.emailsSent).toEqual(["collectionScheduled"]);
    expect(emails).toHaveLength(1);
    expect(emails[0].To).toBe("josephine@example.com");
    expect(emails[0].Subject).toBe("Your collection is scheduled");
    // The tracking number has to reach the customer — an email that says a
    // collection is scheduled without saying how to track it is why they write in.
    expect(emails[0].HtmlBody).toContain("JJD0002686502965399");
  });

  it("persists the carrier and tracking onto the order", async () => {
    await apply(CARRIER_ASSIGNED);

    expect(order.returnStatus).toBe("APROVED");
    expect(order.carrier).toBe("DHP");
    expect(order.locator).toBe("JJD0002686502965399");
  });

  it("does nothing on the next poll, and the one after that", async () => {
    await apply(CARRIER_ASSIGNED);
    emails.length = 0;

    const second = await apply(CARRIER_ASSIGNED);
    const third = await apply(CARRIER_ASSIGNED);

    expect(second.changed).toBe(false);
    expect(third.changed).toBe(false);
    expect(emails).toHaveLength(0);
  });

  it("does not re-send when the webhook got there first", async () => {
    // Exactly what happens if Amphora ever enables the webhook: it lands, then
    // the cron polls the same transition 15 minutes later.
    order.returnStatus = "APROVED";
    order.locator = "JJD0002686502965399";

    const outcome = await apply(CARRIER_ASSIGNED);

    expect(outcome.changed).toBe(false);
    expect(emails).toHaveLength(0);
  });

  it("still reports the arrival at the warehouse later in the lifecycle", async () => {
    await apply(CARRIER_ASSIGNED);
    emails.length = 0;

    const outcome = await apply({ ...CARRIER_ASSIGNED, internal_status: "RECEIVED" });

    expect(outcome.changed).toBe(true);
    expect(outcome.emailsSent).toEqual(["returnReceived"]);
    expect(emails[0].Subject).toBe("We've received your return");
  });

  it("never wipes tracking we already hold when a later event omits it", async () => {
    await apply(CARRIER_ASSIGNED);

    await apply({
      id: "SHP 13192219558214",
      name: "#310957",
      internal_status: "TRAVELLING",
      carrier: null,
      carrier_number: null,
      carrier_url: null,
    });

    expect(order.locator).toBe("JJD0002686502965399");
    expect(order.carrier).toBe("DHP");
    expect(order.returnStatus).toBe("TRAVELLING");
  });

  it("keeps the status persisted when the email fails, so it is not retried forever", async () => {
    postFails = true;

    const outcome = await apply(CARRIER_ASSIGNED);

    expect(outcome.changed).toBe(true);
    expect(outcome.emailsFailed).toEqual(["collectionScheduled"]);
    // Persisted anyway: the alternative is re-attempting on every poll and
    // eventually sending a burst once Postmark recovers.
    expect(order.returnStatus).toBe("APROVED");
    expect((await apply(CARRIER_ASSIGNED)).changed).toBe(false);
  });

  it("announces a customs hold once, and not again when it clears", async () => {
    // TRAVELLING -> EXCEPTION_HOLD -> TRAVELLING is an ordinary customs hold,
    // every leg of it is a status CHANGE, and this runs every 15 minutes. The
    // old dedupe was "the status differs from the stored one", which bounded
    // nothing: the parcel would email its customer "on its way" and "there is
    // a problem" alternately for as long as the hold lasted.
    //
    // Driven through the real apply step, so the state each call reads is the
    // state the previous one persisted.
    await apply(CARRIER_ASSIGNED);
    emails.length = 0;
    alerts.length = 0;

    const travelling = { ...CARRIER_ASSIGNED, internal_status: "TRAVELLING" };
    const held = { ...CARRIER_ASSIGNED, internal_status: "EXCEPTION_HOLD" };

    expect((await apply(travelling)).emailsSent).toEqual(["trackingInTransit"]);
    expect((await apply(held)).emailsSent).toEqual(["trackingProblem"]);
    expect((await apply(travelling)).emailsSent).toEqual([]);
    expect((await apply(held)).emailsSent).toEqual([]);

    expect(emails).toHaveLength(2);
    // The status still tracks reality even when nobody is told about it.
    expect(order.returnStatus).toBe("EXCEPTION_HOLD");
  });

  it("tells ops about an incident, not just the customer", async () => {
    // Vercel keeps runtime logs for about an hour, and this used to be a
    // `console.error` covering two of the four exception statuses. #310664 sat
    // stranded for three weeks while exactly that line repeated unread.
    await apply(CARRIER_ASSIGNED);
    alerts.length = 0;

    await apply({ ...CARRIER_ASSIGNED, internal_status: "EXCEPTION_WAREHOUSE" });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("#310957");
    expect(alerts[0].body).toContain("EXCEPTION_WAREHOUSE");
    expect(alerts[0].body).toContain("JJD0002686502965399");
  });

  it("covers the exception shapes the old log line ignored", async () => {
    // FINISHED_REJECTED and EXCEPTION_HOLD were never logged at all.
    for (const status of ["EXCEPTION", "EXCEPTION_HOLD", "FINISHED_REJECTED"]) {
      Object.assign(order, {
        locator: "JJD0002686502965399",
        returnStatus: "TRAVELLING",
        lastTrackingKey: "in_transit",
        lastTrackingLocator: "JJD0002686502965399",
      });
      alerts.length = 0;

      await apply({ ...CARRIER_ASSIGNED, internal_status: status });

      expect(alerts, status).toHaveLength(1);
      expect(alerts[0].body, status).toContain(status);
    }
  });

  it("does not alert ops for an incident it stayed quiet about", async () => {
    // Ops hearing about a hold on every 15-minute poll is how the real alerts
    // get buried. One incident, one alert.
    Object.assign(order, {
      locator: "JJD0002686502965399",
      returnStatus: "EXCEPTION",
      lastTrackingKey: "problem",
      lastTrackingLocator: "JJD0002686502965399",
    });

    await apply({ ...CARRIER_ASSIGNED, internal_status: "EXCEPTION_HOLD" });

    expect(alerts).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it("records the status but sends nothing when we already hold the tracking", async () => {
    // The seven international orders backfilled by hand on 2026-08-05: Amphora
    // already emailed the customer the label directly, so when the cron sees
    // these orders for the first time it must record the status without
    // re-notifying. `locator` being pre-set (not null, like the fixture above)
    // is exactly what disarms the collectionScheduled guard at
    // lib/amphoraWebhook.ts:74.
    const { applyReturnStatus } = await import("@/actions/amphoraStatusSync");
    const backfilled: any = {
      id: "13161916465478",
      orderNumber: "#310761",
      email: "ruminc01@icloud.com",
      shippingName: "Ivan Forastiero",
      returnStatus: null,
      locator: "1Z3EF3229111791266",
    };

    const outcome = await applyReturnStatus(backfilled, {
      id: "SHP 13161916465478",
      name: "#310761",
      internal_status: "APROVED",
      carrier: "UPS",
      carrier_number: "1Z3EF3229111791266",
      carrier_url: "https://www.ups.com/track?tracknum=1Z3EF3229111791266",
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.emailsSent).toEqual([]);
  });
});
