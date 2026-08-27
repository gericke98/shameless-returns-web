import { beforeEach, describe, expect, it, vi } from "vitest";

// The endpoint is PUBLIC — middleware.ts matches only /dashboard and /login, so
// the shared X-Secret is the only thing in front of it. These tests pin that it
// is enforced before any work happens, and that a redelivery cannot re-email a
// customer.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER: any = {
  id: "13194624794950",
  orderNumber: "#310972",
  email: "customer@example.com",
  shippingName: "Mário Lourenço",
  locale: "en",
  locator: null,
  returnStatus: null,
  products: [
    { action: "CAMBIO", title: "STAR AMALFI PANTS", new_variant_title: "Medium (40)" },
  ],
};

const found: { order: any } = { order: ORDER };
const writes: any[] = [];
const emails: any[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => found.order,
  getOrderByIdFresh: async () => found.order,
  getOrderByNumber: async () => found.order,
  getOrderByNumberFresh: async () => found.order,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (v: unknown) => {
      writes.push(v);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

// Mocked so an ops alert is not counted as a customer email: `alertOps` posts
// to the same Postmark endpoint the axios mock below captures.
const alerts: string[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string) => {
    alerts.push(subject);
  },
}));

vi.mock("axios", () => ({
  default: {
    post: async (_url: string, body: any) => {
      emails.push(body);
      return { status: 200 };
    },
  },
}));

async function post(body: unknown, secret?: string) {
  const { POST } = await import("@/app/api/webhooks/amphora/route");
  return POST(
    new Request("https://example.com/api/webhooks/amphora", {
      method: "POST",
      headers: secret ? { "X-Secret": secret } : {},
      body: JSON.stringify(body),
    })
  );
}

const TRACKING = {
  fulfillment_return: {
    id: "SHP 13194624794950",
    name: "#310972",
    internal_status: "APROVED",
    carrier: "UPS",
    carrier_number: "1Z999",
    carrier_url: "https://ups.com/1Z999",
  },
};

beforeEach(() => {
  writes.length = 0;
  emails.length = 0;
  alerts.length = 0;
  found.order = { ...ORDER };
  process.env.AMPHORA_WEBHOOK_SECRET = "s3cret";
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("POST /api/webhooks/amphora", () => {
  it("rejects a request with no secret", async () => {
    const res = await post(TRACKING);
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    const res = await post(TRACKING, "wrong");
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  it("rejects a secret of a different length without throwing", async () => {
    // timingSafeEqual throws on a length mismatch — a crash here would be a 500,
    // and Amphora would retry a request we intend to reject.
    const res = await post(TRACKING, "much-longer-than-the-real-secret");
    expect(res.status).toBe(401);
  });

  it("rejects everything when the secret is not configured", async () => {
    delete process.env.AMPHORA_WEBHOOK_SECRET;
    const res = await post(TRACKING, "s3cret");
    expect(res.status).toBe(401);
  });

  it("persists tracking and emails the customer", async () => {
    const res = await post(TRACKING, "s3cret");
    expect(res.status).toBe(200);
    expect(writes[0]).toMatchObject({
      returnStatus: "APROVED",
      locator: "1Z999",
      carrier: "UPS",
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].Subject).toBe("Your collection is scheduled");
    expect(emails[0].To).toBe("customer@example.com");
    // The exchange is a CAMBIO, so the replacement must be named.
    expect(emails[0].HtmlBody).toContain("STAR AMALFI PANTS — Medium (40)");
  });

  it("does nothing on a redelivery", async () => {
    found.order = { ...ORDER, returnStatus: "APROVED", locator: "1Z999" };
    const res = await post(TRACKING, "s3cret");
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });

  it("returns 200 for a return that is not ours", async () => {
    found.order = null;
    const res = await post(TRACKING, "s3cret");
    // A non-200 would make Amphora retry an unmatchable event forever.
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
  });

  it("returns 400 for an unparseable body", async () => {
    const { POST } = await import("@/app/api/webhooks/amphora/route");
    const res = await POST(
      new Request("https://example.com/api/webhooks/amphora", {
        method: "POST",
        headers: { "X-Secret": "s3cret" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("emails on arrival at the warehouse", async () => {
    found.order = { ...ORDER, returnStatus: "TRAVELLING", locator: "1Z999" };
    const res = await post(
      { fulfillment_return: { id: "SHP 13194624794950", internal_status: "RECEIVED" } },
      "s3cret"
    );
    expect(res.status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(emails[0].Subject).toBe("We've received your return");
  });

  it("records an exception and now DOES email the customer", async () => {
    // Reversed deliberately on 2026-08-27, same decision as the identical
    // invariant in tests/amphoraWebhook.test.ts: an exception is the one
    // state where the customer may need to act, and staying quiet is how
    // #310664 sat stranded for three weeks while a log line repeated unread.
    //
    // The order carries a locator, because the milestone is now decided per
    // PARCEL rather than per status change — without a carrier number there is
    // nothing to record the milestone against and nothing to stop a flapping
    // status re-emailing. See the sibling test in tests/amphoraWebhook.test.ts,
    // which pins that gap explicitly.
    found.order = { ...ORDER, returnStatus: "TRAVELLING", locator: "1Z999" };
    const res = await post(
      { fulfillment_return: { id: "SHP 13194624794950", internal_status: "EXCEPTION" } },
      "s3cret"
    );
    expect(res.status).toBe(200);
    expect(writes[0]).toMatchObject({ returnStatus: "EXCEPTION" });
    expect(emails).toHaveLength(1);
    // And a human hears about it too — the customer being told there is a
    // problem is no use if nobody who can act on it knows.
    expect(alerts.join(" ")).toContain("TRACKING INCIDENT");
  });
});
