import { beforeEach, describe, expect, it, vi } from "vitest";

// The international half of the August 2026 silent-email outage.
//
// #311027 (IT), #311332 (PT), #311328 (IT) and #311280 (NL) all had collections
// booked with carriers and tracking assigned, and none of the four customers
// ever received our confirmation. The branch that noticed only called
// `console.error`, and Vercel keeps runtime logs for about an hour.
//
// Amphora normally emails international customers the label and QR itself, so
// this is usually not an emergency — but that is a judgement a human has to
// make, and they can only make it if the failure reaches them.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13234838798662",
  orderNumber: "#311280",
  email: "customer@example.com",
  shippingName: "Wercia Alo",
  shippingCountry: "Netherlands",
  locale: "en",
  locator: null,
  products: [{ variant_id: "54623384371526", quantity: 1, action: "DEVOLUCIÓN" }],
};

const BOOKED = {
  id: "SHP 13234838798662",
  external_id: "13234838798662",
  internal_status: "APROVED",
  carrier: "DHP",
  carrier_number: "JJD00026866036799777001",
  carrier_url: "https://dhl.example/track",
};

const amphora = { create: vi.fn(), listByName: vi.fn() };
const alerts: { subject: string; body: string }[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getVariantSkusByIds: async () => ({ "54623384371526": "20250502" }),
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  createAmphoraReturn: (...a: unknown[]) => amphora.create(...a),
  getAmphoraReturnsByOrderName: (...a: unknown[]) => amphora.listByName(...a),
}));

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("axios", () => ({
  default: { post: vi.fn(async () => ({ status: 200 })) },
}));

async function run() {
  const { createInternationalReturn } = await import("@/actions/amphoraReturn");
  return createInternationalReturn(ORDER.id);
}

beforeEach(async () => {
  vi.clearAllMocks();
  alerts.length = 0;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  amphora.listByName.mockResolvedValue([]);
  amphora.create.mockResolvedValue(BOOKED);
  const axios = (await import("axios")).default as any;
  axios.post.mockResolvedValue({ status: 200 });
});

describe("a booked collection with no customer email must reach a human", () => {
  it("stays silent when the customer was actually emailed", async () => {
    await expect(run()).resolves.toBe(200);

    expect(alerts).toHaveLength(0);
  });

  it("alerts when Postmark refused the confirmation", async () => {
    const axios = (await import("axios")).default as any;
    axios.post.mockRejectedValue(new Error("postmark 503"));

    // Still 200 — the collection is booked and must not be reverted.
    await expect(run()).resolves.toBe(200);

    expect(alerts).toHaveLength(1);
  });

  it("gives the human the order, customer and carrier to act on", async () => {
    const axios = (await import("axios")).default as any;
    axios.post.mockRejectedValue(new Error("postmark 503"));

    await run();

    const text = `${alerts[0]?.subject}\n${alerts[0]?.body}`;
    expect(text).toContain(ORDER.orderNumber);
    expect(text).toContain(ORDER.email);
    expect(text).toContain(BOOKED.carrier_number);
    // Booking a second collection is the expensive mistake here.
    expect(text.toLowerCase()).toContain("do not book a second collection");
  });

  it("carries Postmark's own refusal, not a bare status code", async () => {
    const axios = (await import("axios")).default as any;
    axios.post.mockRejectedValue({
      response: { data: { ErrorCode: 300, Message: "Invalid 'To' address" } },
    });

    await run();

    expect(alerts[0]?.body).toContain("Invalid 'To' address");
  });
});
