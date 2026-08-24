import { beforeEach, describe, expect, it, vi } from "vitest";

// The submit half of a self-booked return. It must book NOTHING: no Correos
// pre-registration, no Amphora collection, no courier. The Amphora ticket is
// created unapproved on purpose — approving it is what dispatches a courier,
// and approve also PINS carrier_number write-once, which we cannot fill in
// until the customer has actually been to the post office.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingName: "Ferran Palma",
  shippingCountry: "Italy",
  locale: "es",
  locator: null,
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

const created: any[] = [];
const approved: any[] = [];
const emails: any[] = [];
const alerts: any[] = [];
const written: any[] = [];

vi.mock("@/db/queries", () => ({
  // The implementation reads via `getOrderByIdFresh`, deliberately bypassing
  // React `cache()` — see the comment in actions/selfBookedReturn.ts. Kept
  // both exports mocked so a regression back to the cached read still
  // resolves an order rather than failing for an unrelated reason.
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  getVariantSkusByIds: async () => ({ "1": "SKU-1" }),
}));

vi.mock("@/actions/amphora", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createAmphoraReturn: async (input: any) => {
      created.push(input);
      return { id: "SHP 13221047697734", internal_status: "PENDING" };
    },
    approveAmphoraReturn: async (id: string, data: any) => {
      approved.push({ id, data });
      return { id, internal_status: "APROVED" };
    },
  };
});

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      written.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) {
        emails.push(url);
        return { status: 200 };
      }
      throw new Error(`unexpected outbound call to ${url}`);
    },
  },
}));

async function run() {
  const { createSelfBookedReturn } = await import("@/actions/selfBookedReturn");
  return createSelfBookedReturn(ORDER.id);
}

beforeEach(() => {
  created.length = 0;
  approved.length = 0;
  emails.length = 0;
  alerts.length = 0;
  written.length = 0;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
});

describe("createSelfBookedReturn", () => {
  it("reports success", async () => {
    await expect(run()).resolves.toBe(200);
  });

  it("creates the Amphora ticket without auto-approving it", async () => {
    // auto_approve is what dispatches a courier. There is no parcel to collect
    // — the customer is posting it themselves.
    await run();

    expect(created).toHaveLength(1);
    expect(created[0].autoApprove).toBeFalsy();
  });

  it("never approves the ticket at submit time", async () => {
    // carrier_number is write-once at approve, and we do not know it yet.
    await run();

    expect(approved).toHaveLength(0);
  });

  it("books no carrier of our own", async () => {
    // No Correos SOAP call: the axios mock throws on anything but Postmark.
    await expect(run()).resolves.toBe(200);
  });

  it("stamps when the return was submitted", async () => {
    // orders has no other timestamp, and the abandonment sweep measures from
    // this one.
    await run();

    const stamped = written.find((w) => w.returnSubmittedAt);
    expect(stamped?.returnSubmittedAt).toBeInstanceOf(Date);
  });

  it("emails the customer their instructions", async () => {
    await run();

    expect(emails).toHaveLength(1);
  });

  it("alerts a human when the warehouse could not be told", async () => {
    // Same rule as every other lane: the return still exists, so we swallow
    // and report 200 — but never silently. #311174 is why.
    created.length = 0;
    const amphora = await import("@/actions/amphora");
    vi.spyOn(amphora, "createAmphoraReturn").mockRejectedValueOnce(
      new Error("amphora 503")
    );

    await expect(run()).resolves.toBe(200);
    expect(alerts).toHaveLength(1);
  });

  it("does not open a second ticket on a duplicate submit", async () => {
    // A resubmit must see whatever the FIRST submit just wrote, not a snapshot
    // read before it — a cached read here would open a second Amphora ticket
    // and send a second instructions email for one parcel.
    const queries = await import("@/db/queries");
    vi.spyOn(queries, "getOrderByIdFresh").mockResolvedValueOnce({
      ...ORDER,
      returnSubmittedAt: new Date("2026-08-20T00:00:00Z"),
    } as any);

    await expect(run()).resolves.toBe(200);

    expect(created).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(emails).toHaveLength(0);
  });
});
