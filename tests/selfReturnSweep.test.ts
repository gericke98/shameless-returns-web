import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-08-21T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

const rows: any[] = [];
const reminders: any[] = [];
const alerts: any[] = [];
const written: any[] = [];
// One shared, ordered log. `written[0]` and `reminders[0]` are two
// independent arrays with no relative sequence between them — only a single
// interleaved log can prove the write happened BEFORE the send, not just that
// both happened.
const events: string[] = [];

vi.mock("@/db/queries", () => ({
  getSelfReturnsAwaitingTracking: async () => rows,
}));

vi.mock("@/actions/selfReturnEmails", () => ({
  sendSelfReturnReminder: async (to: string) => {
    if (to === "throws@example.com") {
      throw new Error("Postmark is down");
    }
    events.push(`send:${to}`);
    reminders.push(to);
    return 200;
  },
}));

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      events.push(`stage:${values.trackingNudgeStage}`);
      written.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

async function sweep() {
  const { sweepSelfReturns } = await import("@/actions/selfReturnSweep");
  return sweepSelfReturns(NOW);
}

const row = (over: Record<string, any> = {}) => ({
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  shippingName: "Ferran Palma",
  locale: "es",
  returnMethod: "SELF",
  returnSubmittedAt: daysAgo(4),
  trackingSubmittedAt: null,
  trackingNudgeStage: 0,
  ...over,
});

beforeEach(() => {
  rows.length = 0;
  reminders.length = 0;
  alerts.length = 0;
  written.length = 0;
  events.length = 0;
});

describe("sweepSelfReturns", () => {
  it("reminds a customer who has not sent tracking in three days", async () => {
    rows.push(row());

    await expect(sweep()).resolves.toEqual({ reminded: 1, alerted: 0 });
    expect(reminders).toEqual(["customer@example.com"]);
  });

  it("advances the stage BEFORE sending, so a redelivery cannot double-send", async () => {
    // Same ordering applyReturnStatus uses. The cost is that a failed send is
    // not retried, which is why the failure is logged loudly.
    rows.push(row());

    await sweep();

    expect(written[0]).toEqual({ trackingNudgeStage: 1 });
    // The load-bearing assertion: one shared, ordered log proves the write
    // landed BEFORE the send fired, not merely that both happened.
    expect(events).toEqual(["stage:1", "send:customer@example.com"]);
  });

  it("alerts a human after ten days", async () => {
    rows.push(row({ returnSubmittedAt: daysAgo(11), trackingNudgeStage: 1 }));

    await expect(sweep()).resolves.toEqual({ reminded: 0, alerted: 1 });
    expect(alerts).toHaveLength(1);
    expect(`${alerts[0].subject}\n${alerts[0].body}`).toContain("#311174");
  });

  it("does nothing on a second pass", async () => {
    rows.push(row({ trackingNudgeStage: 1 }));

    await expect(sweep()).resolves.toEqual({ reminded: 0, alerted: 0 });
    expect(reminders).toHaveLength(0);
  });

  it("keeps sweeping when one row throws", async () => {
    // One bad row must not rob the others of their notification — the same
    // rule the Amphora sync applies. The first row's send genuinely throws
    // (see the "throws@example.com" special-case in the email mock above);
    // the second row must still get its reminder.
    rows.push(
      row({ id: "bad-1", orderNumber: "#311175", email: "throws@example.com" }),
      row({ id: "999", orderNumber: "#311176", email: "second@example.com" })
    );

    const result = await sweep();

    expect(result.reminded).toBe(1);
    expect(reminders).toEqual(["second@example.com"]);
  });
});
