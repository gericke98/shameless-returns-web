import { beforeEach, describe, expect, it, vi } from "vitest";

// Public route (middleware covers only /dashboard and /login): CRON_SECRET is
// the only thing in front of it, so unset must mean closed. A sweep that keeps
// failing detects nothing, so it must say so durably, once a day.

const state = { throws: false, calls: 0 };
const queued: any[] = [];
vi.mock("@/actions/receiptShortfallSweep", () => ({
  sweepReceiptShortfalls: async () => {
    state.calls += 1;
    if (state.throws) throw new Error('relation "receipt_shortfalls" does not exist');
    return { scanned: 3, short: 1 };
  },
}));
vi.mock("@/actions/opsAlertOutbox", () => ({
  enqueueOpsAlerts: async (list: any[]) => {
    queued.push(...list);
    return { failed: 0 };
  },
}));

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/cron/receipt-shortfalls/route");
  return GET(new Request("https://x.test/api/cron/receipt-shortfalls", { headers }));
}

beforeEach(() => {
  state.throws = false;
  state.calls = 0;
  queued.length = 0;
  process.env.CRON_SECRET = "s3cret";
});

describe("receipt-shortfalls cron", () => {
  it("401s without the secret configured, and runs nothing", async () => {
    delete process.env.CRON_SECRET;

    expect((await call({ authorization: "Bearer x" })).status).toBe(401);
    expect(state.calls).toBe(0);
  });

  it("runs the sweep and reports it", async () => {
    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: 3, short: 1 });
  });

  it("on failure: 502 and one durable alert keyed by the UTC day", async () => {
    state.throws = true;

    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(502);
    expect(queued).toHaveLength(1);
    expect(queued[0].dedupeKey).toMatch(/^receipt-shortfalls-failing:\d{4}-\d{2}-\d{2}$/);
    expect(queued[0].body).toContain("receipt_shortfalls");
  });
});
