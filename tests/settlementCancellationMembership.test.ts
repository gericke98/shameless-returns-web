import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";
import { seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";

// Finding 3: a cancellation first establishes its COMPLETE membership — every
// confirmed, unsettled row mapped to a submission — and each submission's own
// Shopify return and own payment, by submission identity. Anything it cannot
// attribute refuses the cancel before a single external effect, and claims
// nothing. Real SQL in PGlite; Shopify mocked at the transport (no answer).

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: (s: any) => env.transact(s) }));
vi.mock("@/lib/settlement/shopify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlement/shopify")>()),
  shopifyGraphQL: async () => ({ kind: "no-answer", error: "timeout" }),
}));

const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const rowsOfOrder = async () =>
  q("SELECT id, confirmed, refunded, return_line_item_id FROM productsorder WHERE order_id='100' ORDER BY id");
const claim = async () => (await import("@/lib/submissionCancellation")).claimOrderForCancellation(await rowsOfOrder());
/** A paid submission: the card covered `cents` the garments did not. */
const paid = (id: string, cents: number, intent: string | null) =>
  env.pg.query(
    `UPDATE return_submissions SET replacement_value_cents = returned_value_cents + $2, net_cents = -$2,
       stripe_charge_cents = $2, stripe_payment_intent = $3 WHERE id = $1`,
    [id, cents, intent]
  );
const holders = async () => (await q("SELECT holder FROM return_submissions ORDER BY id")).map((r) => r.holder);

beforeAll(() => env.ready);
beforeEach(() => env.reset());

describe("claimOrderForCancellation", () => {
  it("names each submission's own Shopify return and own PaymentIntent", async () => {
    const a = await seedSubmission(env.pg, { lines: [line(1)] });
    const b = await seedSubmission(env.pg, { lines: [line(2)] });
    await env.pg.query("UPDATE productsorder SET return_id='gid://shopify/Return/2' WHERE id=2");
    await paid(a.id, 500, "pi_a");
    await paid(b.id, 700, "pi_b");
    const result = await claim();
    expect(result.ok).toBe(true);
    const members = (result as any).members.sort((x: any, y: any) => x.returnId.localeCompare(y.returnId));
    expect(members).toEqual([
      { submissionId: a.id, returnId: "gid://shopify/Return/1", payment: { kind: "intent", paymentIntent: "pi_a" } },
      { submissionId: b.id, returnId: "gid://shopify/Return/2", payment: { kind: "intent", paymentIntent: "pi_b" } },
    ]);
    expect(await holders()).toEqual(["cancellation", "cancellation"]);
  });

  it("a free submission has no payment to reverse", async () => {
    const a = await seedSubmission(env.pg);
    expect(await claim()).toEqual({
      ok: true,
      members: [{ submissionId: a.id, returnId: "gid://shopify/Return/1", payment: { kind: "none" } }],
    });
  });

  it("refuses — claiming nothing — when a confirmed row carries no return line item", async () => {
    await seedSubmission(env.pg, { lines: [line(1)] });
    await env.pg.query(
      `INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id, price,
         quantity, changed, action, confirmed) VALUES (9, '100', 'li', 'p', 't', 'M', 'v', '10.00', 1, false, 'DEVOLUCIÓN', true)`
    );
    expect(await claim()).toMatchObject({ ok: false, reason: "needs-support" });
    expect(await holders()).toEqual([null]);
  });

  it("refuses — claiming nothing — when a confirmed row belongs to no submission it can record", async () => {
    await seedSubmission(env.pg, { lines: [line(1)] });
    // Row 2 is on a live return but in no submission; recording a legacy one
    // needs Shopify, which does not answer.
    await env.pg.query(
      `INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id, price,
         quantity, changed, action, confirmed, return_id, return_line_item_id)
       VALUES (2, '100', 'li', 'p', 't', 'M', 'v', '10.00', 1, false, 'DEVOLUCIÓN', true,
               'gid://shopify/Return/9', 'gid://shopify/ReturnLineItem/2')`
    );
    expect(await claim()).toMatchObject({ ok: false, reason: "needs-support" });
    expect(await holders()).toEqual([null]);
  });

  it("refuses a paid submission that stores no PaymentIntent of its own", async () => {
    const a = await seedSubmission(env.pg);
    await paid(a.id, 500, null);
    expect(await claim()).toMatchObject({ ok: false, reason: "needs-support" });
    expect(await holders()).toEqual([null]);
  });

  it("refuses a legacy submission cancelled together with another: its payment cannot be attributed", async () => {
    const a = await seedSubmission(env.pg, { lines: [line(1)] });
    await seedSubmission(env.pg, { lines: [line(2)] });
    await env.pg.query("UPDATE return_submissions SET provenance='legacy' WHERE id=$1", [a.id]);
    expect(await claim()).toMatchObject({ ok: false, reason: "needs-support" });
    expect(await holders()).toEqual([null, null]);
  });

  it("a lone legacy submission is refunded from the order's payment", async () => {
    const a = await seedSubmission(env.pg);
    await env.pg.query("UPDATE return_submissions SET provenance='legacy' WHERE id=$1", [a.id]);
    expect(await claim()).toMatchObject({ ok: true, members: [{ submissionId: a.id, payment: { kind: "order-payment" } }] });
  });
});
