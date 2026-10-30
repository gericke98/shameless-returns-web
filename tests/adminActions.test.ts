import { beforeEach, describe, expect, it, vi } from "vitest";

// `validateReturn` is a "use server" action: an independently addressable
// HTTP endpoint that `middleware.ts` does not cover. It settles money, so it
// must be unreachable without an admin session (kept IN ADDITION to the
// ledger's ownership, S2 plan L7), and nothing the caller sends may decide
// what is paid: only the clicked row's id is read, and settlement executes the
// submission that row belongs to.

const session = { value: null as unknown };
vi.mock("next-auth", () => ({ getServerSession: async () => session.value }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const calls = { lookup: [] as number[], settle: [] as Array<[string, number[]]> };
const lookup = { value: { ok: true, submissionId: "sub-1" } as any };

vi.mock("@/lib/settlement/legacy", () => ({
  submissionForRow: async (id: number) => {
    calls.lookup.push(id);
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

async function click(p: any = product) {
  const { validateReturn } = await import("@/actions/refund");
  await validateReturn(p, "any", { id: "1", total: "9999" });
}

beforeEach(() => {
  calls.lookup.length = 0;
  calls.settle.length = 0;
  session.value = null;
  lookup.value = { ok: true, submissionId: "sub-1" };
  vi.resetModules();
});

describe("validateReturn authorization", () => {
  it("settles nothing for an unauthenticated caller", async () => {
    await click();
    expect(calls.lookup).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it("settles nothing for a signed-in non-admin", async () => {
    session.value = { user: { role: "user" } };
    await click();
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
    // No price, credit flag, return id or order object crosses into settlement.
    expect(JSON.stringify(calls.settle)).not.toContain("9999");
    expect(JSON.stringify(calls.settle)).not.toContain("r-evil");
  });

  it("pays nothing for a row id that is not a positive integer", async () => {
    session.value = { user: { role: "admin" } };
    await click({ ...product, id: "7; DROP TABLE" });
    await click({ ...product, id: -1 });
    expect(calls.lookup).toHaveLength(0);
    expect(calls.settle).toHaveLength(0);
  });

  it("pays nothing for a line no submission can be found or recorded for", async () => {
    // A missing row, an unconfirmed one, or one already refunded: the lookup
    // holds it, and settlement is never started.
    session.value = { user: { role: "admin" } };
    lookup.value = { ok: false, held: "already-refunded" };
    await click();
    expect(calls.settle).toHaveLength(0);
  });
});
