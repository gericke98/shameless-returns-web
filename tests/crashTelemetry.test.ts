import { beforeEach, describe, expect, it, vi } from "vitest";

// #312973 (2026-11-20): a customer saw the crash screen and nothing reached
// us — the error lived only in their browser console and in a server log
// Vercel dropped within a day. Two channels now exist:
//
//  1. /api/client-error: the browser reports every crash; a crash screen shown
//     to someone holding a real portal session becomes a durable ops alert.
//  2. returnFunction: a submit that throws before anything is booked queues a
//     durable alert carrying the server's real error (the browser only ever
//     gets a redacted one).

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const queued: { dedupeKey: string; subject: string; body: string }[] = [];
vi.mock("@/actions/opsAlertOutbox", () => ({
  enqueueOpsAlert: async (alert: any) => {
    queued.push(alert);
    return true;
  },
}));

const session = { orderId: null as string | null };
vi.mock("@/lib/orderAccess", () => ({
  currentOrderId: async () => session.orderId,
  hasOrderAccess: async () => true,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => ({ name: "locale", value: "es" }) }),
}));
const stripe = { error: null as Error | null };
vi.mock("@/actions/payments", () => ({
  createStripeUrl: async () => {
    throw stripe.error;
  },
}));
vi.mock("@/actions/opsAlert", () => ({ alertOps: async () => {} }));
vi.mock("@/db/queries", () => ({ getOrderById: async () => ({ shippingCountry: "Spain" }) }));
vi.mock("@/db/drizzle", () => {
  const chain: any = { update: () => chain, set: () => chain, where: () => Promise.resolve() };
  return { default: chain };
});

import { parseClientErrorReport } from "@/lib/clientErrorReport";

beforeEach(() => {
  queued.length = 0;
  session.orderId = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function post(body: unknown) {
  return new Request("https://portal.test/api/client-error", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const CRASH = {
  kind: "boundary",
  message: "An error occurred in the Server Components render.",
  digest: "1234567890",
  stack: "Error: …",
  path: "/13577291399494?token=secret",
};

describe("parseClientErrorReport", () => {
  it("drops the query string and clamps long fields", () => {
    const report = parseClientErrorReport({ ...CRASH, message: "x".repeat(5000) });
    expect(report?.path).toBe("/13577291399494");
    expect(report!.message.length).toBeLessThanOrEqual(501);
  });

  it("refuses anything that is not a report", () => {
    expect(parseClientErrorReport({ ...CRASH, kind: "other" })).toBeNull();
    expect(parseClientErrorReport({ ...CRASH, path: "https://evil" })).toBeNull();
    expect(parseClientErrorReport("nope")).toBeNull();
  });
});

describe("POST /api/client-error", () => {
  it("queues an ops alert for a crash screen seen by a session holder, keyed by the SESSION's order", async () => {
    session.orderId = "13577291399494";
    const { POST } = await import("@/app/api/client-error/route");

    const response = await POST(post({ ...CRASH, path: "/999" }));

    expect(response.status).toBe(204);
    expect(queued).toHaveLength(1);
    expect(queued[0].subject).toContain("13577291399494");
    expect(queued[0].dedupeKey).toMatch(/^client-crash:13577291399494:/);
    expect(queued[0].body).toContain("1234567890");
  });

  it("only logs when there is no session — the public cannot mail ops", async () => {
    const { POST } = await import("@/app/api/client-error/route");

    const response = await POST(post(CRASH));

    expect(response.status).toBe(204);
    expect(queued).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("[client-error]"));
  });

  it("only logs an uncaught error that did not show the crash screen", async () => {
    session.orderId = "13577291399494";
    const { POST } = await import("@/app/api/client-error/route");

    await POST(post({ ...CRASH, kind: "uncaught" }));

    expect(queued).toHaveLength(0);
  });

  it("rejects junk and oversized bodies", async () => {
    const { POST } = await import("@/app/api/client-error/route");

    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ ...CRASH, stack: "x".repeat(9000) }))).status).toBe(413);
  });
});

describe("a submit refused before anything is booked", () => {
  it("a missing payout returns a typed refusal (no crash screen) and still alerts ops", async () => {
    const { PayoutRequiredError } = await import("@/lib/payoutRequired");
    stripe.error = new PayoutRequiredError("13577291399494");
    const { returnFunction } = await import("@/actions/return");

    await expect(returnFunction("13577291399494", null, "c@example.com")).resolves.toEqual({
      ok: false,
      reason: "payout-required",
    });

    expect(queued).toHaveLength(1);
    expect(queued[0].subject).toContain("13577291399494");
    expect(queued[0].body).toContain("no payout was chosen");
    expect(queued[0].body).toContain("Payout sent by the browser: none");
  });

  it("any other refusal still fails for the customer, with the real error sent to ops", async () => {
    stripe.error = new Error("Order 13577291399494: line item 1 has no fulfillment line item");
    const { returnFunction } = await import("@/actions/return");

    await expect(returnFunction("13577291399494", false, "c@example.com")).rejects.toThrow(
      /no fulfillment line item/
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toContain("no fulfillment line item");
  });
});
