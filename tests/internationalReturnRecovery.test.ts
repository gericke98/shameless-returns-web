import { beforeEach, describe, expect, it, vi } from "vitest";

// The failure that cost order #310972.
//
// Both callers (the Stripe webhook and returnFunction) revert the database when
// this returns anything other than 200. That revert is DB-only: it cannot
// un-book an Amphora collection or close a Shopify return. So once Amphora has
// booked the courier, returning non-200 leaves the worst possible state — a
// real collection scheduled, a Shopify return open, our DB claiming nothing
// happened, the row invisible to the dashboard (getReturns filters on
// confirmed), and the customer told nothing at all.
//
// Rule: after the collection exists, NOTHING may propagate a failure.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13194624794950",
  orderNumber: "#310972",
  email: "customer@example.com",
  shippingName: "Mário Lourenço",
  shippingCountry: "Portugal",
  locale: "en",
  products: [
    { variant_id: "54623384371526", quantity: 1, action: "CAMBIO", title: "PANTS", new_variant_title: "Medium (40)" },
  ],
};

const BOOKED = {
  id: "SHP 13194624794950",
  external_id: "13194624794950",
  internal_status: "APROVED",
  carrier: null,
  carrier_number: null,
  carrier_url: null,
};

const amphora = {
  create: vi.fn(),
  listByName: vi.fn(),
};
const dbWrites: unknown[] = [];
const emails: unknown[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getVariantSkusByIds: async () => ({ "54623384371526": "20250502" }),
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: unknown) => {
      dbWrites.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  createAmphoraReturn: (...a: unknown[]) => amphora.create(...a),
  getAmphoraReturnsByOrderName: (...a: unknown[]) => amphora.listByName(...a),
}));

vi.mock("axios", () => ({
  default: {
    post: async (...a: unknown[]) => {
      emails.push(a);
      return { status: 200 };
    },
  },
}));

async function run() {
  const { createInternationalReturn } = await import("@/actions/amphoraReturn");
  return createInternationalReturn("13194624794950");
}

beforeEach(() => {
  vi.clearAllMocks();
  dbWrites.length = 0;
  emails.length = 0;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  amphora.listByName.mockResolvedValue([]);
  amphora.create.mockResolvedValue(BOOKED);
});

describe("createInternationalReturn — never revert a booked collection", () => {
  it("succeeds on the happy path", async () => {
    await expect(run()).resolves.toBe(200);
  });

  it("still succeeds when the confirmation email fails", async () => {
    const axios = (await import("axios")).default as any;
    vi.spyOn(axios, "post").mockRejectedValueOnce(new Error("postmark down"));

    // The collection is booked; a failed email must not cost the customer
    // their return.
    await expect(run()).resolves.toBe(200);
  });

  it("still succeeds when persisting the tracking fails", async () => {
    const dbModule = (await import("@/db/drizzle")).default as any;
    vi.spyOn(dbModule, "update").mockImplementationOnce(() => {
      throw new Error("neon unreachable");
    });

    await expect(run()).resolves.toBe(200);
  });

  it("still succeeds when the tracking read-back fails after booking", async () => {
    // createAmphoraReturn returned no carrier, so the code reads back. Amphora
    // being briefly unavailable there must not undo a booked collection.
    amphora.create.mockResolvedValue({ ...BOOKED, carrier_number: null });
    amphora.listByName
      .mockResolvedValueOnce([]) // idempotency probe
      .mockRejectedValueOnce(new Error("amphora 503")); // read-back

    await expect(run()).resolves.toBe(200);
  });

  it("does not re-book when a collection already exists for the order", async () => {
    amphora.listByName.mockResolvedValue([BOOKED]);

    await expect(run()).resolves.toBe(200);
    expect(amphora.create).not.toHaveBeenCalled();
  });

  it("treats a create that failed AFTER Amphora committed as booked", async () => {
    // The POST can time out on the response while Amphora has already created
    // the return. Concluding "nothing happened" strands a real courier pickup,
    // so we must ask Amphora before reverting.
    amphora.listByName
      .mockResolvedValueOnce([]) // idempotency probe: nothing yet
      .mockResolvedValue([BOOKED]); // after the failed POST: it does exist
    amphora.create.mockRejectedValue(new Error("socket hang up"));

    await expect(run()).resolves.toBe(200);
  });

  it("reports failure only when nothing was booked", async () => {
    // Genuine failure: Amphora has no record, so reverting is safe and correct.
    amphora.listByName.mockResolvedValue([]);
    amphora.create.mockRejectedValue(new Error("400 bad request"));

    await expect(run()).resolves.not.toBe(200);
  });
});
