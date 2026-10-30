import { beforeEach, describe, expect, it, vi } from "vitest";

// The outbox exists because `alertOps` is best effort: a Postmark outage or a
// crash between detection and send loses the alert. A row is delivered only
// when Postmark accepts it, and the dedupe key makes a condition re-detected
// every 15 minutes one email, not 96 a day.

type Row = {
  id: string;
  dedupeKey: string;
  subject: string;
  body: string;
  acceptedAt: Date | null;
  lastError: string | null;
};
const rows: Row[] = [];
const sends: string[] = [];
const postmark = { ok: true, error: "" };
const insertFailsFor = new Set<string>();

// In-memory stand-in for db/opsAlerts.ts. The real claim SQL (lease + SKIP
// LOCKED) is exercised against Postgres separately; here a claim returns every
// undelivered row, which is what a run with no concurrent dispatcher sees.
vi.mock("@/db/opsAlerts", () => ({
  insertOpsAlert: async (alert: { dedupeKey: string; subject: string; body: string }) => {
    if (insertFailsFor.has(alert.dedupeKey)) throw new Error("neon 402");
    if (rows.some((r) => r.dedupeKey === alert.dedupeKey)) return false;
    rows.push({ id: `id-${rows.length}`, ...alert, acceptedAt: null, lastError: null });
    return true;
  },
  claimPendingOpsAlerts: async (limit: number) =>
    rows.filter((r) => !r.acceptedAt).slice(0, limit),
  markOpsAlertAccepted: async (id: string) => {
    const row = rows.find((r) => r.id === id)!;
    row.acceptedAt = new Date();
    row.lastError = null;
  },
  markOpsAlertFailed: async (id: string, error: string) => {
    rows.find((r) => r.id === id)!.lastError = error;
  },
}));

vi.mock("@/actions/opsAlert", () => ({
  sendOpsAlert: async (subject: string) => {
    sends.push(subject);
    return postmark.ok ? { ok: true } : { ok: false, error: postmark.error };
  },
}));

const outbox = () => import("@/actions/opsAlertOutbox");
const alert = (key: string) => ({ dedupeKey: key, subject: `subject ${key}`, body: "body" });

beforeEach(() => {
  rows.length = 0;
  sends.length = 0;
  postmark.ok = true;
  postmark.error = "";
  insertFailsFor.clear();
});

describe("ops-alert outbox", () => {
  it("queues a condition once however many runs re-detect it", async () => {
    const { enqueueOpsAlert, dispatchOpsAlerts } = await outbox();

    expect(await enqueueOpsAlert(alert("match-conflict:SHP 1"))).toBe(true);
    expect(await enqueueOpsAlert(alert("match-conflict:SHP 1"))).toBe(false);
    await dispatchOpsAlerts();
    // Re-detected after delivery: still the same key, still no second email.
    await enqueueOpsAlert(alert("match-conflict:SHP 1"));
    await dispatchOpsAlerts();

    expect(rows).toHaveLength(1);
    expect(sends).toEqual(["subject match-conflict:SHP 1"]);
  });

  it("marks a row delivered only when Postmark accepts it", async () => {
    const { enqueueOpsAlert, dispatchOpsAlerts } = await outbox();
    await enqueueOpsAlert(alert("k"));

    await expect(dispatchOpsAlerts()).resolves.toEqual({ sent: 1, failed: 0 });

    expect(rows[0].acceptedAt).not.toBeNull();
  });

  it("keeps a rejected row pending with the error, and delivers it on a later run", async () => {
    const { enqueueOpsAlert, dispatchOpsAlerts } = await outbox();
    await enqueueOpsAlert(alert("k"));
    postmark.ok = false;
    postmark.error = "Request failed with status code 500";

    await expect(dispatchOpsAlerts()).resolves.toEqual({ sent: 0, failed: 1 });
    expect(rows[0].acceptedAt).toBeNull();
    expect(rows[0].lastError).toBe("Request failed with status code 500");

    postmark.ok = true;
    await expect(dispatchOpsAlerts()).resolves.toEqual({ sent: 1, failed: 0 });
    expect(rows[0].acceptedAt).not.toBeNull();
    expect(rows[0].lastError).toBeNull();
    expect(sends).toHaveLength(2);
  });

  it("sends at most the dispatch limit per run", async () => {
    const { enqueueOpsAlert, dispatchOpsAlerts, OPS_ALERT_DISPATCH_LIMIT } = await outbox();
    for (let i = 0; i < OPS_ALERT_DISPATCH_LIMIT + 2; i++) await enqueueOpsAlert(alert(`k${i}`));

    await dispatchOpsAlerts();
    expect(sends).toHaveLength(OPS_ALERT_DISPATCH_LIMIT);
    await dispatchOpsAlerts();
    expect(sends).toHaveLength(OPS_ALERT_DISPATCH_LIMIT + 2);
  });

  it("enqueueOpsAlerts never throws and queues the rest when one insert fails", async () => {
    const { enqueueOpsAlerts } = await outbox();
    insertFailsFor.add("a");

    await expect(enqueueOpsAlerts([alert("a"), alert("b")])).resolves.toBeUndefined();

    expect(rows.map((r) => r.dedupeKey)).toEqual(["b"]);
  });
});
