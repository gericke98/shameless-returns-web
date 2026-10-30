import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import { buildAgreement } from "@/lib/agreement";
import type { ValuedLine } from "@/lib/basket";

// The submission guarantees live in SQL: one awaiting submission per order,
// conditional transitions, the confirm write by row id. These run the REAL
// db/submissions.ts against the REAL migration in an in-process Postgres.

const pg = new PGlite();
const db = drizzle(pg, { schema });
vi.mock("@/db/drizzle", () => ({ default: db }));

const repo = () => import("@/db/submissions");

const line = (id: number, action: "DEVOLUCIÓN" | "CAMBIO", cents: number, repl = 0): ValuedLine => ({
  id,
  action,
  quantity: 1,
  returnedCents: cents,
  replacementCents: repl,
  degraded: false,
});
const meta = (id: number, newVariantId: string | null = null) => ({
  productsorderId: id,
  shopifyLineItemId: `li-${id}`,
  fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${id}`,
  newVariantId,
  reason: "size",
  notes: null,
});
const agreementFor = (lines: ValuedLine[]) =>
  buildAgreement({
    lines,
    returnLegCents: 500,
    outboundLegCents: 0,
    feeCents: 500,
    selfBooked: false,
    tender: "refund",
  });

async function propose(orderId: string, lines = [line(1, "DEVOLUCIÓN", 5000)]) {
  const { proposeSubmission } = await repo();
  const result = await proposeSubmission({
    orderId,
    returnMethod: "CORREOS",
    agreement: agreementFor(lines),
    lines: lines.map((l) => meta(l.id, l.action === "CAMBIO" ? "gid://shopify/ProductVariant/9" : null)),
  });
  if (!result.ok) throw new Error("conflict");
  return result.id;
}

const stateOf = async (id: string) =>
  (await pg.query<any>("SELECT state FROM return_submissions WHERE id = $1", [id])).rows[0]?.state;

beforeAll(async () => {
  await pg.exec(`CREATE TABLE productsorder (
    id serial PRIMARY KEY, order_id text, variant_id text, action text, new_variant_id text,
    confirmed boolean, return_id text, return_line_item_id text, transaction_id text,
    transaction_amount text, credit boolean)`);
  const migration = readFileSync("drizzle/0006_return_submissions.sql", "utf8");
  await pg.exec(migration);
  // Applied by hand, so applying it twice must be harmless.
  await pg.exec(migration);
  // 0007 (S2) adds columns db/schema.ts now selects.
  const s2 = readFileSync("drizzle/0007_settlement_operations.sql", "utf8");
  await pg.exec(s2);
  await pg.exec(s2);
});

beforeEach(async () => {
  await pg.exec("DELETE FROM submission_lines; DELETE FROM return_submissions; DELETE FROM productsorder");
});

describe("db/submissions against Postgres", () => {
  it("stores the agreement and its lines, conserving money", async () => {
    const id = await propose("o1", [line(1, "DEVOLUCIÓN", 5000), line(2, "CAMBIO", 10000, 6000)]);

    const s = (await pg.query<any>("SELECT * FROM return_submissions WHERE id=$1", [id])).rows[0];
    const lines = (await pg.query<any>("SELECT * FROM submission_lines ORDER BY productsorder_id")).rows;
    expect(s.state).toBe("awaiting_payment");
    expect(s.owed_cents).toBe(8500);
    expect(lines.map((l: any) => l.pay_cents).reduce((a: number, b: number) => a + b) + s.residual_cents).toBe(8500);
    expect(lines[0].new_variant_id).toBeNull();
    expect(lines[1].new_variant_id).toBe("gid://shopify/ProductVariant/9");
  });

  it("supersedes the earlier awaiting submission of the same order only", async () => {
    const first = await propose("o1");
    const other = await propose("o2");
    const second = await propose("o1");

    expect(await stateOf(first)).toBe("superseded");
    expect(await stateOf(second)).toBe("awaiting_payment");
    expect(await stateOf(other)).toBe("awaiting_payment");
  });

  it("refuses a second awaiting submission at the database, whatever the caller does", async () => {
    await propose("o1");

    await expect(
      pg.query(
        `INSERT INTO return_submissions (order_id, tender, return_method, return_leg_cents,
           outbound_leg_cents, charged_fee_cents, returned_value_cents, replacement_value_cents,
           net_cents, stripe_charge_cents, waived_cents, owed_cents, residual_cents)
         VALUES ('o1','refund','CORREOS',0,0,0,0,0,0,0,0,0,0)`
      )
    ).rejects.toThrow(/one_awaiting/);
  });

  it("accepts a paid submission once, only for its own session and amount", async () => {
    const { attachStripeSession, acceptPaidSubmission } = await repo();
    const id = await propose("o1", [line(1, "CAMBIO", 4000, 6000)]); // owes 25.00
    expect(await attachStripeSession(id, "cs_1")).toBe(true);
    const evidence = { sessionId: "cs_1", amountTotal: 2500, currency: "eur", paymentStatus: "paid", paymentIntent: "pi_1" };

    expect(await acceptPaidSubmission(id, { ...evidence, amountTotal: 2400 })).toMatchObject({ kind: "mismatch" });
    expect(await acceptPaidSubmission(id, { ...evidence, sessionId: "cs_other" })).toMatchObject({ kind: "mismatch" });
    expect(await acceptPaidSubmission(id, { ...evidence, paymentStatus: "unpaid" })).toMatchObject({ kind: "mismatch" });
    expect(await stateOf(id)).toBe("awaiting_payment");

    expect(await acceptPaidSubmission(id, evidence)).toEqual({ kind: "accepted" });
    expect(await acceptPaidSubmission(id, evidence)).toEqual({ kind: "duplicate" });
    expect(await stateOf(id)).toBe("accepted");
  });

  it("does not accept a payment for a superseded submission", async () => {
    const { attachStripeSession, acceptPaidSubmission } = await repo();
    const old = await propose("o1", [line(1, "CAMBIO", 4000, 6000)]);
    await attachStripeSession(old, "cs_old");
    await propose("o1", [line(1, "CAMBIO", 4000, 6000)]);

    const outcome = await acceptPaidSubmission(old, {
      sessionId: "cs_old",
      amountTotal: 2500,
      currency: "eur",
      paymentStatus: "paid",
      paymentIntent: "pi_old",
    });

    expect(outcome).toEqual({ kind: "superseded", state: "superseded" });
  });

  it("accepts a free submission, and never one that owes Stripe", async () => {
    const { acceptFreeSubmission } = await repo();
    const free = await propose("o1");
    const owing = await propose("o2", [line(1, "CAMBIO", 4000, 6000)]);

    expect(await acceptFreeSubmission(free)).toBe(true);
    expect(await acceptFreeSubmission(free)).toBe(false);
    expect(await acceptFreeSubmission(owing)).toBe(false);
  });

  it("abandons only awaiting submissions older than 25 hours", async () => {
    const { abandonExpiredSubmissions } = await repo();
    const fresh = await propose("o1");
    const stale = await propose("o2");
    await pg.query("UPDATE return_submissions SET created_at = now() - interval '26 hours' WHERE id = $1", [stale]);

    expect(await abandonExpiredSubmissions()).toEqual([stale]);
    expect(await stateOf(fresh)).toBe("awaiting_payment");
  });

  it("confirms rows by id from the submission, even after they were edited", async () => {
    const { recordConfirmation } = await repo();
    await pg.exec(`INSERT INTO productsorder (id, order_id, variant_id, action, new_variant_id) VALUES
      (1, 'o1', 'v', 'DEVOLUCIÓN', NULL),
      (2, 'o1', 'v', 'CAMBIO', 'gid://shopify/ProductVariant/9'),
      (3, 'o1', 'v', 'DEVOLUCIÓN', NULL)`);
    const id = await propose("o1", [line(1, "DEVOLUCIÓN", 5000), line(2, "CAMBIO", 4000, 4000)]);
    // After checkout, another tab flips row 2 to a refund. Same variant on all three rows.
    await pg.exec(`UPDATE productsorder SET action='DEVOLUCIÓN', new_variant_id=NULL WHERE id = 2`);

    const written = await recordConfirmation({
      submissionId: id,
      returnId: "gid://shopify/Return/1",
      transactionId: "t1",
      transactionAmount: "90.00",
      credit: false,
      lines: [
        { productsorderId: 1, fulfillmentLineItemId: "fli-1", returnLineItemId: "rli-1" },
        { productsorderId: 2, fulfillmentLineItemId: "fli-2", returnLineItemId: "rli-2" },
      ],
    });

    expect(written.sort()).toEqual([1, 2]);
    const rows = (await pg.query<any>("SELECT * FROM productsorder ORDER BY id")).rows;
    expect(rows[0]).toMatchObject({ confirmed: true, return_line_item_id: "rli-1" });
    expect(rows[1]).toMatchObject({
      confirmed: true,
      return_line_item_id: "rli-2",
      action: "CAMBIO",
      new_variant_id: "gid://shopify/ProductVariant/9",
    });
    expect(rows[2].confirmed).toBeNull();
    const lines = (await pg.query<any>("SELECT return_line_item_id FROM submission_lines ORDER BY productsorder_id")).rows;
    expect(lines.map((l: any) => l.return_line_item_id)).toEqual(["rli-1", "rli-2"]);
  });

  it("stores the fulfillment line item agreed at checkout on every line", async () => {
    await propose("o1", [line(1, "DEVOLUCIÓN", 5000), line(2, "CAMBIO", 4000, 4000)]);

    const lines = (await pg.query<any>(
      "SELECT fulfillment_line_item_id FROM submission_lines ORDER BY productsorder_id"
    )).rows;
    expect(lines.map((l: any) => l.fulfillment_line_item_id)).toEqual([
      "gid://shopify/FulfillmentLineItem/1",
      "gid://shopify/FulfillmentLineItem/2",
    ]);
  });

  it("leaves exactly one awaiting submission when two proposals race", async () => {
    // A double click: two requests, same order, same instant.
    const { proposeSubmission } = await repo();
    const lines = [line(1, "DEVOLUCIÓN", 5000)];
    const input = { orderId: "o1", returnMethod: "CORREOS", agreement: agreementFor(lines), lines: [meta(1)] };

    const results = await Promise.all([proposeSubmission(input), proposeSubmission(input)]);

    const awaiting = (await pg.query<any>(
      "SELECT id FROM return_submissions WHERE order_id='o1' AND state='awaiting_payment'"
    )).rows;
    expect(awaiting).toHaveLength(1);
    // Whichever lost was either superseded or refused — never left awaiting.
    expect(results.filter((r) => r.ok && r.id === awaiting[0].id)).toHaveLength(1);
  });

  it("clears a stale credit flag when the submission is a refund", async () => {
    // A credit return was cancelled; the same row is now returned for a refund.
    // Leaving credit=true would settle it as store credit again.
    const { recordConfirmation } = await repo();
    await pg.exec(`INSERT INTO productsorder (id, order_id, variant_id, action, credit)
      VALUES (1, 'o1', 'v', 'DEVOLUCIÓN', true)`);
    const id = await propose("o1");

    await recordConfirmation({
      submissionId: id,
      returnId: "gid://shopify/Return/1",
      transactionId: "t1",
      transactionAmount: "50.00",
      credit: false,
      lines: [{ productsorderId: 1, fulfillmentLineItemId: "fli-1", returnLineItemId: "rli-1" }],
    });

    expect((await pg.query<any>("SELECT credit FROM productsorder WHERE id = 1")).rows[0].credit).toBe(false);
  });
});
