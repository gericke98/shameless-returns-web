import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sys } from "./support/verified";
import { settlementDatabase } from "./support/settlementDb";
import { configureShopify } from "./support/serviceEnv";

// Settlement refuses before the claim without Shopify keys (F2a).
configureShopify();

// FX §#8: the stock-hold drafts placed before FX are released by ONE
// migration authority, from the orders' persisted pointers, through the ONE
// draftOrderDelete in lib/settlement/effects.ts. Every draft is read first;
// every outcome is recorded with its conditional pointer clear in one
// statement. Real SQL in PGlite; Shopify mocked at the transport.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", async () => (await import("./support/drizzleMock")).drizzleModule(await (() => ({ default: env.db, transact: (s: any) => env.transact(s), readQuery: (s: any) => env.readQuery(s) }))()));

/** Draft id → what Shopify holds now (null = gone; "unreadable" = the read fails). */
const drafts: Record<string, any> = {};
const sent: Array<{ name: string; query: string; variables: any }> = [];
/** Draft ids whose delete Shopify ignores (it still exists after). */
const stubborn = new Set<string>();
/** Something that happens in our database while Shopify deletes a draft. */
const duringDelete: Record<string, () => Promise<unknown>> = {};
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return {
    ...actual,
    shopifyGraphQL: async (query: string, variables: any) => {
      const name = /(?:query|mutation) (\w+)/.exec(query)![1];
      sent.push({ name, query, variables });
      if (name === "SettlementHoldDraft") {
        const now = drafts[variables.id];
        if (now === "unreadable") return { kind: "no-answer", error: "timeout" };
        return { kind: "answer", body: { data: { draftOrder: now ?? null } } };
      }
      if (name === "SettlementDraftOrderDelete") {
        const id = variables.input.id;
        await duringDelete[id]?.();
        if (stubborn.has(id)) return { kind: "answer", body: { data: { draftOrderDelete: { deletedId: null, userErrors: [{ message: "no" }] } } } };
        drafts[id] = null;
        return { kind: "answer", body: { data: { draftOrderDelete: { deletedId: id, userErrors: [] } } } };
      }
      return { kind: "no-answer", error: "unexpected" };
    },
  };
});

const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const D = (n: number) => `gid://shopify/DraftOrder/${n}`;
const open = (n: number) => ({ id: D(n), status: "OPEN", order: null });
const migrate = async (write: boolean) =>
  (await import("@/lib/settlement/holdRelease")).releaseHoldDraftsForMigration(sys, { write, by: "santi" });
const pointers = async () =>
  Object.fromEntries((await q(`SELECT id, exchange_reservation_id FROM orders ORDER BY id`)).map((r) => [r.id, r.exchange_reservation_id]));

beforeAll(() => env.ready);
beforeEach(async () => {
  await env.reset();
  for (const k of Object.keys(drafts)) delete drafts[k];
  stubborn.clear();
  for (const k of Object.keys(duringDelete)) delete duringDelete[k];
  sent.length = 0;
  // One order per outcome, each pointing at its own draft; one order with none.
  await q(`INSERT INTO orders (id, order_number, exchange_reservation_id) VALUES
    ('1', '#1', '${D(1)}'), ('2', '#2', '${D(2)}'), ('3', '#3', '${D(3)}'),
    ('4', '#4', '${D(4)}'), ('5', '#5', '${D(5)}'), ('6', '#6', '${D(6)}'), ('7', '#7', NULL)`);
  drafts[D(1)] = open(1); // deleted
  drafts[D(2)] = null; // already-gone
  drafts[D(3)] = { id: D(3), status: "COMPLETED", order: { id: "gid://shopify/Order/9" } }; // completed
  drafts[D(4)] = open(4); // still-exists
  stubborn.add(D(4));
  drafts[D(5)] = "unreadable";
  drafts[D(6)] = { id: D(6), status: "OPEN", order: { id: "gid://shopify/Order/8" } }; // became an order: completed
});

describe("releaseHoldDraftsForMigration", () => {
  it("dry run: reads every pointed draft, deletes and records nothing", async () => {
    const out = await migrate(false);
    expect(out.releases.map((r) => [r.orderId, r.outcome])).toEqual([
      ["1", "would-delete"],
      ["2", "already-gone"],
      ["3", "completed"],
      ["4", "would-delete"],
      ["5", "unreadable"],
      ["6", "completed"],
    ]);
    expect(sent.filter((s) => s.name === "SettlementDraftOrderDelete")).toEqual([]);
    expect(await q(`SELECT * FROM hold_draft_releases`)).toEqual([]);
    expect(out.remainingPointers).toBe(6);
  });

  it("write: each outcome recorded; the pointer cleared only for a draft that is gone", async () => {
    const out = await migrate(true);
    expect(out.releases.map((r) => [r.orderId, r.outcome, r.pointerCleared])).toEqual([
      ["1", "deleted", true],
      ["2", "already-gone", true],
      ["3", "completed", false],
      ["4", "still-exists", false],
      ["5", "unreadable", false],
      ["6", "completed", false],
    ]);
    const { DRAFT_ORDER_DELETE } = await import("@/lib/settlement/effects");
    const deletes = sent.filter((s) => s.name === "SettlementDraftOrderDelete");
    // Only open drafts are deleted, through the ledger's own document; never a completed one.
    expect(deletes.map((s) => s.variables.input.id)).toEqual([D(1), D(4)]);
    expect(deletes.every((s) => s.query === DRAFT_ORDER_DELETE)).toBe(true);
    expect(await pointers()).toEqual({ "1": null, "2": null, "3": D(3), "4": D(4), "5": D(5), "6": D(6), "7": null });
    const rows = await q(`SELECT order_id, outcome, pointer_cleared, released_by FROM hold_draft_releases ORDER BY order_id`);
    expect(rows).toEqual([
      { order_id: "1", outcome: "deleted", pointer_cleared: true, released_by: "santi" },
      { order_id: "2", outcome: "already-gone", pointer_cleared: true, released_by: "santi" },
      { order_id: "3", outcome: "completed", pointer_cleared: false, released_by: "santi" },
      { order_id: "4", outcome: "still-exists", pointer_cleared: false, released_by: "santi" },
      { order_id: "5", outcome: "unreadable", pointer_cleared: false, released_by: "santi" },
      { order_id: "6", outcome: "completed", pointer_cleared: false, released_by: "santi" },
    ]);
    expect(out.remainingPointers).toBe(4);
  });

  it("re-running is idempotent: a released draft is no longer pointed at; a recovered read is released", async () => {
    await migrate(true);
    drafts[D(5)] = open(5);
    sent.length = 0;
    const again = await migrate(true);
    expect(again.releases.map((r) => [r.orderId, r.outcome])).toEqual([
      ["3", "completed"],
      ["4", "still-exists"],
      ["5", "deleted"],
      ["6", "completed"],
    ]);
    expect(sent.filter((s) => s.name === "SettlementDraftOrderDelete").map((s) => s.variables.input.id)).toEqual([D(4), D(5)]);
  });

  it("a crash after the delete reads already-gone next time", async () => {
    drafts[D(1)] = null; // deleted by a run that died before recording
    const out = await migrate(true);
    expect(out.releases.find((r) => r.orderId === "1")).toMatchObject({ outcome: "already-gone", pointerCleared: true });
  });

  it("a pointer that changed meanwhile is reported, never overwritten", async () => {
    duringDelete[D(1)] = () => q(`UPDATE orders SET exchange_reservation_id = '${D(99)}' WHERE id = '1'`);
    const out = await migrate(true);
    expect(out.releases.find((r) => r.orderId === "1")).toMatchObject({ outcome: "deleted", pointerCleared: false });
    expect((await pointers())["1"]).toBe(D(99));
    expect((await q(`SELECT outcome, pointer_cleared FROM hold_draft_releases WHERE order_id='1'`))[0]).toEqual({
      outcome: "deleted",
      pointer_cleared: false,
    });
  });
});
