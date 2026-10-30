import { beforeEach, describe, expect, it, vi } from "vitest";

// The outbox's only dispatcher. It must run closed without CRON_SECRET (it
// emails ops), and it must not depend on any other cron's work succeeding.

const state = { throws: false, calls: 0 };
vi.mock("@/actions/opsAlertOutbox", () => ({
  dispatchOpsAlerts: async () => {
    state.calls += 1;
    if (state.throws) throw new Error("neon 402");
    return { sent: 2, failed: 1 };
  },
}));

async function call(headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/cron/ops-alerts/route");
  return GET(new Request("https://x.test/api/cron/ops-alerts", { headers }));
}

beforeEach(() => {
  state.throws = false;
  state.calls = 0;
  process.env.CRON_SECRET = "s3cret";
});

describe("ops-alerts cron", () => {
  it("401s without the secret configured, and dispatches nothing", async () => {
    delete process.env.CRON_SECRET;

    expect((await call({ authorization: "Bearer anything" })).status).toBe(401);
    expect(state.calls).toBe(0);
  });

  it("401s on a wrong bearer", async () => {
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(state.calls).toBe(0);
  });

  it("dispatches and reports what it sent", async () => {
    const res = await call({ authorization: "Bearer s3cret" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 1 });
  });

  it("500s when dispatch throws, so the failure shows in the cron view", async () => {
    state.throws = true;

    expect((await call({ authorization: "Bearer s3cret" })).status).toBe(500);
  });
});
