import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";

// End to end over the real SQL: the sweep, db/receiptShortfalls.ts, the
// ops-alert outbox and its dispatcher all run against both migrations in an
// in-process Postgres. Only the outside world is mocked: Amphora's listing,
// Shopify's reads, and Postmark's answer.

const pg = new PGlite();
const db = drizzle(pg, { schema });
vi.mock("@/db/drizzle", () => ({ default: db }));

const DAY = 86_400_000;

// #312246's shape: an exchange of two crewnecks, one sent back.
const ORDER_ID = "13411730325830";
const order = (over: { refunded?: boolean[] } = {}) => ({
  id: ORDER_ID,
  orderNumber: "#312246",
  email: "miguel@example.com",
  products: [
    { id: "l1", variant_id: "v1", quantity: 1, confirmed: true, refunded: over.refunded?.[0] ?? false,
      return_id: "gid://shopify/Return/1" },
    { id: "l2", variant_id: "v2", quantity: 1, confirmed: true, refunded: over.refunded?.[1] ?? false,
      return_id: "gid://shopify/Return/1" },
  ],
});
const amphora = (received: { a: string; b: string }, over: Record<string, unknown> = {}) => ({
  id: `SHP ${ORDER_ID}`,
  external_id: ORDER_ID,
  name: "#312246",
  internal_status: "RECEIVED",
  time_received: "2026-10-17T09:00:00",
  time_processed: "2026-10-17T09:05:00",
  items: [
    { sku: "20240800", quantity: "1", quantity_received: received.a },
    { sku: "20252901", quantity: "1", quantity_received: received.b },
  ],
  ...over,
});

const world = {
  returns: [] as any[],
  orders: [] as any[],
  shopify: { "gid://shopify/Return/1": "OPEN" } as Record<string, string>,
  postmarkOk: true,
};
const sent: string[] = [];

vi.mock("@/actions/amphora", () => ({ getAmphoraReturns: async () => world.returns }));
vi.mock("@/db/queries", () => ({
  getOrdersWithUnsettledReturns: async () =>
    world.orders.filter((o) => o.products.some((p: any) => !p.refunded)),
  getOrderByIdFresh: async (id: string) => world.orders.find((o) => o.id === id),
  getVariantSkusByIds: async () => ({ v1: "20240800", v2: "20252901" }),
  getReturnStatusesByIds: async () => world.shopify,
}));
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async () => {},
  sendOpsAlert: async (subject: string) => {
    if (!world.postmarkOk) return { ok: false, error: "Postmark 500" };
    sent.push(subject);
    return { ok: true };
  },
}));

const sweep = async (now = new Date()) =>
  (await import("@/actions/receiptShortfallSweep")).sweepReceiptShortfalls(now);
const dispatch = async () => (await import("@/actions/opsAlertOutbox")).dispatchOpsAlerts();
/** Let the outbox lease expire so the dispatcher may retry a failed row. */
const expireLeases = () =>
  pg.exec(`UPDATE ops_alerts SET last_attempt_at = now() - interval '1 hour'`);
const cases = async () =>
  (await pg.query<any>("SELECT * FROM receipt_shortfalls ORDER BY sku")).rows;

beforeAll(async () => {
  for (const f of ["drizzle/0004_ops_alerts.sql", "drizzle/0005_receipt_shortfalls.sql"]) {
    const ddl = readFileSync(f, "utf8");
    await pg.exec(ddl);
    await pg.exec(ddl); // applied by hand: must be re-runnable
  }
});

beforeEach(async () => {
  await pg.exec("DELETE FROM receipt_shortfalls; DELETE FROM ops_alerts;");
  world.returns = [amphora({ a: "0", b: "1" })];
  world.orders = [order()];
  world.shopify = { "gid://shopify/Return/1": "OPEN" };
  world.postmarkOk = true;
  sent.length = 0;
});

describe("receipt-shortfall sweep", () => {
  it("opens one case per short SKU and alerts ops once", async () => {
    await sweep();
    await sweep(); // a second run re-detects; still one case, one alert
    await dispatch();

    const rows = await cases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amphora_return_id: `SHP ${ORDER_ID}`, sku: "20240800", declared_qty: 1, received_qty: 0,
      shopify_return_ids: ["gid://shopify/Return/1"],
    });
    expect(sent).toEqual(["[returns] SHORT RECEIPT — #312246 (20240800)"]);

    await sweep(); // sees the acceptance
    expect((await cases())[0].alert_stage).toBe(1);
    expect((await cases())[0].first_alert_accepted_at).not.toBeNull();
  });

  it("Postmark 500: stage stays 0, and the alert goes out on a later run", async () => {
    world.postmarkOk = false;
    await sweep();
    await dispatch();
    await sweep();

    expect((await cases())[0].alert_stage).toBe(0);
    expect(sent).toEqual([]);

    world.postmarkOk = true;
    await expireLeases();
    await dispatch();
    await sweep();

    expect(sent).toHaveLength(1);
    expect((await cases())[0].alert_stage).toBe(1);
  });

  it("resolves on a corrected count and sends nothing for it", async () => {
    await sweep();
    await dispatch();
    sent.length = 0;

    world.returns = [amphora({ a: "1", b: "1" })];
    const report = await sweep();
    await dispatch();

    expect(report.resolved).toBe(1);
    expect((await cases())[0].resolved_at).not.toBeNull();
    expect(sent).toEqual([]);
  });

  it("escalates once after 7 days unresolved, and never again", async () => {
    await sweep();
    await dispatch();
    await sweep(); // stage 1, anchor set

    const later = new Date(Date.now() + 8 * DAY);
    await sweep(later);
    await dispatch();
    await sweep(later);
    await sweep(new Date(Date.now() + 30 * DAY));
    await dispatch();

    expect(sent).toEqual([
      "[returns] SHORT RECEIPT — #312246 (20240800)",
      "[returns] SHORT RECEIPT UNRESOLVED 7 DAYS — #312246 (20240800)",
    ]);
    expect((await cases())[0].alert_stage).toBe(2);
  });

  it("does not escalate before 7 days", async () => {
    await sweep();
    await dispatch();
    await sweep();

    await sweep(new Date(Date.now() + 6 * DAY));
    await dispatch();

    expect(sent).toHaveLength(1);
  });

  it("reopens a shortage that comes back, with a fresh alert and clock", async () => {
    await sweep();
    await dispatch();
    await sweep();
    world.returns = [amphora({ a: "1", b: "1" })];
    await sweep(); // resolved
    world.returns = [amphora({ a: "0", b: "1" })];
    await sweep(); // short again
    await dispatch();

    const [row] = await cases();
    expect(row).toMatchObject({ resolved_at: null, alert_stage: 0, reopen_count: 1 });
    expect(row.first_alert_accepted_at).toBeNull();
    expect(sent).toHaveLength(2);
  });

  it("never opens a case before Amphora has finished counting", async () => {
    world.returns = [amphora({ a: "0", b: "0" }, { time_processed: null })];

    const report = await sweep();

    expect(report.unknown).toBe(1);
    expect(await cases()).toEqual([]);
  });

  it("does not resolve an open case on `unknown` or on absence", async () => {
    await sweep();

    // The count is not readable now, then the Amphora record vanishes.
    world.returns = [amphora({ a: "n/a", b: "1" })];
    await sweep();
    world.returns = [];
    await sweep();

    expect((await cases())[0].resolved_at).toBeNull();
  });

  it("resolves when every line is settled, though the order left the candidate query", async () => {
    await sweep();
    world.orders = [order({ refunded: [true, true] })];

    await sweep();

    expect((await cases())[0].resolved_at).not.toBeNull();
  });

  it("resolves when every Shopify return still owed is closed", async () => {
    await sweep();
    world.shopify = { "gid://shopify/Return/1": "CLOSED" };

    await sweep();

    expect((await cases())[0].resolved_at).not.toBeNull();
  });

  it("never opens a case for a conflicted Amphora record", async () => {
    world.returns = [amphora({ a: "0", b: "1" }), amphora({ a: "0", b: "1" }, { external_id: null })];

    await sweep();

    expect(await cases()).toEqual([]);
  });
});
