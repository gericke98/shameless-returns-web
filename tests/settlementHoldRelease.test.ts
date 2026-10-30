import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";
import { seedSubmission } from "./support/settlementSeed";
import { line } from "./support/planFixtures";

// Finding 9: a cancellation or a reverted confirmation releases a stock hold
// through the ONE draftOrderDelete in lib/settlement/effects.ts (2026-04,
// the ledger's transport), and only with authority the database proves.
// Real SQL in PGlite; Shopify mocked at the transport.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: (s: any) => env.transact(s) }));

const answers: Record<string, (variables: any) => any> = {};
const sent: Array<{ name: string; query: string; variables: any }> = [];
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return {
    ...actual,
    shopifyGraphQL: async (query: string, variables: any) => {
      const name = /(?:query|mutation) (\w+)/.exec(query)![1];
      sent.push({ name, query, variables });
      const answer = answers[name];
      return answer ? { kind: "answer", body: answer(variables) } : { kind: "no-answer", error: "timeout" };
    },
  };
});

const D = "gid://shopify/DraftOrder/5";
const V = "gid://shopify/ProductVariant/11";
const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const pointer = async () => (await q("SELECT exchange_reservation_id FROM orders WHERE id='100'"))[0].exchange_reservation_id;
const hold = () => import("@/lib/settlement/holdRelease");

async function exchangeHeldBy(holder: string | null) {
  const seeded = await seedSubmission(env.pg, { lines: [line(1, { action: "CAMBIO", newVariantId: V, payCents: 0 })] });
  await env.pg.query("UPDATE return_submissions SET holder=$1 WHERE id=$2", [holder, seeded.id]);
  await env.pg.query("UPDATE orders SET exchange_reservation_id=$1 WHERE id='100'", [D]);
  return seeded;
}

beforeAll(() => env.ready);
beforeEach(async () => {
  await env.reset();
  for (const k of Object.keys(answers)) delete answers[k];
  sent.length = 0;
});

describe("releaseHoldForCancellation", () => {
  it("deletes the draft through the ledger's own document and clears the pointer", async () => {
    const seeded = await exchangeHeldBy("cancellation");
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: D, userErrors: [] } } });
    expect(await (await hold()).releaseHoldForCancellation("100", [seeded.id])).toEqual({ released: true });
    const { DRAFT_ORDER_DELETE } = await import("@/lib/settlement/effects");
    expect(sent.map((s) => s.query)).toEqual([DRAFT_ORDER_DELETE]);
    expect(sent[0].variables).toEqual({ input: { id: D } });
    expect(await pointer()).toBeNull();
  });

  it("reports released with nothing sent when there is no hold", async () => {
    const seeded = await exchangeHeldBy("cancellation");
    await env.pg.query("UPDATE orders SET exchange_reservation_id=NULL");
    expect(await (await hold()).releaseHoldForCancellation("100", [seeded.id])).toEqual({ released: true });
    expect(sent).toEqual([]);
  });

  it("KEEPS the pointer when the delete is refused and the draft still exists", async () => {
    const seeded = await exchangeHeldBy("cancellation");
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: null, userErrors: [{ message: "no" }] } } });
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: { id: D } } });
    expect((await (await hold()).releaseHoldForCancellation("100", [seeded.id])).released).toBe(false);
    expect(await pointer()).toBe(D);
  });

  it("treats a refusal for a draft that is already gone as released", async () => {
    const seeded = await exchangeHeldBy("cancellation");
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: null, userErrors: [{ message: "gone" }] } } });
    answers.SettlementDraftOrder = () => ({ data: { draftOrder: null } });
    expect(await (await hold()).releaseHoldForCancellation("100", [seeded.id])).toEqual({ released: true });
    expect(await pointer()).toBeNull();
  });

  it("sends nothing for a submission cancellation does not hold", async () => {
    const seeded = await exchangeHeldBy("settlement");
    expect((await (await hold()).releaseHoldForCancellation("100", [seeded.id])).released).toBe(false);
    expect(sent).toEqual([]);
    expect(await pointer()).toBe(D);
  });

  it("sends nothing when ANOTHER accepted submission on the order still owns an exchange", async () => {
    const mine = await exchangeHeldBy("cancellation");
    const other = await seedSubmission(env.pg, { lines: [line(2, { action: "CAMBIO", newVariantId: V, payCents: 0 })] });
    expect(other.id).not.toBe(mine.id);
    expect((await (await hold()).releaseHoldForCancellation("100", [mine.id])).released).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("releaseHoldForRevert", () => {
  it("sends nothing while the order still carries a live Shopify return", async () => {
    await exchangeHeldBy(null); // seeded rows are confirmed with a return id
    expect((await (await hold()).releaseHoldForRevert("100")).released).toBe(false);
    expect(sent).toEqual([]);
  });

  it("releases once no live return and no settlement exchange owns the hold", async () => {
    await exchangeHeldBy(null);
    await env.pg.query("UPDATE productsorder SET confirmed=false, return_id=NULL");
    answers.SettlementDraftOrderDelete = () => ({ data: { draftOrderDelete: { deletedId: D, userErrors: [] } } });
    expect(await (await hold()).releaseHoldForRevert("100")).toEqual({ released: true });
    expect(await pointer()).toBeNull();
  });

  it("sends nothing while settlement is still executing an exchange on the order", async () => {
    const seeded = await exchangeHeldBy(null);
    await env.pg.query("UPDATE productsorder SET confirmed=false, return_id=NULL");
    await env.pg.query(
      `INSERT INTO settlement_operations (id, submission_id, kind, scope_key, request)
       VALUES ($1, $2, 'exchange_order', $3, '{}'::jsonb)`,
      [randomUUID(), seeded.id, `exchange:${seeded.id}`]
    );
    expect((await (await hold()).releaseHoldForRevert("100")).released).toBe(false);
    expect(sent).toEqual([]);
  });
});
