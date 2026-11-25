import { beforeEach, describe, expect, it, vi } from "vitest";

// `settleRow` (was `validateReturn`) is a "use server" action: an independently addressable
// HTTP endpoint that `middleware.ts` does not cover. It settles money, so it
// must be unreachable without an admin session (kept IN ADDITION to the
// ledger's ownership, S2 plan L7), and nothing the caller sends may decide
// what is paid: only the clicked row's id is read, and settlement executes the
// submission that row belongs to.

const session = { value: null as unknown };
vi.mock("next-auth", () => ({ getServerSession: async () => session.value }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/server/orderScope", () => ({ orderScope: () => ({}) }));
// The handler reads which order the clicked row belongs to (F1 §10).
const ROW_ORDER: Record<number, string> = { 7: "1" };
vi.mock("@/db/drizzle", () => {
  let wanted: number | undefined;
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: (cond: any) => {
      // eq(productsOrder.id, n): the bound value is the clicked row id.
      wanted = cond?.queryChunks?.find((c: any) => typeof c?.value === "number")?.value;
      return Promise.resolve(ROW_ORDER[wanted!] ? [{ orderId: ROW_ORDER[wanted!] }] : []);
    },
  };
  return { default: chain };
});
vi.mock("@/lib/server/opsAlertOutbox", () => ({ enqueueOpsAlert: async () => true }));

const calls = { lookup: [] as number[], orders: [] as string[], settle: [] as Array<[string, number[]]> };
const lookup = { value: { ok: true, submissionId: "sub-1" } as any };

vi.mock("@/lib/settlement/legacy", () => ({
  submissionForRow: async (orderId: string, id: number) => {
    calls.lookup.push(id);
    calls.orders.push(String(orderId));
    return lookup.value;
  },
}));
vi.mock("@/lib/settlement/settle", () => ({
  settleSubmission: async (submissionId: string, ids: number[]) => {
    calls.settle.push([submissionId, ids]);
    return { submissionId, lines: ids.map((id) => ({ productsorderId: id, status: "paid" })) };
  },
}));

const product = { id: 7, variant_id: "v1", price: "9999.00", credit: true, return_id: "r-evil" };

// The client sends only the row id now (F1 §4); anything else is refused by
// the `.strict()` schema before the handler runs.
async function click(p: any = product) {
  const { settleRow } = await import("@/actions/refund");
  return settleRow({ rowId: p.id } as any);
}

beforeEach(() => {
  calls.lookup.length = 0;
  calls.orders.length = 0;
  calls.settle.length = 0;
  session.value = null;
  lookup.value = { ok: true, submissionId: "sub-1" };
  vi.resetModules();
});

describe("validateReturn authorization", () => {
  it("settles nothing for an unauthenticated caller", async () => {
    expect(await click()).toEqual({ ok: false, reason: "not-admin" });
    expect(calls.lookup).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it("settles nothing for a signed-in non-admin", async () => {
    session.value = { user: { role: "user" } };
    expect(await click()).toEqual({ ok: false, reason: "not-admin" });
    expect(calls.settle).toHaveLength(0);
  });

  it("proceeds for an admin session", async () => {
    session.value = { user: { role: "admin" } };
    await click();
    expect(calls.settle).toEqual([["sub-1", [7]]]);
  });
});

describe("validateReturn does not trust caller-supplied money", () => {
  it("passes settlement the row id and nothing else the caller sent", async () => {
    session.value = { user: { role: "admin" } };
    await click();
    expect(calls.lookup).toEqual([7]);
    // …under the order that row belongs to, read from our database.
    expect(calls.orders).toEqual(["1"]);
    // No price, credit flag, return id or order object crosses into settlement.
    expect(JSON.stringify(calls.settle)).not.toContain("9999");
    expect(JSON.stringify(calls.settle)).not.toContain("r-evil");
  });

  it("pays nothing for a row id that is not a positive integer", async () => {
    session.value = { user: { role: "admin" } };
    expect(await click({ ...product, id: "7; DROP TABLE" })).toEqual({ ok: false, reason: "invalid-input" });
    expect(await click({ ...product, id: -1 })).toEqual({ ok: false, reason: "invalid-input" });
    expect(calls.lookup).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it("pays nothing for a line no submission can be found or recorded for", async () => {
    // A missing row, an unconfirmed one, or one already refunded: the lookup
    // holds it, and settlement is never started.
    session.value = { user: { role: "admin" } };
    lookup.value = { ok: false, held: "already-refunded" };
    expect(await click()).toEqual({ ok: false, reason: "not-settleable" });
    expect(calls.settle).toHaveLength(0);
  });
});

describe("settleRow's input is the row id alone", () => {
  it("refuses any other field the caller adds", async () => {
    session.value = { user: { role: "admin" } };
    const { settleRow } = await import("@/actions/refund");
    expect(await settleRow({ rowId: 7, price: "9999.00" } as any)).toEqual({ ok: false, reason: "invalid-input" });
    expect(calls.settle).toHaveLength(0);
  });
});
