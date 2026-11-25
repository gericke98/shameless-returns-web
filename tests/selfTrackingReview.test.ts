import { beforeEach, describe, expect, it, vi } from "vitest";

// Ops confirms or rejects self-booked tracking that could not be verified with
// the carrier. Amphora pins carrier_number write-once, so: only an admin, only
// a row that is still pending, and only one of confirm / reject ever acts.

let admin: string | null = "ops@example.com";
vi.mock("@/lib/requireAdmin", () => ({ adminEmail: async () => admin }));

const pinned: any[] = [];
let pinOk = true;
vi.mock("@/lib/pinSelfTracking", () => ({
  pinSelfTracking: async (t: any) => {
    pinned.push(t);
    return pinOk;
  },
}));

const emailed: any[] = [];
let emailStatus = 200;
vi.mock("@/lib/server/selfReturnEmails", () => ({
  sendSelfTrackingRejected: async (...args: any[]) => {
    emailed.push(args);
    return emailStatus;
  },
}));

const alerts: { subject: string; body: string }[] = [];
vi.mock("@/lib/server/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The actions name the submission through `eq(orders.trackingSubmissionId, x)`;
// the fake reads that value so its predicate checks the same identity.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    eq: (column: any, value: any) => {
      if (column?.name === "tracking_submission_id") named = value;
      return actual.eq(column, value);
    },
  };
});

const row: Record<string, any> = {};
// The submission the dashboard rendered; the action names it.
const SHOWN = "11111111-1111-4111-8111-111111111111";
let named = "";
const pending = () =>
  row.trackingSubmissionId === named &&
  row.returnMethod === "SELF" &&
  row.locator != null &&
  row.trackingVerifiedAt == null;
// Simulates another action landing between reject's read and its write.
let interleave: (() => void) | null = null;

// The fake applies the action's WHERE as the predicate above: the real
// conditions are SQL, so what this pins is the flow around them.
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    query: {
      orders: { findFirst: async () => (pending() ? { ...row } : undefined) },
    },
    update: () => chain,
    set: (values: any) => {
      chain._set = values;
      return chain;
    },
    where: () => chain,
    returning: async () => {
      if (interleave) {
        interleave();
        interleave = null;
      }
      if (!pending()) return [];
      Object.assign(row, chain._set);
      return [{ ...row }];
    },
  };
  return { default: chain };
});

const load = () => import("@/actions/selfTrackingReview");

beforeEach(() => {
  admin = "ops@example.com";
  pinned.length = 0;
  pinOk = true;
  emailed.length = 0;
  emailStatus = 200;
  alerts.length = 0;
  interleave = null;
  Object.assign(row, {
    id: "13221047697734",
    orderNumber: "#311595",
    email: "customer@example.com",
    shippingName: "Ana",
    locale: "es",
    returnMethod: "SELF",
    carrier: "OTHER",
    locator: "#311595",
    carrierUrl: "https://example.com/t",
    trackingSubmittedAt: new Date("2026-10-15"),
    trackingVerifiedAt: null,
    trackingVerifiedBy: null,
    trackingNudgeStage: 0,
    trackingSubmissionId: SHOWN,
  });
});

describe("confirmSelfTracking", () => {
  it("refuses without an admin session, changing nothing", async () => {
    admin = null;
    const { confirmSelfTracking } = await load();
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-admin" });
    expect(row.trackingVerifiedAt).toBeNull();
    expect(pinned).toHaveLength(0);
  });

  it("records who confirmed it and sends the stored number to Amphora", async () => {
    const { confirmSelfTracking } = await load();
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: true, pinned: true });
    expect(row.trackingVerifiedBy).toBe("ops@example.com");
    expect(row.trackingVerifiedAt).toBeInstanceOf(Date);
    expect(pinned).toEqual([
      expect.objectContaining({ carrier: "OTHER", number: "#311595", carrierUrl: "https://example.com/t" }),
    ]);
  });

  it("says so when Amphora refused the confirmed number", async () => {
    pinOk = false;
    const { confirmSelfTracking } = await load();
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: true, pinned: false });
  });

  it("never pins twice: a second confirm finds nothing pending", async () => {
    const { confirmSelfTracking } = await load();
    await confirmSelfTracking(row.id, SHOWN);
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(pinned).toHaveLength(1);
  });

  it("does nothing on a row already verified by the carrier", async () => {
    row.trackingVerifiedAt = new Date();
    row.trackingVerifiedBy = "correos";
    const { confirmSelfTracking } = await load();
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(pinned).toHaveLength(0);
  });
});

describe("rejectSelfTracking", () => {
  it("refuses without an admin session, changing nothing", async () => {
    admin = null;
    const { rejectSelfTracking } = await load();
    await expect(rejectSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-admin" });
    expect(row.locator).toBe("#311595");
    expect(emailed).toHaveLength(0);
  });

  it("clears the number so the portal asks again, and emails the customer quoting it", async () => {
    const { rejectSelfTracking } = await load();
    await expect(rejectSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: true });
    expect(row.locator).toBeNull();
    expect(row.carrier).toBeNull();
    expect(row.carrierUrl).toBeNull();
    expect(row.trackingSubmittedAt).toBeNull();
    expect(row.trackingNudgeStage).toBe(2);
    expect(emailed).toEqual([["customer@example.com", "Ana", "es", row.id, "#311595"]]);
    expect(pinned).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it("alerts ops when the customer could not be emailed", async () => {
    emailStatus = 500;
    const { rejectSelfTracking } = await load();
    await rejectSelfTracking(row.id, SHOWN);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("CUSTOMER NOT EMAILED");
    expect(alerts[0].body).toContain("#311595");
  });

  it("loses to a confirm that lands between its read and its write", async () => {
    interleave = () => {
      row.trackingVerifiedAt = new Date();
      row.trackingVerifiedBy = "other-admin@example.com";
    };
    const { rejectSelfTracking } = await load();
    await expect(rejectSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(row.locator).toBe("#311595");
    expect(emailed).toHaveLength(0);
  });

  it("clears the submission id with the number", async () => {
    const { rejectSelfTracking } = await load();
    await rejectSelfTracking(row.id, SHOWN);
    expect(row.trackingSubmissionId).toBeNull();
  });

  it("a confirm after a reject finds nothing to confirm", async () => {
    const { rejectSelfTracking, confirmSelfTracking } = await load();
    await rejectSelfTracking(row.id, SHOWN);
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(pinned).toHaveLength(0);
  });
});

// Codex review P1: admin A renders tracking X; it is rejected and the customer
// submits Y; A's stale Confirm must not verify and pin Y, which nobody saw.
describe("review acts only on the submission it showed", () => {
  it("a stale Confirm does not pin a newer submission", async () => {
    row.locator = "JD0123456789";
    row.trackingSubmissionId = "22222222-2222-4222-8222-222222222222";
    const { confirmSelfTracking } = await load();
    await expect(confirmSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(pinned).toHaveLength(0);
    expect(row.trackingVerifiedAt).toBeNull();
  });

  it("a stale Reject does not clear a newer submission", async () => {
    row.locator = "JD0123456789";
    row.trackingSubmissionId = "22222222-2222-4222-8222-222222222222";
    const { rejectSelfTracking } = await load();
    await expect(rejectSelfTracking(row.id, SHOWN)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(row.locator).toBe("JD0123456789");
    expect(emailed).toHaveLength(0);
  });

  it.each([[""], [undefined], [{ id: SHOWN }]])("refuses a missing or junk submission id (%s)", async (junk) => {
    const { confirmSelfTracking } = await load();
    await expect(confirmSelfTracking(row.id, junk as any)).resolves.toEqual({ ok: false, reason: "not-pending" });
    expect(pinned).toHaveLength(0);
  });
});
