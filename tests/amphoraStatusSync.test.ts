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
let postFails = false;

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
  });
  emails.length = 0;
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
});
