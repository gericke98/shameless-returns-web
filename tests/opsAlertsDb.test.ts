import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

// The outbox guarantees live in SQL: the unique dedupe key, the claim lease,
// accepted rows never being re-sent. tests/opsAlertOutbox.test.ts mocks this
// layer away, so these run the REAL db/opsAlerts.ts functions against the REAL
// migration file in an in-process Postgres (PGlite).
//
// PGlite has one connection, so two dispatchers racing on `SKIP LOCKED` cannot
// be reproduced here; the lease, which is what makes a second claim come back
// empty, is.

const pg = new PGlite();
const db = drizzle(pg, { schema });
vi.mock("@/db/drizzle", () => ({ default: db }));

const repo = () => import("@/db/opsAlerts");
const alert = (key: string) => ({ dedupeKey: key, subject: `s ${key}`, body: "b" });

async function row(key: string) {
  const result = await pg.query<any>("SELECT * FROM ops_alerts WHERE dedupe_key = $1", [key]);
  return result.rows[0];
}

beforeAll(async () => {
  const migration = readFileSync("drizzle/0004_ops_alerts.sql", "utf8");
  await pg.exec(migration);
  // Applying it twice must be harmless: it is run by hand.
  await pg.exec(migration);
});

beforeEach(async () => {
  await pg.exec("DELETE FROM ops_alerts");
});

describe("db/opsAlerts against Postgres", () => {
  it("inserts a dedupe key once and reports the duplicate", async () => {
    const { insertOpsAlert } = await repo();

    expect(await insertOpsAlert(alert("k"))).toBe(true);
    expect(await insertOpsAlert({ ...alert("k"), subject: "changed" })).toBe(false);

    expect((await row("k")).subject).toBe("s k");
  });

  it("claims pending rows once, then not again while the lease holds", async () => {
    const { insertOpsAlert, claimPendingOpsAlerts } = await repo();
    await insertOpsAlert(alert("a"));
    await insertOpsAlert(alert("b"));

    const first = await claimPendingOpsAlerts(5);
    const second = await claimPendingOpsAlerts(5);

    expect(first.map((r) => r.dedupeKey).sort()).toEqual(["a", "b"]);
    expect(first[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), subject: expect.any(String), body: "b" })
    );
    expect(second).toEqual([]);
    expect((await row("a")).last_attempt_at).not.toBeNull();
  });

  it("re-claims a failed row once its lease has expired, keeping the error", async () => {
    const { insertOpsAlert, claimPendingOpsAlerts, markOpsAlertFailed, OPS_ALERT_LEASE_SECONDS } =
      await repo();
    await insertOpsAlert(alert("a"));
    const [claimed] = await claimPendingOpsAlerts(5);
    await markOpsAlertFailed(claimed.id, "Postmark 500");

    await pg.query(
      `UPDATE ops_alerts SET last_attempt_at = now() - make_interval(secs => $1) WHERE id = $2`,
      [OPS_ALERT_LEASE_SECONDS + 1, claimed.id]
    );
    const again = await claimPendingOpsAlerts(5);

    expect(again.map((r) => r.id)).toEqual([claimed.id]);
    expect((await row("a")).last_error).toBe("Postmark 500");
  });

  it("never claims an accepted row, even with an expired lease", async () => {
    const { insertOpsAlert, claimPendingOpsAlerts, markOpsAlertAccepted } = await repo();
    await insertOpsAlert(alert("a"));
    const [claimed] = await claimPendingOpsAlerts(5);
    await markOpsAlertAccepted(claimed.id);
    await pg.query(`UPDATE ops_alerts SET last_attempt_at = now() - interval '1 day'`);

    expect(await claimPendingOpsAlerts(5)).toEqual([]);
    const accepted = await row("a");
    expect(accepted.accepted_at).not.toBeNull();
    expect(accepted.last_error).toBeNull();
  });

  it("respects the limit and serves never-attempted rows before retries", async () => {
    const { insertOpsAlert, claimPendingOpsAlerts } = await repo();
    await insertOpsAlert(alert("retry"));
    await pg.query(
      `UPDATE ops_alerts SET last_attempt_at = now() - interval '1 hour' WHERE dedupe_key = 'retry'`
    );
    await insertOpsAlert(alert("fresh"));

    const claimed = await claimPendingOpsAlerts(1);

    expect(claimed.map((r) => r.dedupeKey)).toEqual(["fresh"]);
  });
});
