import { beforeEach, describe, expect, it, vi } from "vitest";

// The boundary every action goes through (F1 spec §2), exercised on the REAL
// action modules: the factory, not the handler, reads the credential and
// validates the input, so a handler never runs for a caller without one.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {}, transact: async () => [] }));
vi.mock("@/lib/stripe", () => ({ default: {}, stripe: {} }));

const session = vi.hoisted(() => ({ orderId: null as string | null, admin: null as string | null }));
vi.mock("@/lib/orderAccess", () => ({ currentOrderId: async () => session.orderId }));
vi.mock("@/lib/requireAdmin", () => ({ adminEmail: async () => session.admin }));

const alerts = vi.hoisted(() => ({ throws: false, queued: [] as any[] }));
vi.mock("@/lib/server/opsAlertOutbox", () => ({
  enqueueOpsAlert: async (alert: any) => {
    if (alerts.throws) throw new Error("outbox down");
    alerts.queued.push(alert);
    return true;
  },
}));

/** Every handler, replaced by a spy that records it ran (the schemas stay real). */
const { ran, handlerBehaviour, withSpies } = vi.hoisted(() => {
  const ran: string[] = [];
  const handlerBehaviour = { throws: false };
  const spy = (name: string) => async () => {
    ran.push(name);
    if (handlerBehaviour.throws) throw new Error(`${name} exploded`);
    return { ok: true, value: {} };
  };
  const withSpies = (names: string[]) => async (importOriginal: () => Promise<any>) => ({
    ...(await importOriginal()),
    ...Object.fromEntries(names.map((n) => [n, spy(n)])),
  });
  return { ran, handlerBehaviour, withSpies };
});
vi.mock("@/lib/server/handlers/customer/submitReturn", withSpies(["submitReturnHandler"]));
vi.mock("@/lib/server/handlers/customer/lines", withSpies(["setLineSelectionHandler", "clearLineSelectionHandler"]));
vi.mock("@/lib/server/handlers/customer/address", withSpies(["saveAddressHandler"]));
vi.mock("@/lib/server/handlers/customer/submitTracking", withSpies(["submitTrackingHandler"]));
vi.mock("@/lib/server/handlers/customer/cancelReturn", withSpies(["cancelReturnHandler"]));
vi.mock("@/lib/server/handlers/admin/settleRow", withSpies(["settleRowHandler"]));
vi.mock("@/lib/server/handlers/admin/saveShippingFee", withSpies(["saveShippingFeeHandler"]));
vi.mock("@/lib/server/handlers/admin/selfTrackingReview", withSpies(["confirmSelfTrackingHandler", "rejectSelfTrackingHandler"]));

const A = "13217168851270";
const B = "13217168851271";

/** A valid input for each customer action, for order `id`. */
const customer = async (id: string) => [
  ["submitReturn", (await import("@/actions/return")).submitReturn, { expectedOrderId: id, payout: "refund", method: "CORREOS" }],
  ["setLineSelection", (await import("@/actions/lines")).setLineSelection, { expectedOrderId: id, rowId: 1, action: "DEVOLUCIÓN", reason: "TOO_BIG", notes: "" }],
  ["clearLineSelection", (await import("@/actions/lines")).clearLineSelection, { expectedOrderId: id, rowId: 1 }],
  ["saveAddress", (await import("@/actions/address")).saveAddress, { expectedOrderId: id, name: "a", address1: "b", zip: "c", city: "d", delivery: null, deliveryBlockOffered: false }],
  ["submitTracking", (await import("@/actions/tracking")).submitTracking, { expectedOrderId: id, carrierCode: "DHL", trackingNumber: "JD1" }],
  ["cancelReturn", (await import("@/actions/cancelReturn")).cancelReturn, { expectedOrderId: id }],
] as Array<[string, (input: any) => Promise<any>, any]>;

const admin = async () => [
  ["settleRow", (await import("@/actions/refund")).settleRow, { rowId: 1 }],
  ["saveShippingFee", (await import("@/actions/shippingFees")).saveShippingFee, { country: "ES", band: 1000, returnFee: "5.00", exchangeFee: "5.00" }],
  ["confirmSelfTracking", (await import("@/actions/selfTrackingReview")).confirmSelfTracking, { orderId: A, submissionId: "s" }],
  ["rejectSelfTracking", (await import("@/actions/selfTrackingReview")).rejectSelfTracking, { orderId: A, submissionId: "s" }],
] as Array<[string, (input: any) => Promise<any>, any]>;

beforeEach(() => {
  session.orderId = null;
  session.admin = null;
  ran.length = 0;
  alerts.throws = false;
  alerts.queued.length = 0;
  handlerBehaviour.throws = false;
});

describe("customer actions", () => {
  it("answer no-session without a portal session, and run nothing", async () => {
    for (const [name, action, input] of await customer(A)) {
      expect([name, await action(input)]).toEqual([name, { ok: false, reason: "no-session" }]);
    }
    expect(ran).toEqual([]);
  });

  it("answer order-mismatch for another order's id (a stale tab), and run nothing", async () => {
    session.orderId = B;
    for (const [name, action, input] of await customer(A)) {
      expect([name, await action(input)]).toEqual([name, { ok: false, reason: "order-mismatch" }]);
    }
    expect(ran).toEqual([]);
  });

  it("answer invalid-input for an extra field, and run nothing", async () => {
    session.orderId = A;
    for (const [name, action, input] of await customer(A)) {
      expect([name, await action({ ...input, orderId: B })]).toEqual([name, { ok: false, reason: "invalid-input" }]);
    }
    expect(ran).toEqual([]);
  });

  it("run the handler for the session's own order", async () => {
    session.orderId = A;
    for (const [name, action, input] of await customer(A)) {
      expect([name, await action(input)]).toEqual([name, { ok: true, value: {} }]);
    }
    expect(ran).toHaveLength(6);
  });
});

describe("admin actions", () => {
  it("answer not-admin without an admin session, and run nothing", async () => {
    session.orderId = A; // a portal session is not an admin session
    for (const [name, action, input] of await admin()) {
      expect([name, await action(input)]).toEqual([name, { ok: false, reason: "not-admin" }]);
    }
    expect(ran).toEqual([]);
  });

  it("run the handler for an admin", async () => {
    session.admin = "ops@example.com";
    for (const [name, action, input] of await admin()) {
      expect([name, await action(input)]).toEqual([name, { ok: true, value: {} }]);
    }
    expect(ran).toHaveLength(4);
  });
});

describe("an unexpected throw", () => {
  it("answers failed and queues a deduped alert naming the action and the order", async () => {
    session.orderId = A;
    handlerBehaviour.throws = true;
    const { cancelReturn } = await import("@/actions/cancelReturn");

    expect(await cancelReturn({ expectedOrderId: A })).toEqual({ ok: false, reason: "failed" });
    expect(alerts.queued).toHaveLength(1);
    expect(alerts.queued[0].dedupeKey).toMatch(new RegExp(`^action-error:cancelReturn:${A}:\\d{4}-\\d{2}-\\d{2}T\\d{2}$`));
    expect(alerts.queued[0].body).toContain("cancelReturnHandler exploded");
  });

  it("still answers failed when the alert itself cannot be queued", async () => {
    session.orderId = A;
    handlerBehaviour.throws = true;
    alerts.throws = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { cancelReturn } = await import("@/actions/cancelReturn");

    expect(await cancelReturn({ expectedOrderId: A })).toEqual({ ok: false, reason: "failed" });
  });

  it("rethrows Next's redirect, which is control flow, not a failure", async () => {
    const { redirect } = await import("next/navigation");
    const { customerAction } = await import("@/lib/server/actions");
    const { z } = await import("zod");
    session.orderId = A;
    const action = customerAction("redirects", z.object({ expectedOrderId: z.string() }).strict(), async () =>
      redirect("/elsewhere")
    );
    await expect(action({ expectedOrderId: A })).rejects.toThrow("NEXT_REDIRECT");
    expect(alerts.queued).toHaveLength(0);
  });
});
