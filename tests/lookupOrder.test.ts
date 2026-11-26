import { beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lookupMessage, type LookupMessage } from "@/lib/i18n";

// The portal's only public write (F1 spec §4 `lookupOrder`), through the REAL
// action: the order id is minted only once the number AND the email matched
// Shopify, and only then is anything saved or a session issued.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => ({ default: {}, transact: async () => [] }))()));
vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-real-ip": "203.0.113.9" }) }));
vi.mock("@/lib/server/opsAlertOutbox", () => ({ enqueueOpsAlert: async () => true }));
vi.mock("@/lib/server/orderScope", () => ({ orderScope: () => ({}) }));
vi.mock("@/lib/requireAdmin", () => ({ adminEmail: async () => null }));

const calls = vi.hoisted(() => ({
  saved: [] as string[],
  items: [] as string[],
  sessions: [] as string[],
  failures: [] as string[],
  shopify: null as any,
  exists: false,
}));
vi.mock("@/db/queries", () => ({ getOrderQuery: async () => calls.shopify }));
vi.mock("@/db/repository", () => ({
  orderExists: async () => calls.exists,
  saveOrderDetails: async (id: string) => calls.saved.push(id),
  saveOrderItem: async (item: any, orderId: string) => calls.items.push(`${orderId}:${item.id}`),
}));
vi.mock("@/lib/orderAccess", () => ({
  issueOrderAccess: async (id: string) => calls.sessions.push(id),
  currentOrderId: async () => null,
}));
vi.mock("@/db/lookupAttempts", () => ({
  countRecentFailures: async () => 0,
  recordFailedAttempt: async (ip: string) => calls.failures.push(ip),
}));
vi.mock("@/lib/server/replacementOrder", () => ({ planReplacementOrder: async () => ({ kind: "original" }) }));

const SHOPIFY_ORDER = () => ({
  id: 13217168851270,
  name: "#312001",
  contact_email: "ana@example.com",
  note: "",
  fulfillment_status: "fulfilled",
  fulfillments: [{ updated_at: new Date().toISOString() }],
  shipping_address: { country: "Spain" },
  line_items: [{ id: 1, quantity: 1, price: "50.00", discount_allocations: [] }],
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};
const lookup = async (fields: Record<string, string>) => {
  const { lookupOrder } = await import("@/actions/order");
  return lookupOrder({ message: null }, form(fields));
};

beforeEach(() => {
  calls.saved.length = 0;
  calls.items.length = 0;
  calls.sessions.length = 0;
  calls.failures.length = 0;
  calls.shopify = SHOPIFY_ORDER();
  calls.exists = false;
});

describe("lookupOrder", () => {
  it("saves a new order and issues its session only for matching credentials", async () => {
    await expect(lookup({ order: "#312001", email: "ana@example.com" })).rejects.toThrow("NEXT_REDIRECT");
    expect(calls.saved).toEqual(["13217168851270"]);
    expect(calls.items).toEqual(["13217168851270:1"]);
    expect(calls.sessions).toEqual(["13217168851270"]);
  });

  it("saves nothing and issues no session for the wrong email", async () => {
    expect(await lookup({ order: "#312001", email: "someone@else.com" })).toEqual({ message: "lookup.mismatch" });
    expect(calls.saved).toEqual([]);
    expect(calls.sessions).toEqual([]);
    expect(calls.failures).toEqual(["203.0.113.9"]);
  });

  it("refuses an unknown order number, saving nothing", async () => {
    calls.shopify = null;
    expect(await lookup({ order: "1", email: "ana@example.com" })).toEqual({ message: "lookup.notFound" });
    expect(calls.saved).toEqual([]);
  });

  it("refuses a form with an extra field, before Shopify is asked", async () => {
    expect(await lookup({ order: "#312001", email: "ana@example.com", id: "999" })).toEqual({
      message: "lookup.invalidInput",
    });
    expect(calls.sessions).toEqual([]);
  });

  it("ignores React's own $ACTION_ fields", async () => {
    await expect(
      lookup({ order: "#312001", email: "ana@example.com", $ACTION_REF_1: "", "$ACTION_1:0": "{}" })
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(calls.sessions).toEqual(["13217168851270"]);
  });

  it("refuses an order outside the return window", async () => {
    calls.shopify.fulfillments = [{ updated_at: "2020-01-01T00:00:00Z" }];
    expect(await lookup({ order: "#312001", email: "ana@example.com" })).toEqual({ message: "lookup.outsideWindow" });
    expect(calls.saved).toEqual([]);
  });
});

describe("every lookup refusal renders in both languages", () => {
  const KEYS: LookupMessage[] = [
    "tooManyAttempts",
    "invalidInput",
    "notFound",
    "mismatch",
    "contactSupport",
    "notYetShipped",
    "outsideWindow",
    "failed",
  ];
  it.each(["es", "en"] as const)("%s", (locale) => {
    for (const key of KEYS) {
      const text = lookupMessage(dictionaries[locale], `lookup.${key}`);
      expect([key, typeof text === "string" && text.length > 0]).toEqual([key, true]);
    }
  });
});
