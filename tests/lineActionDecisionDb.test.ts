import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";

// S3 D3 = A: a NULL action is set only by an explicit, recorded decision —
// the change and its reason in one statement — and never under a line that a
// submission or an operation already covers.

const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: (s: any) => env.transact(s) }));
const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;

async function seed(id: number, action: string | null = null) {
  await q(`INSERT INTO orders (id, order_number) VALUES ('100', '#100') ON CONFLICT DO NOTHING`);
  await q(
    `INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id, price,
       quantity, changed, action, confirmed, return_id, return_line_item_id)
     VALUES ($1, '100', 'li', 'p', 't', 'M', 'v', '50.00', 1, false, $2, true, 'gid://shopify/Return/1', 'rli')`,
    [id, action]
  );
}
const decide = async (over: any = {}) => {
  const { decideLineAction } = await import("@/lib/settlement/lineAction");
  return decideLineAction({ productsorderId: 1, action: "DEVOLUCIÓN", newVariantId: null, by: "santi", evidence: "email 2026-09-01", ...over });
};

beforeAll(() => env.ready);
beforeEach(() => env.reset());

describe("set-line-action (D3)", () => {
  it("sets the action and records who and why, together", async () => {
    await seed(1);
    expect(await decide()).toEqual({ ok: true });
    expect((await q(`SELECT action FROM productsorder WHERE id=1`))[0].action).toBe("DEVOLUCIÓN");
    expect(await q(`SELECT productsorder_id, action, decided_by, evidence FROM line_action_decisions`)).toEqual([
      { productsorder_id: 1, action: "DEVOLUCIÓN", decided_by: "santi", evidence: "email 2026-09-01" },
    ]);
  });

  it("CAMBIO stores the new variant as a gid", async () => {
    await seed(1);
    expect(await decide({ action: "CAMBIO", newVariantId: "42" })).toEqual({ ok: true });
    expect((await q(`SELECT new_variant_id FROM productsorder WHERE id=1`))[0].new_variant_id).toBe("gid://shopify/ProductVariant/42");
  });

  it("never overwrites an action that is already set; writes no decision", async () => {
    await seed(1, "CAMBIO");
    expect((await decide()).ok).toBe(false);
    expect((await q(`SELECT action FROM productsorder WHERE id=1`))[0].action).toBe("CAMBIO");
    expect(await q(`SELECT * FROM line_action_decisions`)).toEqual([]);
  });

  it("refuses a line an operation already covers", async () => {
    await seed(1);
    await q(`INSERT INTO return_submissions (id, order_id, state, tender, return_method, return_leg_cents,
       outbound_leg_cents, charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
       stripe_charge_cents, waived_cents, owed_cents, residual_cents)
       VALUES ('11111111-1111-1111-1111-111111111111','100','reconciled','refund','X',0,0,0,0,0,0,0,0,0,0)`);
    await q(`INSERT INTO settlement_operations (id, submission_id, kind, scope_key, members, request, state)
       VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','process_refund','k','{1}','{}','unresolved')`);
    expect((await decide()).ok).toBe(false);
  });

  it("requires evidence and a variant for CAMBIO", async () => {
    await seed(1);
    expect((await decide({ evidence: " " })).ok).toBe(false);
    expect((await decide({ action: "CAMBIO", newVariantId: null })).ok).toBe(false);
  });
});
